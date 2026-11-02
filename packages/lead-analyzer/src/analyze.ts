import { randomUUID } from 'node:crypto';

import type { EvidenceRecord, SummaryDoc, SummaryLevel } from '@repolead/domain';
import { contentHash, DEFAULT_SOURCE_LINES } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import { owningModule, validateTokenBudget } from '@repolead/retrieval';

import { selectSymbols, simpleLeaf } from './selection';
import type { SymbolSelection } from './selection';

import type { AnalysisBudget } from './evidence';
import { buildModuleEvidencePack, DEFAULT_BUDGET } from './evidence';
import { buildFilePack, buildSymbolPack, dependencyUnknowns, evidenceEntry, fitHierarchyPack, listSourceFiles, summaryEntries, technicalFiles } from './hierarchy';
import type { HierarchicalPack, SummaryCacheBinding } from './hierarchy';
import { buildDependencyIndex, validateReanalysisDepth } from './dependencies';
import type { TechLeadModel } from './model';
import { ModelUsageError } from './model';
import { EVIDENCE_ENCODING_VERSION, modelEvidence } from './model-evidence';
import { analysisBatchSize, BatchedTechLeadModel, forAnalysisBatches } from './batched-model';
import { ANALYSIS_POLICY_VERSION, PROMPT_VERSION, summaryPrompt, summarySchema, TECH_LEAD_SYSTEM, validateSummary } from './prompts';
import { analyzeFiles } from './file-analysis';

export interface AnalyzeProgress {
  subject: string;
  level: SummaryLevel;
  outcome: 'analyzed' | 'cached';
  durationMs: number;
  index: number;
  total: number;
}

export interface AnalyzeOptions {
  /** CLI defaults to files. Omitted retains the existing exhaustive library API. */
  analysisMode?: 'files' | 'symbols';
  store: KnowledgeStore;
  snapshotId: string;
  model: TechLeadModel;
  leafModel?: TechLeadModel;
  criticalModulePaths?: string[];
  symbolSelection?: SymbolSelection;
  budget?: AnalysisBudget;
  moduleFilter?: string;
  /** Explicit validation retries, not an unbounded agent loop. Default 2. */
  validationRetries?: number;
  policyVersion?: string;
  onProgress?: (progress: AnalyzeProgress) => void;
}

export interface AnalyzeResult {
  symbolsSkipped: number;
  localInputTokens: number;
  localOutputTokens: number;
  symbolsAnalyzed: number;
  symbolsCached: number;
  filesAnalyzed: number;
  filesCached: number;
  modulesAnalyzed: number;
  modulesCached: number;
  briefGenerated: boolean;
  briefCached: boolean;
  inputTokens: number;
  outputTokens: number;
}

