import type { Command } from 'commander';
import { Option } from 'commander';
import { join, resolve } from 'node:path';

import { refreshRepository } from '@repolead/code-graph';
import { analysisBudget, loadConfig } from '@repolead/config';
import { openStore } from '@repolead/knowledge-store';
import { analyzeSnapshot } from '@repolead/lead-analyzer';
import { vectorBackend, TeiEmbeddingsClient, defaultEmbeddingCollection, indexSnapshot } from '@repolead/retrieval';

import { backendLabel, pickModel, pickAnalysisRouting } from '../model-select';
import { tokenBudget } from './context';
import { analyzeProductAndPrint } from './product-analysis';
import { printVectorProgress } from './vector-progress';

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

export function registerRefresh(program: Command, modelFactory = pickModel): void {
  program
    .command('refresh')
    .description('Actualiza el índice incrementalmente: git diff → símbolos → módulos afectados')
    .argument('[path]', 'ruta del repositorio', '.')
    .option('--db <path>', 'ruta del archivo SQLite')
    .option('--analyze', 're-analiza con el Tech Lead (solo módulos invalidados, vía caché)')
    .option('--no-product', 'omitir contexto de producto al usar --analyze')
    .option('--model <name>', 'modelo para --analyze')
    .option('--backend <backend>', 'ollama (default) | api | claude-code')
    .addOption(new Option('--analysis-mode <mode>', 'entrypoints: usecases/pages; files: por archivo; symbols: exhaustivo').choices(['entrypoints', 'files', 'symbols']))
    .option('--context-tokens <n>', 'presupuesto por análisis (config o 120000; o200k_base)', tokenBudget)
    .option('--no-scip', 'no ejecutar scip-typescript')
    .option('--no-vectors', 'aplazar embeddings/vectores hasta ejecutar reindex')
    .action(async (path: string, options: {
      db?: string;
      analyze?: boolean;
      product: boolean;
      model?: string;
      backend?: string;
      analysisMode?: 'entrypoints' | 'files' | 'symbols';
      scip: boolean;
      vectors: boolean;
      contextTokens?: number;
    }) => {
      const started = Date.now();
      const { config } = loadConfig(path);
      const analysisMode = options.analysisMode ?? config.analysis_mode;
      const result = await refreshRepository({
        rootPath: path,
        dbPath: options.db,
        scip: options.scip,
      });

      if (result.upToDate) {
        console.log(`✓ Sin cambios desde el último snapshot (${(result.durationMs / 1000).toFixed(1)}s)`);
        if (!options.analyze) { return; }
      } else {
        console.log(`✓ ${String(result.changedFiles.length).padStart(6)} archivos cambiados`);
        console.log(`✓ ${String(result.changedSymbolIds.length).padStart(6)} símbolos invalidados`);
        console.log(`✓ ${String(result.removedSymbolIds.length).padStart(6)} símbolos eliminados`);
        console.log(`✓ módulos afectados: ${result.affectedModules.join(', ') || '(ninguno)'}`);
        console.log(`✓ parseo: ${result.scan!.parsing.parsedFiles} archivos · ${result.scan!.parsing.reusedFiles} reutilizados`);
      }

      const dbPath = result.scan?.dbPath ?? options.db ?? join(resolve(path), '.repolead', 'repolead.db');
      const store = await openStore(dbPath);
      try {
        const snapshot = store.getLatestSnapshot();
        if (!snapshot) { throw new Error('No indexed snapshot is available after refresh.'); }
        const repository = store.getRepository(snapshot.repositoryId)!;

        if (options.analyze) {
          const model = await modelFactory(options.backend ?? config.model.backend, options.model ?? config.model.name, config.local_model);
          console.log(`analyze: ${backendLabel(model)} · ${model.name}`);
          console.log(`modo: ${analysisMode} · ${analysisMode === 'entrypoints' ? 'solo usecases/pages; sin síntesis' : analysisMode === 'files' ? 'código por archivo y primera ronda' : 'fichas individuales por símbolo'}`);
          const analysis = await analyzeSnapshot({
            ...await pickAnalysisRouting(config, model),
            analysisMode,
            store,
            snapshotId: snapshot.id,
            model,
            budget: analysisBudget(config, options.contextTokens),
            onProgress: (progress) =>
              console.log(
                `${progress.outcome === 'cached' ? '\u21ba' : '\u2713'} [${progress.index}/${progress.total}] ${progress.subject}`,
              ),
          });
          console.log(
            `✓ ${analysis.symbolsAnalyzed} símbolos, ${analysis.filesAnalyzed} análisis de ${analysisMode === 'entrypoints' ? 'usecase/page' : 'archivo'}, ${analysis.modulesAnalyzed} análisis de módulo · ${analysis.symbolsCached + analysis.filesCached + analysis.modulesCached} desde caché · ${analysisMode !== 'symbols' ? 'resumen global omitido' : `brief ${analysis.briefCached ? 'desde caché' : 'regenerado'}`}`,
          );
          console.log(`  tokens: ${analysis.inputTokens} in / ${analysis.outputTokens} out`);
          if (analysisMode === 'files') { console.log(`  ${analysis.symbolsSkipped} símbolos cubiertos dentro de sus archivos, sin fichas individuales`); }
          if (options.product) {
            await analyzeProductAndPrint({ store, snapshotId: snapshot.id, model, analysisMode, budget: analysisBudget(config, options.contextTokens),
              onProgress: (p) => console.log(`${p.outcome === 'cached' ? '↺' : '✓'} producto [${p.index}/${p.total}] ${p.subject}`) });
          }
        }

        if (!options.vectors) {
          store.setSnapshotMetadata(snapshot.id, 'vector_refresh_pending', 'true');
          console.log('− vectores aplazados (--no-vectors); ejecutar repolead reindex después del análisis');
        } else {
        const teiUrl = process.env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8082';
        const [teiUp, vectors] = await Promise.all([
          reachable(`${teiUrl}/health`),
          vectorBackend({ migrate: true }),
        ]);
        if (teiUp && vectors) {
          const embeddings = new TeiEmbeddingsClient(teiUrl);
          const indexed = await indexSnapshot({
            store,
            snapshotId: snapshot.id,
            repositoryName: repository.name,
            collection: await defaultEmbeddingCollection(embeddings),
            embeddings,
            qdrant: vectors,
            symbolIds: new Set(result.changedSymbolIds),
            onProgress: printVectorProgress,
          });
          console.log(`✓ ${String(indexed).padStart(6)} vectores asociados al snapshot actual`);
        } else {
          console.log('− vectores sin actualizar (TEI/backend vectorial no disponibles)');
        }
        }
      } finally { store.close(); }
      console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    });
}
