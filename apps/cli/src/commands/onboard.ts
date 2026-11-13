import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';
import { Option } from 'commander';

import { scanRepository } from '@repolead/code-graph';
import { analysisBudget, loadConfig } from '@repolead/config';
import { openStore } from '@repolead/knowledge-store';
import { analyzeSnapshot } from '@repolead/lead-analyzer';
import { loadPolicies, runPolicies } from '@repolead/policy-engine';
import { vectorBackend, TeiEmbeddingsClient, defaultEmbeddingCollection, indexSnapshot } from '@repolead/retrieval';

import { backendLabel, pickModel, pickAnalysisRouting } from '../model-select';
import { tokenBudget } from './context';
import { analyzeProductAndPrint } from './product-analysis';
import { printVectorProgress } from './vector-progress';

/**
 * Localiza el policy pack: --policies explícito, ./policies del repo objetivo,
 * o el pack de la instalación de RepoLead (subiendo desde este archivo, que
 * funciona igual en dev y en el bundle).
 */
export function resolvePoliciesDir(explicit?: string): string | null {
  if (explicit) {
    return existsSync(explicit) ? explicit : null;
  }
  if (existsSync(join(process.cwd(), 'policies', 'architecture'))) {
    return join(process.cwd(), 'policies');
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let level = 0; level < 7; level += 1) {
    if (existsSync(join(dir, 'policies', 'architecture'))) {
      return join(dir, 'policies');
    }
    dir = dirname(dir);
  }
  return null;
}

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

