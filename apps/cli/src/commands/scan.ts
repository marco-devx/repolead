import type { Command } from 'commander';

import { scanRepository } from '@repolead/code-graph';

export function registerScan(program: Command): void {
  program
    .command('scan')
    .description('Indexa el repositorio: archivos, símbolos, referencias y módulos')
    .argument('[path]', 'ruta del repositorio a escanear', '.')
    .option('--db <path>', 'ruta del archivo SQLite (por defecto: <repo>/.repolead/repolead.db)')
    .option('--name <name>', 'nombre del repositorio (por defecto: nombre del directorio)')
    .option('--no-scip', 'no ejecutar scip-typescript para resolver referencias')
    .action(async (path: string, options: { db?: string; name?: string; scip: boolean }) => {
      const result = await scanRepository({
        rootPath: path,
        dbPath: options.db,
        repositoryName: options.name,
        scip: options.scip,
      });

      const { counts } = result;
      const lines = [
        `✓ Repository fingerprinted        ${result.repositoryName} @ ${result.commitSha.slice(0, 7)}`,
        `✓ ${String(counts.files).padStart(6)} files indexed`,
        `✓ ${String(counts.symbols).padStart(6)} symbols extracted`,
        `✓ ${String(counts.edges).padStart(6)} syntactic edges`,
        result.referencesResolved === null
          ? '− SCIP no disponible (referencias sin resolver; instala @sourcegraph/scip-typescript)'
          : `✓ ${String(result.referencesResolved).padStart(6)} references resolved`,
        `✓ ${String(counts.modules).padStart(6)} modules identified`,
        `✓ ${String(counts.tests).padStart(6)} tests linked`,
        `✓ ${String(counts.metrics).padStart(6)} git metrics collected`,
        '',
        `Done in ${(result.durationMs / 1000).toFixed(1)}s — db: ${result.dbPath}`,
      ];
      console.log(lines.join('\n'));
    });
}
