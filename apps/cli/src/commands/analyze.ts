import type { Command } from 'commander';
import { Option } from 'commander';

import { analysisBudget, loadConfig } from '@repolead/config';
import { analyzeSnapshot, buildDependencyIndex, buildDocumentPacks, buildModuleEvidencePack, buildSymbolPack, listSourceFiles, planEntryPointAnalysis, planFileAnalysis, selectSymbols, technicalFiles } from '@repolead/lead-analyzer';
import { openStore } from '@repolead/knowledge-store';
import { countTokens, owningModule } from '@repolead/retrieval';

import { backendLabel, pickModel, pickAnalysisRouting } from '../model-select';
import { tokenBudget } from './context';
import { analyzeProductAndPrint } from './product-analysis';

export function registerAnalyze(program: Command): void {
  program
    .command('analyze')
    .description('Genera fichas de símbolos, dossiers de archivos/módulos y Repository Brief con evidencia')
    .option('--db <path>', 'ruta del archivo SQLite', '.repolead/repolead.db')
    .option('--model <name>', 'modelo (default local: qwen3.5:9b-q4_K_M)')
    .option('--backend <backend>', 'ollama (default) | api | claude-code')
    .addOption(new Option('--analysis-mode <mode>', 'entrypoints: usecases/pages; files (default): por archivo; symbols: exhaustivo').choices(['entrypoints', 'files', 'symbols']))
    .option('--module <name>', 'analiza solo este módulo')
    .addOption(new Option('--audience <audience>', 'contexto técnico, de producto o ambos').choices(['technical', 'product', 'all']).default('all'))
    .option('--dry-run', 'construye los evidence packs sin llamar al modelo')
    .option('--context-tokens <n>', 'presupuesto por análisis (config o 120000; o200k_base)', tokenBudget)
    .option('--batch-size <n>', 'agrupar 1–4 análisis independientes por llamada (config o 1)', Number)
    .action(async (options: {
      db: string;
      model?: string;
      backend?: string;
      analysisMode?: 'entrypoints' | 'files' | 'symbols';
      module?: string;
      dryRun?: boolean;
      contextTokens?: number;
      batchSize?: number;
      audience: 'technical' | 'product' | 'all';
    }) => {
      if (options.module && options.audience === 'product') { throw new Error('El contexto de producto abarca todo el repositorio; omite --module.'); }
      const store = await openStore(options.db);
      try {
        const snapshot = store.getLatestSnapshot();
        if (!snapshot) {
          console.error('No hay snapshots: corre `repolead scan` primero.');
          process.exitCode = 1;
          return;
        }
        const repository = store.getRepository(snapshot.repositoryId)!;
        const { config } = loadConfig(repository.rootPath);
        const analysisMode = options.analysisMode ?? config.analysis_mode;
        const budget = analysisBudget(config, options.contextTokens, options.batchSize);

        if (options.dryRun) {
          if (options.audience !== 'technical' && !options.module) {
            if (analysisMode === 'entrypoints') {
              console.log('Producto: análisis de usecases/pages y documentación indexada; sin generaciones documentales ni globales.');
            } else {
            const documents = store.listDocuments(snapshot.id);
            const parts = documents.reduce((count, document) => count + buildDocumentPacks(document, budget.maxTokens, budget.maxSourceLinesPerPack, analysisMode === 'files' ? budget.filePackBytes : undefined).length, 0);
            console.log(`Producto: ${documents.length} documentos · ${parts} secciones · ${analysisMode === 'files' ? 'solo primera ronda documental, sin contexto global' : `hasta ${documents.length} síntesis documentales + 1 contexto de producto`}.`);
            }
          }
          if (options.audience === 'product') { return; }
          if (analysisMode === 'entrypoints') {
            const plan = planEntryPointAnalysis({ store, snapshotId: snapshot.id, budget, moduleFilter: options.module });
            console.log(`Modo entrypoints: ${plan.targets.filter((target) => target.kind === 'usecase').length} usecases · ${plan.targets.filter((target) => target.kind === 'page').length} pages.`);
            console.log(`Plan sin caché: ${plan.targets.length} análisis. Sin análisis propios para DTOs, helpers, hooks, componentes ni tests; sin síntesis. Todo el código sigue indexado.`);
            for (const target of plan.targets) { console.log(`− ${target.kind}: ${target.name} · ${target.path}`); }
            return;
          }
          if (analysisMode === 'files') {
            const plan = planFileAnalysis({ store, snapshotId: snapshot.id, budget, moduleFilter: options.module });
            const parts = plan.plans.reduce((n, entry) => n + entry.packs.length, 0);
            const merges = plan.plans.filter((entry) => entry.packs.length > 1).length;
            console.log(`Modo files: ${plan.symbolsCovered} símbolos cubiertos en ${plan.files.length} archivos · ${plan.sourceLines} líneas completas.`);
            console.log(`Plan base sin caché: ${parts} secciones + ${merges} archivos divididos + primera ronda en ${plan.modules.length} módulos. Sin rondas 2.x ni briefs globales; el número de grupos se calcula antes de cada primera ronda.`);
            console.log(`Paquetes de hasta ${budget.filePackBytes} bytes y ${budget.maxTokens} tokens; se divide el código, sin descartar el final. No se llama al modelo en dry-run.`);
            return;
          }
          const allModules = store.listModules(snapshot.id);
          const modules = allModules.filter((module) => !options.module || module.name === options.module || module.path === options.module);
          if (options.module && modules.length !== 1) { throw new Error('Módulo desconocido o ambiguo; usa su ruta.'); }
          const ids = new Set(modules.map((module) => module.id));
          const graph = store.loadGraph(snapshot.id);
          const symbols = [...graph.symbols.values()].filter((symbol) => ids.has(owningModule(symbol.path, allModules)?.id ?? ''));
          const selection = selectSymbols(store, snapshot.id, symbols, config.symbol_selection);
          console.log(`Selección: ${selection.selected.length} fichas; ${selection.skipped.length} símbolos privados triviales cubiertos por dossier de archivo.`);
          const allFiles = listSourceFiles(store, snapshot.id);
          const files = technicalFiles(store, snapshot.id, allFiles).filter((file) => ids.has(owningModule(file.path, allModules)?.id ?? ''));
          const dependencies = buildDependencyIndex(store, snapshot.id, graph, allFiles);
          console.log(`Plan sin caché: ${selection.selected.length} fichas + ${files.length} archivos + ${modules.length} módulos + ${options.module ? 0 : 1} brief.`);
          console.log(`Agrupación: hasta ${budget.batchSize} análisis independientes por llamada; los lotes se separan por nivel y límite de entrada.`);
          console.log(`Invalidación: hasta ${budget.maxReanalysisDepth} saltos de dependencias; la síntesis archivo → módulo → brief siempre se actualiza.`);
          console.log('Cada análisis puede requerir hasta 3 intentos de validación. No se ejecutan llamadas en dry-run.');
          let sourceTokens = 0;
          let omittedSourceLines = 0;
          for (const symbol of selection.selected) {
            const { pack } = buildSymbolPack(store, snapshot.id, repository.rootPath, symbol, budget.maxTokens, budget.maxSourceLinesPerPack, graph, dependencies, budget.maxReanalysisDepth);
            sourceTokens += countTokens(JSON.stringify(pack));
            omittedSourceLines += pack.truncation.omittedSourceLines;
          }
          console.log(`Fichas: ${sourceTokens} tokens de evidencia en total · ${omittedSourceLines} líneas fuente omitidas/no disponibles.`);
          console.log('Paquetes estructurales de módulo (las síntesis finales también incorporan los dossiers hijos):');
          for (const module of modules) {
            const pack = buildModuleEvidencePack(store, snapshot.id, module, { ...budget, maxTokens: Math.max(256, Math.floor(budget.maxTokens / 2)) }, dependencies);
            const size = JSON.stringify(pack).length;
            const dropped = pack.truncation.droppedSymbols;
            console.log(
              `− ${module.name.padEnd(20)} ${String(pack.symbols.length).padStart(3)} símbolos · ${String(size).padStart(7)} caracteres · ${countTokens(JSON.stringify(pack))} tokens${dropped > 0 ? ` · ${dropped} símbolos omitidos` : ''} · ${pack.truncation.droppedEdges} relaciones omitidas`,
            );
          }
          return;
        }

        const model = await pickModel(options.backend ?? config.model.backend, options.model ?? config.model.name, config.local_model);
        console.log(`backend: ${backendLabel(model)} · modelo: ${model.name}`);

        if (options.audience !== 'product') {
          const result = await analyzeSnapshot({
            ...await pickAnalysisRouting(config, model),
            analysisMode,
            store,
            snapshotId: snapshot.id,
            model,
            moduleFilter: options.module,
            budget,
            onProgress: (progress) => {
              const mark = progress.outcome === 'cached' ? '\u21ba' : '\u2713';
              const detail =
                progress.outcome === 'cached' ? 'desde cach\u00e9' : `${(progress.durationMs / 1000).toFixed(0)}s`;
              console.log(`${mark} [${progress.index}/${progress.total}] ${progress.subject} \u00b7 ${detail}`);
            },
          });

          console.log(`✓ símbolos: ${result.symbolsAnalyzed} analizados, ${result.symbolsCached} desde caché`);
          console.log(`✓ ${analysisMode === 'entrypoints' ? 'usecases/pages' : 'archivos'}: ${result.filesAnalyzed} analizados, ${result.filesCached} desde caché`);
          console.log(`✓ módulos: ${result.modulesAnalyzed} analizados, ${result.modulesCached} desde caché`);
          if (result.briefGenerated || result.briefCached) {
            console.log(`✓ Repository Brief ${result.briefCached ? 'desde caché' : 'generado'}`);
          }
          console.log(`  omitidos como ficha: ${result.symbolsSkipped} · tokens locales: ${result.localInputTokens} in / ${result.localOutputTokens} out (incluidos en el total)`);
          console.log(`  tokens: ${result.inputTokens} in / ${result.outputTokens} out`);
        }
        if (options.audience !== 'technical' && !options.module) {
          await analyzeProductAndPrint({ store, snapshotId: snapshot.id, model, analysisMode, budget,
            onProgress: (progress) => console.log(`${progress.outcome === 'cached' ? '↺' : '✓'} [${progress.index}/${progress.total}] ${progress.subject}`) });
        }
      } finally { store.close(); }
    });
}
