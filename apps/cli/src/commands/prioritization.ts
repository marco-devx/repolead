import { existsSync } from 'node:fs';
import type { Command } from 'commander';

import { improvementOpportunities, listHotspots, refreshOpportunities } from '@repolead/change-analysis';
import type { PriorityOptions } from '@repolead/change-analysis';
import { openStore } from '@repolead/knowledge-store';

export function registerPrioritization(program: Command): void {
  for (const name of ['hotspots', 'opportunities'] as const) {
    program.command(name).description(name === 'hotspots'
      ? 'Prioriza funciones con complejidad, fan-in, cambios Git y cobertura verificable'
      : 'Actualiza y consulta oportunidades con evidencia desde hallazgos confirmados y hotspots')
      .option('--db <path>', 'base SQLite', '.repolead/repolead.db')
      .option('--module <name-or-path-or-id>', 'módulo propietario exacto')
      .option('--offset <n>', 'desplazamiento del ranking', Number, 0)
      .option('--limit <n>', 'resultados por página (1–200)', Number, 10)
      .option('--json', 'factores, incertidumbre y evidencia completos')
      .action(async (options: PriorityOptions & { db: string; json?: boolean }) => {
        if (!existsSync(options.db)) { throw new Error('No existe la base: ejecuta scan primero.'); }
        const store = await openStore(options.db);
        try {
          const snapshot = store.getLatestSnapshot();
          if (!snapshot) { throw new Error('Sin snapshot: ejecuta scan primero.'); }
          // Validate selectors and bounds before materializing the projection.
          if (name === 'opportunities') { improvementOpportunities(store, snapshot.id, options); refreshOpportunities(store, snapshot.id); }
          const report = name === 'hotspots' ? listHotspots(store, snapshot.id, options) : improvementOpportunities(store, snapshot.id, options);
          if (options.json) { console.log(JSON.stringify(report, null, 2)); }
          else {
            console.log(`${report.total} ${name} · ${report.version}`);
            for (const item of report.items) {
              console.log(`${item.priority.toFixed(2)}/100 · ${'title' in item ? item.title : item.name}`);
              if ('range' in item) { console.log(`  rango por incertidumbre ${item.range.minimum}–${item.range.maximum} · ${item.location.path}:${item.location.startLine}`); }
              else { console.log(`  ${item.sourceKind}: ${item.sourceId} · ${item.evidence.length} evidencias`); }
            }
            if (report.nextOffset !== null) { console.log(`Continúa con --offset ${report.nextOffset}.`); }
            console.log('Prioridad orientativa; esfuerzo y valor de negocio desconocidos. Usa --json para revisar factores y evidencia.');
          }
        } finally { store.close(); }
      });
  }
}
