import type { Command } from 'commander';

import { refreshRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';
import { analyzeSnapshot } from '@repolead/lead-analyzer';
import { QdrantRestClient, TeiEmbeddingsClient, indexSnapshot } from '@repolead/retrieval';

import { backendLabel, pickModel } from '../model-select';
import { tokenBudget } from './context';

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

export function registerRefresh(program: Command): void {
  program
    .command('refresh')
    .description('Actualiza el índice incrementalmente: git diff → símbolos → módulos afectados')
    .argument('[path]', 'ruta del repositorio', '.')
    .option('--db <path>', 'ruta del archivo SQLite')
    .option('--analyze', 're-analiza con el Tech Lead (solo módulos invalidados, vía caché)')
    .option('--model <name>', 'modelo para --analyze')
    .option('--backend <backend>', 'api | claude-code')
    .option('--context-tokens <n>', 'presupuesto de evidencia por módulo (o200k_base)', tokenBudget, 4000)
    .option('--no-scip', 'no ejecutar scip-typescript')
    .action(async (path: string, options: {
      db?: string;
      analyze?: boolean;
      model?: string;
      backend?: string;
      scip: boolean;
      contextTokens: number;
    }) => {
      const result = await refreshRepository({
        rootPath: path,
        dbPath: options.db,
        scip: options.scip,
      });

      if (result.upToDate) {
        console.log(`✓ Sin cambios desde el último snapshot (${(result.durationMs / 1000).toFixed(1)}s)`);
        return;
      }

      console.log(`✓ ${String(result.changedFiles.length).padStart(6)} archivos cambiados`);
      console.log(`✓ ${String(result.changedSymbolIds.length).padStart(6)} símbolos invalidados`);
      console.log(`✓ ${String(result.removedSymbolIds.length).padStart(6)} símbolos eliminados`);
      console.log(`✓ módulos afectados: ${result.affectedModules.join(', ') || '(ninguno)'}`);

      const scan = result.scan!;
      const dbPath = scan.dbPath;

      const teiUrl = process.env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8080';
      const qdrantUrl = process.env['REPOLEAD_QDRANT_URL'] ?? 'http://localhost:6333';
      const [teiUp, qdrantUp] = await Promise.all([
        reachable(`${teiUrl}/health`),
        reachable(`${qdrantUrl}/healthz`),
      ]);
      if (teiUp && qdrantUp) {
        const store = await openStore(dbPath);
        const indexed = await indexSnapshot({
          store,
          snapshotId: scan.snapshotId,
          repositoryName: scan.repositoryName,
          collection: 'repolead-symbols',
          embeddings: new TeiEmbeddingsClient(teiUrl),
          qdrant: new QdrantRestClient(qdrantUrl),
          symbolIds: new Set(result.changedSymbolIds),
          onProgress: ({ embedded, reused }) => console.log(`  embeddings: ${embedded} nuevos · ${reused} reutilizados`),
        });
        store.close();
        console.log(`✓ ${String(indexed).padStart(6)} vectores asociados al snapshot actual`);
      } else {
        console.log('− vectores sin actualizar (TEI/Qdrant no disponibles o sin cambios)');
      }

      if (options.analyze) {
        const model = pickModel(options.backend, options.model);
        console.log(`analyze: ${backendLabel(model)} · ${model.name}`);
        const store = await openStore(dbPath);
        const analysis = await analyzeSnapshot({
          store,
          snapshotId: scan.snapshotId,
          model,
          budget: { maxTokens: options.contextTokens },
          onProgress: (progress) =>
            console.log(
              `${progress.outcome === 'cached' ? '\u21ba' : '\u2713'} [${progress.index}/${progress.total}] ${progress.subject}`,
            ),
        });
        store.close();
        console.log(
          `✓ ${analysis.modulesAnalyzed} módulos re-analizados, ${analysis.modulesCached} desde caché · brief ${analysis.briefCached ? 'desde caché' : 'regenerado'}`,
        );
        console.log(`  tokens: ${analysis.inputTokens} in / ${analysis.outputTokens} out`);
      }

      console.log(`\nDone in ${(result.durationMs / 1000).toFixed(1)}s`);
    });
}
