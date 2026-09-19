import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';

import { scanRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';
import { analyzeSnapshot } from '@repolead/lead-analyzer';
import { loadPolicies, runPolicies } from '@repolead/policy-engine';
import { QdrantRestClient, TeiEmbeddingsClient, indexSnapshot } from '@repolead/retrieval';

import { backendLabel, pickModel } from '../model-select';
import { tokenBudget } from './context';

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
    .description('Alta completa de un repo: scan + reindex + analyze + audit en un comando')
    .argument('[path]', 'ruta del repositorio', '.')
    .option('--db <path>', 'ruta del archivo SQLite (default: <repo>/.repolead/repolead.db)')
    .option('--name <name>', 'nombre del repositorio')
    .option('--model <name>', 'modelo para analyze y audit')
    .option('--backend <backend>', 'api | claude-code')
    .option('--context-tokens <n>', 'presupuesto de evidencia por módulo (o200k_base)', tokenBudget, 4000)
    .option('--policies <dir>', 'directorio de policies (default: el pack de RepoLead)')
    .option('--no-scip', 'no ejecutar scip-typescript')
    .option('--no-analyze', 'saltar el análisis del Tech Lead')
    .option('--no-audit', 'saltar el policy audit')
    .action(async (path: string, options: {
      db?: string;
      name?: string;
      model?: string;
      backend?: string;
      policies?: string;
      scip: boolean;
      analyze: boolean;
      audit: boolean;
      contextTokens: number;
    }) => {
      const rootPath = resolve(path);
      const dbPath = options.db ?? join(rootPath, '.repolead', 'repolead.db');

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

      console.log('\n[2/4] reindex — vectores semánticos');
      const teiUrl = process.env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8080';
      const qdrantUrl = process.env['REPOLEAD_QDRANT_URL'] ?? 'http://localhost:6333';
      if ((await reachable(`${teiUrl}/health`)) && (await reachable(`${qdrantUrl}/healthz`))) {
        const store = await openStore(dbPath);
        const indexed = await indexSnapshot({
          store,
          snapshotId: scan.snapshotId,
          repositoryName: scan.repositoryName,
          collection: 'repolead-symbols',
          embeddings: new TeiEmbeddingsClient(teiUrl),
          qdrant: new QdrantRestClient(qdrantUrl),
        });
        store.close();
        console.log(`✓ ${indexed} símbolos vectorizados`);
      } else {
        console.log('− saltado (TEI/Qdrant no disponibles: docker compose up -d)');
      }

      const model = options.analyze || options.audit ? pickModel(options.backend, options.model) : null;

      console.log('\n[3/4] analyze — Tech Lead');
      if (options.analyze && model) {
        console.log(`backend: ${backendLabel(model)} · ${model.name}`);
        const store = await openStore(dbPath);
        const analysis = await analyzeSnapshot({
          store,
          snapshotId: scan.snapshotId,
          model,
          budget: { maxTokens: options.contextTokens },
          onProgress: (progress) => {
            const mark = progress.outcome === 'cached' ? '↺' : '✓';
            const detail =
              progress.outcome === 'cached' ? 'desde caché' : `${(progress.durationMs / 1000).toFixed(0)}s`;
            console.log(`${mark} [${progress.index}/${progress.total}] ${progress.subject} · ${detail}`);
          },
        });
        store.close();
        console.log(
          `✓ ${analysis.modulesAnalyzed} analizados, ${analysis.modulesCached} desde caché · ${analysis.inputTokens} in / ${analysis.outputTokens} out`,
        );
      } else {
        console.log('− saltado (--no-analyze)');
      }

      console.log('\n[4/4] audit — policy pack');
      const policiesDir = resolvePoliciesDir(options.policies);
      if (options.audit && model && policiesDir) {
        const store = await openStore(dbPath);
        const audit = await runPolicies({
          store,
          snapshotId: scan.snapshotId,
          policies: loadPolicies(policiesDir),
          model,
        });
        store.close();
        console.log(`✓ ${audit.candidates} candidatos → ${audit.confirmed.length} confirmados, ${audit.rejected} rechazados`);
        for (const finding of audit.confirmed) {
          console.log(`  [${finding.severity.toUpperCase()}] ${finding.ruleId}: ${finding.claim}`);
        }
      } else {
        console.log(
          options.audit && !policiesDir ? '− saltado (no encontré el directorio de policies)' : '− saltado (--no-audit)',
        );
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
