import { existsSync } from 'node:fs';

import { QUALITY_TOOLS } from '@repolead/adapter-quality';
import type { QualityTool } from '@repolead/adapter-quality';
import { collectQuality } from '@repolead/code-graph';
import { loadConfig } from '@repolead/config';
import { openStore } from '@repolead/knowledge-store';
import type { Command } from 'commander';

export function registerMetrics(program: Command): void {
  program.command('metrics').description('Consulta métricas y ejecuta los analizadores opcionales configurados; importa cobertura LCOV')
    .option('--db <path>', 'base indexada', '.repolead/repolead.db')
    .option('--tools <names>', 'jscpd,ruff,radon (lista separada por comas; none solo consulta)')
    .option('--coverage <path>', 'reporte LCOV existente; rutas SF relativas a la raíz del repo')
    .option('--json', 'métricas, issues, cobertura y diagnósticos completos')
    .action(async (options: { db: string; tools?: string; coverage?: string; json?: boolean }) => {
      if (!existsSync(options.db)) { throw new Error('No existe la base: ejecuta scan primero.'); }
      const store = await openStore(options.db);
      try {
        const snapshot = store.getLatestSnapshot();
        if (!snapshot) { throw new Error('No hay snapshots: ejecuta scan primero.'); }
        const repository = store.getRepository(snapshot.repositoryId)!;
        const config = loadConfig(repository.rootPath).config;
        const names = options.tools === undefined ? config.metrics.tools : options.tools === 'none' ? [] : options.tools.split(',').map((name) => name.trim());
        if (names.some((name) => !(QUALITY_TOOLS as readonly string[]).includes(name))) { throw new Error('Analizador inválido: usa jscpd,ruff,radon o none.'); }
        const coveragePath = options.coverage ?? (options.tools === 'none' ? undefined : config.metrics.coverage);
        const execution = names.length || coveragePath ? await collectQuality({ store, snapshotId: snapshot.id, tools: names as QualityTool[], coveragePath }) : null;
        const report = { snapshotId: snapshot.id, execution,
          status: JSON.parse(store.getSnapshotMetadata(snapshot.id, 'metrics_status') ?? '{"status":"unknown"}') as unknown,
          metrics: store.listMetrics(snapshot.id), issues: store.listQualityIssues(snapshot.id), coverage: store.listCoverage(snapshot.id) };
        if (options.json) { console.log(JSON.stringify(report, null, 2)); }
        else {
          console.log(`${report.metrics.length} métricas · ${report.issues.length} incidencias de herramientas · ${report.coverage.length} archivos con cobertura importada`);
          console.log(JSON.stringify({ status: report.status, execution }, null, 2));
          console.log('Usa --json para el detalle. Sin reporte, la cobertura es desconocida; los vínculos de tests no miden cobertura.');
        }
        if (execution && (Object.values(execution.tools).some((tool) => ['failed', 'unavailable'].includes(tool.status)) || execution.coverage?.status === 'failed')) { process.exitCode = 1; }
      } finally { store.close(); }
    });
}