function recordRun(options: AnalyzeOptions, pack: HierarchicalPack, cacheKey: string,
  startedAt: string, status: 'completed' | 'failed', inputTokens: number, outputTokens: number): void {
  options.store.db.prepare(`INSERT OR REPLACE INTO analysis_runs
    (id, snapshot_id, kind, cache_key, model, prompt_version, policy_version, status,
     started_at, finished_at, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`run_${randomUUID()}`, options.snapshotId, pack.subject.level, cacheKey, options.model.name,
      PROMPT_VERSION, options.policyVersion ?? ANALYSIS_POLICY_VERSION, status,
      startedAt, new Date().toISOString(), inputTokens, outputTokens);
}

/** A persisted summary is both schema-valid and linked to evidence actually supplied to the model. */
export async function analyzeSubject(options: AnalyzeOptions, pack: HierarchicalPack, evidence: EvidenceRecord[], cacheBinding?: SummaryCacheBinding): Promise<{
  summary: SummaryDoc; cached: boolean; inputTokens: number; outputTokens: number;
}> {
  const { store, snapshotId, model } = options;
  if (!Number.isInteger(options.validationRetries ?? 2) || (options.validationRetries ?? 2) < 0 || (options.validationRetries ?? 2) > 3) {
    throw new Error('validationRetries must be an integer between 0 and 3.');
  }
  const level = pack.subject.level;
  const packJson = JSON.stringify(pack);
  const policyVersion = options.policyVersion ?? ANALYSIS_POLICY_VERSION;
  const packHash = contentHash(`${cacheBinding?.fingerprint ?? packJson}\n${PROMPT_VERSION}\n${EVIDENCE_ENCODING_VERSION}\n${policyVersion}\n${model.name}`
    + (level === 'file' ? '\nproduct-facts-v2' : ''));
  const allowed = new Set(evidence.map((entry) => entry.id));
  const validate = (json: unknown): unknown => {
    const content = validateSummary(level, json, allowed);
    if (level === 'document' || level === 'product') { validateProductReferences(content, pack, evidence, store); }
    return content;
  };
  const cached = store.findCachedSummary(pack.subject.id, level, packHash, PROMPT_VERSION, model.name);
  const storedBinding = cached && cacheBinding ? store.db.prepare('SELECT evidence_ids_json FROM summary_cache_bindings WHERE summary_id = ?')
    .get(cached.id) as { evidence_ids_json: string } | undefined : undefined;
  const previousIds = storedBinding ? JSON.parse(storedBinding.evidence_ids_json) as string[] : null;
  const relocated = !!cacheBinding && !!previousIds && JSON.stringify(previousIds) !== JSON.stringify(cacheBinding.evidenceIds);
  // Avoid carrying a model's prose with absolute line references to a new location.
  const hasWrittenLocations = cached && /(?:\blines?\s+\d|\blíneas?\s+\d|\bL\d+\b|\.[a-z]+:\d+)/i.test(cached.contentJson);
  const saveBinding = (summaryId: string) => {
    if (cacheBinding) { store.db.prepare('INSERT INTO summary_cache_bindings(summary_id, evidence_ids_json) VALUES (?, ?)')
      .run(summaryId, JSON.stringify(cacheBinding.evidenceIds)); }
  };
  if (cached && (!cacheBinding || (previousIds?.length === cacheBinding.evidenceIds.length && !(relocated && hasWrittenLocations)))) {
    let json = cached.contentJson;
    if (cacheBinding && previousIds) {
      const replacements = new Map(previousIds.map((id, index) => [id, cacheBinding.evidenceIds[index]!]));
      json = json.replace(/ev_[a-f0-9]{64}/g, (id) => replacements.get(id) ?? id);
    }
    validate(JSON.parse(json) as unknown);
    const current = store.getSummary(snapshotId, pack.subject.id, level);
    const summary = cached.snapshotId === snapshotId && current?.id === cached.id && json === cached.contentJson ? cached : { ...cached,
      id: `sum_${randomUUID()}`, snapshotId, contentJson: json, createdAt: new Date().toISOString() };
    if (summary !== cached) { store.db.transaction(() => { store.insertSummary(summary, cacheBinding ? evidence : store.getSummaryEvidence(cached.id)); saveBinding(summary.id); })(); }
    return { summary, cached: true, inputTokens: 0, outputTokens: 0 };
  }

  const startedAt = new Date().toISOString();
  const cacheKey = `${pack.subject.id}\n${packHash}`;
  let inputTokens = 0;
  let outputTokens = 0;
  let correction = '';
  const retries = options.validationRetries ?? 2;
  const supplied = modelEvidence(pack, summarySchema(level), model instanceof BatchedTechLeadModel ? `${level}:${pack.subject.id}` : undefined);
  try {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const completion = await model.complete({ system: TECH_LEAD_SYSTEM,
        prompt: summaryPrompt(level, JSON.stringify(supplied.pack)) + correction, schema: supplied.schema });
      inputTokens += completion.inputTokens;
      outputTokens += completion.outputTokens;
      let content: unknown;
      try { content = validate(supplied.expand(completion.json)); }
      catch (error) {
        if (attempt === retries) { throw error; }
        correction = `\nYour previous output failed validation: ${String(error).slice(0, 1500)}\nReturn a corrected JSON object. Cite only the supplied evidence IDs; do not invent missing evidence.`;
        continue;
      }
      const document = content as { unknowns: string[] };
      // Persist deterministic omission warnings even when a model neglects to mention them.
      document.unknowns = [...new Set([...document.unknowns, ...pack.unknowns,
        ...(pack.truncation.omittedEvidence ? [`${pack.truncation.omittedEvidence} evidence entries were omitted by the token budget.`] : []),
        ...(pack.truncation.omittedSourceLines ? [`${pack.truncation.omittedSourceLines} source lines were not supplied; behavior is only partially analyzed.`] : []),
      ])];
      const summary: SummaryDoc = { id: `sum_${randomUUID()}`, snapshotId, subjectId: pack.subject.id,
        level, contentJson: JSON.stringify(content), model: model.name, promptVersion: PROMPT_VERSION,
        contentHash: packHash, createdAt: new Date().toISOString() };
      store.db.transaction(() => {
        store.insertSummary(summary, evidence);
        saveBinding(summary.id);
        recordRun(options, pack, cacheKey, startedAt, 'completed', inputTokens, outputTokens);
      })();
      return { summary, cached: false, inputTokens, outputTokens };
    }
    throw new Error('Analysis validation retries exhausted.');
  } catch (error) {
    if (error instanceof ModelUsageError) { inputTokens += error.usage.inputTokens; outputTokens += error.usage.outputTokens; }
    recordRun(options, pack, cacheKey, startedAt, 'failed', inputTokens, outputTokens);
    throw error;
  }
}

function validateProductReferences(content: unknown, pack: HierarchicalPack, evidence: EvidenceRecord[], store: KnowledgeStore): void {
  const symbolIds = new Set<string>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object') { return; }
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'id' || key === 'subjectId') && typeof item === 'string' && item.startsWith('sym_')) { symbolIds.add(item); }
      if (key === 'symbolIds' && Array.isArray(item)) { item.filter((id): id is string => typeof id === 'string').forEach((id) => symbolIds.add(id)); }
      if (Array.isArray(item)) { item.forEach(collect); } else { collect(item); }
    }
  };
  pack.evidence.forEach((entry) => collect(entry.facts));
  const records = new Map(evidence.map((entry) => [entry.id, entry]));
  const supportedBy = (id: string, kind: 'source' | 'document', seen = new Set<string>()): boolean => {
    if (seen.has(id)) { return false; }
    seen.add(id);
    const record = records.get(id) ?? store.getEvidenceRecord(id);
    return Boolean(record && (record.kind === kind || record.parentIds.some((parent) => supportedBy(parent, kind, seen))));
  };
  for (const values of Object.values(content as Record<string, unknown>)) {
    if (!Array.isArray(values)) { continue; }
    for (const item of values) {
      if (!item || typeof item !== 'object' || !('basis' in item)) { continue; }
      const claim = item as { basis: string; symbolIds: string[]; evidenceIds: string[] };
      if (claim.symbolIds.some((id) => !symbolIds.has(id))) { throw new Error('Product claim cites a symbol not supplied in its evidence.'); }
      const required = claim.basis === 'implemented' ? 'source' : claim.basis === 'documented' ? 'document' : null;
      if (required && !claim.evidenceIds.some((id) => supportedBy(id, required))) {
        throw new Error(`A ${claim.basis} claim requires ${required} evidence; use inferred or unknown when unsupported.`);
      }
    }
  }
}

function childUnknowns(children: SummaryDoc[]): string[] {
  const partial = children.filter((child) => {
    const content = JSON.parse(child.contentJson) as { unknowns?: string[] };
    return Boolean(content.unknowns?.length);
  });
  return partial.length ? [`${partial.length} child dossiers report uncertainty or omitted evidence; inspect their detailed records before treating this synthesis as exhaustive.`] : [];
}

export async function analyzeSnapshot(options: AnalyzeOptions): Promise<AnalyzeResult> {
  if (options.analysisMode === 'files') { return analyzeFiles(options); }
  const { store, snapshotId } = options;
  const budget = options.budget ?? DEFAULT_BUDGET;
  const batchSize = analysisBatchSize(budget.batchSize);
  const primary = batchSize > 1 ? new BatchedTechLeadModel(options.model, batchSize) : options.model;
  const maxTokens = validateTokenBudget(budget.maxTokens ?? DEFAULT_BUDGET.maxTokens!);
  const maxReanalysisDepth = validateReanalysisDepth(budget.maxReanalysisDepth);
  if (!Number.isInteger(budget.maxSourceLinesPerPack ?? DEFAULT_SOURCE_LINES) || (budget.maxSourceLinesPerPack ?? DEFAULT_SOURCE_LINES) < 1) {
    throw new Error('maxSourceLinesPerPack must be a positive integer.');
  }
  if (!Number.isInteger(options.validationRetries ?? 2) || (options.validationRetries ?? 2) < 0 || (options.validationRetries ?? 2) > 3) {
    throw new Error('validationRetries must be an integer between 0 and 3.');
  }
  const snapshot = store.getSnapshot(snapshotId);
  const repository = snapshot ? store.getRepository(snapshot.repositoryId) : null;
  if (!repository) { throw new Error('Unknown repository snapshot.'); }
  const allModules = store.listModules(snapshotId);
  const modules = allModules.filter((module) => !options.moduleFilter || module.name === options.moduleFilter || module.path === options.moduleFilter);
  if (options.moduleFilter && modules.length !== 1) { throw new Error('Unknown or ambiguous module; use its path.'); }
  const moduleIds = new Set(modules.map((module) => module.id));
  const graph = store.loadGraph(snapshotId);
  const symbols = [...graph.symbols.values()].filter((symbol) => moduleIds.has(owningModule(symbol.path, allModules)?.id ?? ''));
  const selection = selectSymbols(store, snapshotId, symbols, options.symbolSelection);
  const allFiles = listSourceFiles(store, snapshotId);
  const files = technicalFiles(store, snapshotId, allFiles).filter((file) => moduleIds.has(owningModule(file.path, allModules)?.id ?? ''));
  const dependencies = buildDependencyIndex(store, snapshotId, graph, allFiles);
  const result: AnalyzeResult = { symbolsSkipped: selection.skipped.length, localInputTokens: 0, localOutputTokens: 0, symbolsAnalyzed: 0, symbolsCached: 0, filesAnalyzed: 0, filesCached: 0,
    modulesAnalyzed: 0, modulesCached: 0, briefGenerated: false, briefCached: false, inputTokens: 0, outputTokens: 0 };
  const total = selection.selected.length + files.length + modules.length + (options.moduleFilter ? 0 : 1);
  let index = 0;
  const run = async (input: ReturnType<typeof fitHierarchyPack>, model = primary): Promise<SummaryDoc> => {
    const start = Date.now();
    const outcome = await analyzeSubject({ ...options, model }, input.pack, input.evidence, input.cacheBinding);
    const level = input.pack.subject.level;
    if (level === 'repository') {
      result.briefCached = outcome.cached;
      result.briefGenerated = !outcome.cached;
    } else {
      const key = `${level === 'symbol' ? 'symbols' : level === 'file' ? 'files' : 'modules'}${outcome.cached ? 'Cached' : 'Analyzed'}` as
        'symbolsCached' | 'symbolsAnalyzed' | 'filesCached' | 'filesAnalyzed' | 'modulesCached' | 'modulesAnalyzed';
      result[key] += 1;
    }
    if (model.locality === 'local' || model === options.leafModel) { result.localInputTokens += outcome.inputTokens; result.localOutputTokens += outcome.outputTokens; }
    result.inputTokens += outcome.inputTokens;
    result.outputTokens += outcome.outputTokens;
    index += 1;
    options.onProgress?.({ subject: input.pack.subject.name, level, outcome: outcome.cached ? 'cached' : 'analyzed',
      durationMs: Date.now() - start, index, total });
    return outcome.summary;
  };

  const symbolCards = new Map<string, SummaryDoc>();
  await forAnalysisBatches(selection.selected, batchSize, async (symbol) => {
    const model = options.leafModel && simpleLeaf(store, snapshotId, graph, symbol, options.criticalModulePaths) ? options.leafModel : primary;
    symbolCards.set(symbol.id, await run(buildSymbolPack(store, snapshotId, repository.rootPath,
      symbol, maxTokens, budget.maxSourceLinesPerPack ?? DEFAULT_SOURCE_LINES, graph, dependencies, maxReanalysisDepth), model));
  });
  const fileDossiers = new Map<string, SummaryDoc>();
  await forAnalysisBatches(files, batchSize, async (file) => {
    const fileSymbols = symbols.filter((symbol) => symbol.path === file.path);
    const children = fileSymbols.filter((symbol) => symbolCards.has(symbol.id)).map((symbol) => symbolCards.get(symbol.id)!);
    const skipped = fileSymbols.length - children.length;
    fileDossiers.set(file.path, await run(buildFilePack(store, snapshotId, repository.rootPath, file, fileSymbols,
      children, maxTokens, budget.maxSourceLinesPerPack ?? DEFAULT_SOURCE_LINES, graph, dependencies, maxReanalysisDepth, [...childUnknowns(children), ...(skipped ? [`${skipped} private trivial symbols have no individual cards; their source is supplied in this file dossier, subject to its budget.`] : [])])));
  });
  const moduleCards = new Map<string, SummaryDoc>();
  await forAnalysisBatches(modules, batchSize, async (module) => {
    const children = files.filter((file) => owningModule(file.path, allModules)?.id === module.id)
      .map((file) => fileDossiers.get(file.path)!);
    const structural = buildModuleEvidencePack(store, snapshotId, module,
      { ...budget, maxTokens: Math.max(256, Math.floor(maxTokens / 2)) }, dependencies);
    const facts = evidenceEntry('module', module.path, structural);
    moduleCards.set(module.id, await run(fitHierarchyPack({ id: module.id, name: module.name, path: module.path, level: 'module' },
      [...summaryEntries(children.map((summary) => ({ summary, path: files.find((file) => file.id === summary.subjectId)!.path }))), facts],
      maxTokens, { fingerprint: structural.fingerprint, unknowns: [...childUnknowns(children), ...dependencyUnknowns(structural.dependencyScope)] })));
  });
  const moduleDossiers = modules.map((module) => moduleCards.get(module.id)!);
  if (!options.moduleFilter) {
    const stats = evidenceEntry('repository', '.', { repository: repository.name, counts: store.getCounts(snapshotId) });
    await run(fitHierarchyPack({ id: `repo://${repository.name}`, name: 'Repository Brief', level: 'repository' },
      [...summaryEntries(moduleDossiers.map((summary) => ({ summary, path: modules.find((module) => module.id === summary.subjectId)!.path }))), stats],
      maxTokens, { unknowns: [...childUnknowns(moduleDossiers),
        ...(allFiles.some((file) => file.language === null) ? [`${allFiles.filter((file) => file.language === null).length} files have no recognized text format and no technical dossier.`] : []),
      ] }));
  }
  store.setSnapshotMetadata(snapshotId, 'technical_analysis', JSON.stringify({ maxReanalysisDepth,
    symbols: symbols.length, files: files.length, model: primary.name, batchSize,
    symbolSelection: options.symbolSelection ?? 'all', skippedSymbolIds: selection.skipped.map((symbol) => symbol.id),
    leafModel: options.leafModel?.name ?? null, criticalModulePaths: options.criticalModulePaths ?? [],
    policyVersion: options.policyVersion ?? ANALYSIS_POLICY_VERSION }));
  store.rebuildSearchIndex(snapshotId);
  return result;
}