export function registerOnboard(program: Command): void {
  program
    .command('onboard')
    .description('Alta completa de un repo: scan + analyze + audit + reindex en un comando')
    .argument('[path]', 'ruta del repositorio', '.')
    .option('--db <path>', 'ruta del archivo SQLite (default: <repo>/.repolead/repolead.db)')
    .option('--name <name>', 'nombre del repositorio')
    .option('--model <name>', 'modelo para analyze y audit')
    .option('--backend <backend>', 'ollama (default) | api | claude-code')
    .addOption(new Option('--analysis-mode <mode>', 'entrypoints: usecases/pages; files (default): por archivo; symbols: exhaustivo').choices(['entrypoints', 'files', 'symbols']))
    .option('--context-tokens <n>', 'presupuesto por análisis (config o 120000; o200k_base)', tokenBudget)
    .option('--policies <dir>', 'directorio de policies (default: el pack de RepoLead)')
    .option('--no-scip', 'no ejecutar scip-typescript')
    .option('--no-analyze', 'saltar el análisis del Tech Lead')
    .option('--no-product', 'saltar la preparación del contexto de producto')
    .option('--no-audit', 'saltar el policy audit')
    .option('--no-vectors', 'aplazar embeddings/vectores hasta ejecutar reindex')
    .action(async (path: string, options: {
      db?: string;
      name?: string;
      model?: string;
      backend?: string;
      analysisMode?: 'entrypoints' | 'files' | 'symbols';
      policies?: string;
      scip: boolean;
      analyze: boolean;
      product: boolean;
      audit: boolean;
      vectors: boolean;
      contextTokens?: number;
    }) => {
      const rootPath = resolve(path);
      const { config } = loadConfig(rootPath);
      const analysisMode = options.analysisMode ?? config.analysis_mode;
      const dbPath = options.db ?? join(rootPath, '.repolead', 'repolead.db');
      const model = options.analyze || options.audit ? await pickModel(options.backend ?? config.model.backend, options.model ?? config.model.name, config.local_model) : null;

      console.log('[1/4] scan — hechos determinísticos');
      const scan = await scanRepository({
        rootPath,
        dbPath,
        repositoryName: options.name,
        scip: options.scip,
      });
      console.log(
        `✓ ${scan.counts.files} files · ${scan.counts.symbols} símbolos · ${scan.counts.edges} edges · ${
          scan.referencesResolved ?? 'sin'
        } referencias SCIP · ${scan.counts.modules} módulos (${(scan.durationMs / 1000).toFixed(1)}s)`,
      );

      console.log('\n[2/4] analyze — Tech Lead');
      if (options.analyze && model) {
        console.log(`backend: ${backendLabel(model)} · ${model.name}`);
        console.log(`modo: ${analysisMode}`);
        const store = await openStore(dbPath);
        try {
        const analysis = await analyzeSnapshot({
            ...await pickAnalysisRouting(config, model),
          analysisMode,
          store,
          snapshotId: scan.snapshotId,
          model,
          budget: analysisBudget(config, options.contextTokens),
          onProgress: (progress) => {
            const mark = progress.outcome === 'cached' ? '↺' : '✓';
            const detail =
              progress.outcome === 'cached' ? 'desde caché' : `${(progress.durationMs / 1000).toFixed(0)}s`;
            console.log(`${mark} [${progress.index}/${progress.total}] ${progress.subject} · ${detail}`);
          },
        });
        console.log(
          `✓ ${analysis.symbolsAnalyzed} símbolos, ${analysis.filesAnalyzed} archivos, ${analysis.modulesAnalyzed} módulos analizados · ${analysis.symbolsCached + analysis.filesCached + analysis.modulesCached} desde caché · ${analysis.inputTokens} in / ${analysis.outputTokens} out`,
        );
        if (options.product) {
          await analyzeProductAndPrint({ store, snapshotId: scan.snapshotId, model, analysisMode, budget: analysisBudget(config, options.contextTokens),
            onProgress: (p) => console.log(`${p.outcome === 'cached' ? '↺' : '✓'} producto [${p.index}/${p.total}] ${p.subject}`) });
        }
        } finally { store.close(); }
      } else {
        console.log('− saltado (--no-analyze)');
      }

      console.log('\n[3/4] audit — policy pack');
      const policiesDir = resolvePoliciesDir(options.policies);
      if (options.audit && model && policiesDir) {
        const store = await openStore(dbPath);
        try {
        const audit = await runPolicies({
          store,
          snapshotId: scan.snapshotId,
          policies: loadPolicies(policiesDir),
          model,
          maxTokens: analysisBudget(config, options.contextTokens).maxTokens,
          maxFindingsPerModule: config.analysis_budget.max_findings_per_module,
          maxEvidencePerFinding: config.analysis_budget.max_evidence_per_finding,
        });
        console.log(`✓ ${audit.candidates} candidatos → ${audit.confirmed.length} confirmados, ${audit.rejected} rechazados`);
        console.log(`  caché: ${audit.cachedJudgments} · evidencia insuficiente: ${audit.missingEvidence} · omitidos: ${audit.omittedCandidates} candidatos / ${audit.omittedEvidence} evidencias · tokens ${audit.inputTokens} in / ${audit.outputTokens} out`);
        for (const finding of audit.confirmed) {
          console.log(`  [${finding.severity.toUpperCase()}] ${finding.ruleId}: ${finding.claim}`);
        }
        } finally { store.close(); }
      } else {
        console.log(
          options.audit && !policiesDir ? '− saltado (no encontré el directorio de policies)' : '− saltado (--no-audit)',
        );
      }

      console.log('\n[4/4] reindex — vectores semánticos');
      const teiUrl = process.env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8082';
      const vectors = options.vectors ? await vectorBackend({ migrate: true }) : null;
      if (!options.vectors) {
        const store = await openStore(dbPath);
        try { store.setSnapshotMetadata(scan.snapshotId, 'vector_refresh_pending', 'true'); }
        finally { store.close(); }
        console.log('− vectores aplazados (--no-vectors); ejecutar repolead reindex después del análisis');
      } else if ((await reachable(`${teiUrl}/health`)) && vectors) {
        const store = await openStore(dbPath);
        const embeddings = new TeiEmbeddingsClient(teiUrl);
        const indexed = await indexSnapshot({
          store,
          snapshotId: scan.snapshotId,
          repositoryName: scan.repositoryName,
          collection: await defaultEmbeddingCollection(embeddings),
          embeddings,
          qdrant: vectors,
          onProgress: printVectorProgress,
        });
        store.close();
        console.log(`✓ ${indexed} elementos de conocimiento vectorizados`);
      } else {
        console.log('− saltado (TEI/backend vectorial no disponibles)');
      }

      const installRoot = policiesDir ? dirname(policiesDir) : null;
      const serveEntry = installRoot ? join(installRoot, 'apps/cli/src/index.ts') : '<ruta-a-repolead>/apps/cli/src/index.ts';
      const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      console.log(`\nListo. Siguientes pasos:`);
      console.log(`  repolead brief --db ${dbPath}`);
      console.log(`  claude mcp add repolead -- bun ${quote(serveEntry)} serve --db ${quote(dbPath)}`);
      console.log(`  codex mcp add repolead -- bun ${quote(serveEntry)} serve --db ${quote(dbPath)}`);
    });
}
