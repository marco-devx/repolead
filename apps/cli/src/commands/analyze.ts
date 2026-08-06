import type { Command } from 'commander';

import { analyzeSnapshot, buildModuleEvidencePack } from '@repolead/lead-analyzer';
import { openStore } from '@repolead/knowledge-store';

import { backendLabel, pickModel } from '../model-select';

export function registerAnalyze(program: Command): void {
  program
    .command('analyze')
    .description('Genera Module Dossiers y Repository Brief con Claude como Tech Lead')
    .option('--db <path>', 'ruta del archivo SQLite', '.repolead/repolead.db')
    .option('--model <name>', 'modelo (default: claude-opus-5 en API, el default del CLI en claude-code)')
    .option('--backend <backend>', 'api | claude-code (default: api si hay credenciales)')
    .option('--module <name>', 'analiza solo este módulo')
    .option('--dry-run', 'construye los evidence packs sin llamar al modelo')
    .action(async (options: {
      db: string;
      model?: string;
      backend?: string;
      module?: string;
      dryRun?: boolean;
    }) => {
      const store = await openStore(options.db);
      const snapshot = store.getLatestSnapshot();
      if (!snapshot) {
        console.error('No hay snapshots: corre `repolead scan` primero.');
        process.exitCode = 1;
        return;
      }

      if (options.dryRun) {
        for (const module of store.listModules(snapshot.id)) {
          if (options.module && module.name !== options.module) {
            continue;
          }
          const pack = buildModuleEvidencePack(store, snapshot.id, module);
          const size = JSON.stringify(pack).length;
          const dropped = pack.truncation.droppedSymbols;
          console.log(
            `− ${module.name.padEnd(20)} ${String(pack.symbols.length).padStart(3)} símbolos · ${String(size).padStart(7)} bytes${dropped > 0 ? ` · ${dropped} descartados por presupuesto` : ''}`,
          );
        }
        store.close();
        return;
      }

      const model = pickModel(options.backend, options.model);
      console.log(`backend: ${backendLabel(model)} · modelo: ${model.name}`);

      const result = await analyzeSnapshot({
        store,
        snapshotId: snapshot.id,
        model,
        moduleFilter: options.module,
      });

      console.log(`✓ ${result.modulesAnalyzed} módulos analizados, ${result.modulesCached} desde caché`);
      if (result.briefGenerated || result.briefCached) {
        console.log(`✓ Repository Brief ${result.briefCached ? 'desde caché' : 'generado'}`);
      }
      console.log(`  tokens: ${result.inputTokens} in / ${result.outputTokens} out`);
      store.close();
    });
}
