import type { Command } from 'commander';

import { fileUri } from '@repolead/domain';
import type { SummaryDoc } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

export function registerBrief(program: Command): void {
  program
    .command('brief')
    .description('Lee el brief, dossier de archivo/módulo o ficha de símbolo ya generado')
    .option('--db <path>', 'ruta del archivo SQLite', '.repolead/repolead.db')
    .option('--module <name>', 'muestra el dossier de este módulo en vez del brief')
    .option('--file <path>', 'muestra el dossier de un archivo indexado')
    .option('--symbol <name>', 'muestra la ficha de un símbolo por nombre exacto o ID')
    .option('--product', 'muestra el contexto de producto precalculado')
    .option('--document <path>', 'muestra la ficha de un documento indexado')
    .option('--json', 'salida JSON cruda')
    .action(async (options: { db: string; module?: string; file?: string; symbol?: string; product?: boolean; document?: string; json?: boolean }) => {
      if ([options.module, options.file, options.symbol, options.product, options.document].filter(Boolean).length > 1) {
        throw new Error('Usa solo uno de --module, --file, --symbol, --product o --document.');
      }
      const store = await openStore(options.db);
      try {
      const snapshot = store.getLatestSnapshot();
      if (!snapshot) {
        console.error('No hay snapshots: corre `repolead scan` primero.');
        process.exitCode = 1;
        return;
      }

      let summary: SummaryDoc | null;
      if (options.product) {
        summary = store.listSummaries(snapshot.id, 'product').find((entry) => !entry.subjectId.includes('#synthesis:')) ?? null;
      } else if (options.document) {
        const document = store.listDocuments(snapshot.id).find((entry) => entry.path === options.document);
        if (!document) { throw new Error('Documento no indexado; comprueba documentation.paths y ejecuta refresh.'); }
        summary = store.getSummary(snapshot.id, document.id, 'document');
      } else if (options.module) {
        const matches = store.listModules(snapshot.id).filter((entry) => entry.name === options.module || entry.path === options.module);
        if (matches.length !== 1) {
          throw new Error(`Módulo desconocido o ambiguo: ${options.module}. Usa su ruta.`);
        }
        summary = store.getSummary(snapshot.id, matches[0]!.id, 'module');
      } else if (options.symbol) {
        const matches = store.listSymbols(snapshot.id).filter((entry) => entry.id === options.symbol || entry.qualifiedName === options.symbol);
        if (matches.length !== 1) { throw new Error('Símbolo desconocido o ambiguo; usa su ID.'); }
        summary = store.getSummary(snapshot.id, matches[0]!.id, 'symbol');
      } else if (options.file) {
        const repo = store.getRepository(snapshot.repositoryId)!;
        summary = store.getSummary(snapshot.id, fileUri(repo.name, options.file), 'file');
      } else {
        summary = store.listSummaries(snapshot.id, 'repository').find((entry) => !entry.subjectId.includes('#synthesis:')) ?? null;
      }

      if (!summary) {
        console.error('No hay análisis para este objetivo en el snapshot actual: corre `repolead analyze`.');
        process.exitCode = 1;
        return;
      }

      const content = JSON.parse(summary.contentJson) as Record<string, unknown>;
      if (options.json) {
        console.log(JSON.stringify(content, null, 2));
        return;
      }

      console.log(`# ${options.module ?? options.file ?? options.symbol ?? options.document ?? (options.product ? 'Product Context' : 'Repository Brief')} · ${summary.model} · ${summary.createdAt}\n`);
      for (const [section, value] of Object.entries(content)) {
        console.log(`## ${section}`);
        if (typeof value === 'string') {
          console.log(value);
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string') {
              console.log(`- ${item}`);
            } else {
              const entry = item as { claim?: string; severity?: string; evidence?: string[]; evidenceIds?: string[] };
              console.log(`- ${entry.severity ? `[${entry.severity}] ` : ''}${entry.claim ?? JSON.stringify(item)}`);
              for (const evidence of entry.evidenceIds ?? entry.evidence ?? []) {
                console.log(`  · ${evidence}`);
              }
            }
          }
        } else {
          console.log(JSON.stringify(value, null, 2));
        }
        console.log('');
      }
      } finally { store.close(); }
    });
}
