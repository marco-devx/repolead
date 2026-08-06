import { randomUUID } from 'node:crypto';

import { contentHash } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';

import type { AnalysisBudget } from './evidence';
import { buildModuleEvidencePack, DEFAULT_BUDGET } from './evidence';
import type { TechLeadModel } from './model';
import {
  MODULE_DOSSIER_SCHEMA,
  modulePrompt,
  PROMPT_VERSION,
  REPOSITORY_BRIEF_SCHEMA,
  repositoryPrompt,
  TECH_LEAD_SYSTEM,
} from './prompts';

export interface AnalyzeOptions {
  store: KnowledgeStore;
  snapshotId: string;
  model: TechLeadModel;
  budget?: AnalysisBudget;
  /** Limita el análisis a un módulo por nombre (para pruebas o re-análisis puntual). */
  moduleFilter?: string;
}

export interface AnalyzeResult {
  modulesAnalyzed: number;
  modulesCached: number;
  briefGenerated: boolean;
  briefCached: boolean;
  inputTokens: number;
  outputTokens: number;
}

interface AnalysisRun {
  kind: 'module' | 'repository';
  subjectId: string;
  cacheKey: string;
  startedAt: string;
  inputTokens: number;
  outputTokens: number;
}

function recordRun(store: KnowledgeStore, snapshotId: string, model: string, run: AnalysisRun): void {
  store.db
    .prepare(
      `INSERT OR REPLACE INTO analysis_runs
         (id, snapshot_id, kind, cache_key, model, prompt_version, status, started_at, finished_at,
          input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
    )
    .run(
      `run_${randomUUID()}`,
      snapshotId,
      run.kind,
      run.cacheKey,
      model,
      PROMPT_VERSION,
      run.startedAt,
      new Date().toISOString(),
      run.inputTokens,
      run.outputTokens,
    );
}

/**
 * Analiza un subject (módulo o repo) con caché por contenido: si el evidence
 * pack no cambió desde el último análisis con el mismo prompt y modelo, el
 * summary anterior se copia al snapshot actual sin llamar al modelo.
 */
async function analyzeSubject(
  options: AnalyzeOptions,
  subjectId: string,
  level: 'module' | 'repository',
  packJson: string,
  prompt: string,
  schema: Record<string, unknown>,
): Promise<{ cached: boolean; inputTokens: number; outputTokens: number }> {
  const { store, snapshotId, model } = options;
  const packHash = contentHash(`${packJson}\n${PROMPT_VERSION}\n${model.name}`);

  const cached = store.findCachedSummary(subjectId, level, packHash, PROMPT_VERSION, model.name);
  if (cached) {
    if (cached.snapshotId !== snapshotId) {
      store.insertSummary({ ...cached, id: `sum_${randomUUID()}`, snapshotId });
    }
    return { cached: true, inputTokens: 0, outputTokens: 0 };
  }

  const startedAt = new Date().toISOString();
  const completion = await model.complete({ system: TECH_LEAD_SYSTEM, prompt, schema });

  store.insertSummary({
    id: `sum_${randomUUID()}`,
    snapshotId,
    subjectId,
    level,
    contentJson: JSON.stringify(completion.json),
    model: model.name,
    promptVersion: PROMPT_VERSION,
    contentHash: packHash,
    createdAt: new Date().toISOString(),
  });
  recordRun(store, snapshotId, model.name, {
    kind: level,
    subjectId,
    cacheKey: `${subjectId}\n${packHash}`,
    startedAt,
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
  });

  return { cached: false, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens };
}

export async function analyzeSnapshot(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { store, snapshotId } = options;
  const budget = options.budget ?? DEFAULT_BUDGET;

  const result: AnalyzeResult = {
    modulesAnalyzed: 0,
    modulesCached: 0,
    briefGenerated: false,
    briefCached: false,
    inputTokens: 0,
    outputTokens: 0,
  };

  const modules = store
    .listModules(snapshotId)
    .filter((module) => !options.moduleFilter || module.name === options.moduleFilter);

  const dossiers: { module: string; dossier: unknown }[] = [];
  for (const module of modules) {
    const pack = buildModuleEvidencePack(store, snapshotId, module, budget);
    const packJson = JSON.stringify(pack);
    const outcome = await analyzeSubject(
      options,
      module.id,
      'module',
      packJson,
      modulePrompt(packJson),
      MODULE_DOSSIER_SCHEMA,
    );
    if (outcome.cached) {
      result.modulesCached += 1;
    } else {
      result.modulesAnalyzed += 1;
    }
    result.inputTokens += outcome.inputTokens;
    result.outputTokens += outcome.outputTokens;

    const summary = store.findCachedSummary(
      module.id,
      'module',
      contentHash(`${packJson}\n${PROMPT_VERSION}\n${options.model.name}`),
      PROMPT_VERSION,
      options.model.name,
    );
    if (summary) {
      dossiers.push({ module: module.name, dossier: JSON.parse(summary.contentJson) as unknown });
    }
  }

  // Brief solo con el snapshot completo (sin filtro): síntesis bottom-up.
  if (!options.moduleFilter) {
    const snapshot = store.getLatestSnapshot();
    const repository = snapshot ? store.getRepository(snapshot.repositoryId) : null;
    const counts = store.getCounts(snapshotId);
    const briefPack = JSON.stringify({
      repository: repository?.name ?? 'unknown',
      stats: counts,
      modules: dossiers,
    });
    const subjectId = `repo://${repository?.name ?? 'unknown'}`;
    const outcome = await analyzeSubject(
      options,
      subjectId,
      'repository',
      briefPack,
      repositoryPrompt(briefPack),
      REPOSITORY_BRIEF_SCHEMA,
    );
    result.briefCached = outcome.cached;
    result.briefGenerated = !outcome.cached;
    result.inputTokens += outcome.inputTokens;
    result.outputTokens += outcome.outputTokens;
  }

  return result;
}
