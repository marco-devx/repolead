import type { Command } from 'commander';
import { existsSync } from 'node:fs';

import { openStore } from '@repolead/knowledge-store';

import { runDoctorChecks } from '../doctor/checks';
import { formatDoctorReport } from '../doctor/format';

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Verifica los binarios y servicios que RepoLead necesita')
    .option('--db <path>', 'inspeccionar diagnósticos de extracción y reconciliación del último snapshot')
    .option('--json', 'reporte estructurado completo')
    .action(async (options: { db?: string; json?: boolean }) => {
      const results = await runDoctorChecks();
      const report = formatDoctorReport(results);
      let indexed: { snapshotId: string; extraction: unknown[]; metrics: unknown; scip: { indexers: unknown[]; reconciliation: unknown[] } } | null = null;
      if (options.db) {
        if (!existsSync(options.db)) { throw new Error('La base indicada no existe.'); }
        const store = await openStore(options.db);
        try {
          const snapshot = store.getLatestSnapshot();
          if (!snapshot) { throw new Error('La base no tiene snapshots.'); }
          indexed = { snapshotId: snapshot.id,
            metrics: JSON.parse(store.getSnapshotMetadata(snapshot.id, 'metrics_status') ?? '{"status":"unknown"}') as unknown,
            extraction: JSON.parse(store.getSnapshotMetadata(snapshot.id, 'extraction_diagnostics') ?? '[]') as unknown[],
            scip: JSON.parse(store.getSnapshotMetadata(snapshot.id, 'scip_diagnostics') ?? '{"indexers":[],"reconciliation":[]}') as { indexers: unknown[]; reconciliation: unknown[] } };
        } finally { store.close(); }
      }
      if (options.json) { console.log(JSON.stringify({ healthy: report.healthy, environment: results, indexed }, null, 2)); }
      else {
        console.log(report.text);
        if (indexed) {
          console.log(`Métricas: ${JSON.stringify(indexed.metrics)}`);
          console.log(`\nSnapshot ${indexed.snapshotId}: ${indexed.extraction.length} notas de extracción · ${indexed.scip.reconciliation.length} definiciones sin reconciliar`);
          for (const entry of indexed.scip.indexers) { console.log(JSON.stringify(entry)); }
          for (const entry of [...indexed.extraction, ...indexed.scip.reconciliation].slice(0, 20)) { console.log(JSON.stringify(entry)); }
          if (indexed.extraction.length + indexed.scip.reconciliation.length > 20) { console.log('Mostrando 20 diagnósticos; usa --json para el detalle completo.'); }
        }
      }
      if (!report.healthy) {
        process.exitCode = 1;
      }
    });
}
