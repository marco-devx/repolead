import { existsSync } from 'node:fs';
import type { Command } from 'commander';

import { importMutationReport, mutationPlan, mutationResults, runMutationPlan } from '@repolead/change-analysis';
import { openStore } from '@repolead/knowledge-store';

export function registerMutation(program: Command): void {
  program.command('mutation').description('Prepara mutaciones dirigidas a hotspots; solo --run ejecuta el comando de tests con Stryker')
    .option('--db <path>', 'base SQLite', '.repolead/repolead.db')
    .option('--module <name-or-path-or-id>', 'módulo propietario de los hotspots')
    .option('--limit <n>', 'hotspots seleccionados (1–20)', Number, 3)
    .option('--run', 'ejecutar realmente tests y mutaciones sobre los hotspots seleccionados')
    .option('--test-command <command>', 'comando de tests requerido con --run, p. ej. "npm test"')
    .option('--timeout-ms <n>', 'tiempo máximo de ejecución (1000–3600000)', Number, 600000)
    .option('--report <path>', 'importar un JSON de Stryker que coincida con la selección actual, sin ejecutar tests')
    .option('--results', 'leer el reporte guardado más reciente del snapshot')
    .option('--report-id <id>', 'reporte específico, con --results')
    .option('--offset <n>', 'offset de mutantes para --results', Number, 0)
    .option('--page-size <n>', 'mutantes por página para --results (1–200)', Number, 20)
    .option('--json', 'plan o resultado estructurado')
    .action(async (options: { db: string; module?: string; limit: number; run?: boolean; testCommand?: string; timeoutMs: number;
      report?: string; results?: boolean; reportId?: string; offset: number; pageSize: number; json?: boolean }) => {
      if ([options.run, options.report, options.results].filter(Boolean).length > 1) { throw new Error('Usa solo uno de --run, --report o --results.'); }
      if (options.run && !options.testCommand?.trim()) { throw new Error('--run requiere --test-command explícito.'); }
      if (options.testCommand && !options.run) { throw new Error('--test-command requiere --run; el plan por defecto no ejecuta tests.'); }
      if (options.reportId && !options.results) { throw new Error('--report-id requiere --results.'); }
      if (!existsSync(options.db)) { throw new Error('No existe la base: ejecuta scan primero.'); }
      const store = await openStore(options.db);
      try {
        const snapshot = store.getLatestSnapshot();
        if (!snapshot) { throw new Error('Sin snapshot: ejecuta scan primero.'); }
        if (options.results) {
          const report = mutationResults(store, snapshot.id, { reportId: options.reportId, offset: options.offset, limit: options.pageSize });
          console.log(JSON.stringify(report, null, 2)); return;
        }
        const plan = mutationPlan(store, snapshot.id, { module: options.module, limit: options.limit });
        if (!options.run && !options.report) {
          if (options.json) { console.log(JSON.stringify(plan, null, 2)); }
          else {
            console.log(`Plan: ${plan.targets.length} hotspots · no se ejecutaron tests`);
            for (const range of plan.mutate) { console.log(`  ${range}`); }
            for (const entry of plan.omitted) { console.log(`  omitido ${entry.symbolId}: ${entry.reason}`); }
            console.log('Ejecuta con --run --test-command "comando de tests" o importa --report archivo.json.');
          }
          return;
        }
        const result = options.run
          ? await runMutationPlan(store, plan, { testCommand: options.testCommand!, timeoutMs: options.timeoutMs })
          : importMutationReport(store, plan, options.report!);
        console.log(JSON.stringify(result, null, 2));
      } finally { store.close(); }
    });
}
