import type { Command } from 'commander';

import { openStore } from '@repolead/knowledge-store';

export function registerBrief(program: Command): void {
  program
    .command('brief')
    .description('Muestra el Repository Brief (o el dossier de un módulo) generado por analyze')
    .option('--db <path>', 'ruta del archivo SQLite', '.repolead/repolead.db')
    .option('--module <name>', 'muestra el dossier de este módulo en vez del brief')
    .option('--json', 'salida JSON cruda')
    .action(async (options: { db: string; module?: string; json?: boolean }) => {
      const store = await openStore(options.db);
      const snapshot = store.getLatestSnapshot();
      if (!snapshot) {
        console.error('No hay snapshots: corre `repolead scan` primero.');
        process.exitCode = 1;
        return;
      }

      let row: { content_json: string; model: string; created_at: string } | undefined;
      if (options.module) {
        const module = store.listModules(snapshot.id).find((entry) => entry.name === options.module);
        if (!module) {
          console.error(`Módulo desconocido: ${options.module}`);
          console.error(`Disponibles: ${store.listModules(snapshot.id).map((entry) => entry.name).join(', ')}`);
          process.exitCode = 1;
          return;
        }
        row = store.db
          .prepare(
            "SELECT content_json, model, created_at FROM summaries WHERE snapshot_id = ? AND subject_id = ? AND level = 'module' ORDER BY created_at DESC LIMIT 1",
          )
          .get(snapshot.id, module.id) as typeof row;
      } else {
        row = store.db
          .prepare(
            "SELECT content_json, model, created_at FROM summaries WHERE snapshot_id = ? AND level = 'repository' ORDER BY created_at DESC LIMIT 1",
          )
          .get(snapshot.id) as typeof row;
      }
      store.close();

      if (!row) {
        console.error(
          options.module
            ? `El módulo ${options.module} no tiene dossier aún: corre \`repolead analyze --module ${options.module}\`.`
            : 'No hay Repository Brief aún: corre `repolead analyze` (sin --module, para que sintetice el brief).',
        );
        process.exitCode = 1;
        return;
      }

      const content = JSON.parse(row.content_json) as Record<string, unknown>;
      if (options.json) {
        console.log(JSON.stringify(content, null, 2));
        return;
      }

      console.log(`# ${options.module ?? 'Repository Brief'} · ${row.model} · ${row.created_at}\n`);
      for (const [section, value] of Object.entries(content)) {
        console.log(`## ${section}`);
        if (typeof value === 'string') {
          console.log(value);
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string') {
              console.log(`- ${item}`);
            } else {
              const entry = item as { claim?: string; severity?: string; evidence?: string[] };
              console.log(`- ${entry.severity ? `[${entry.severity}] ` : ''}${entry.claim ?? JSON.stringify(item)}`);
              for (const evidence of entry.evidence ?? []) {
                console.log(`  · ${evidence}`);
              }
            }
          }
        } else {
          console.log(JSON.stringify(value, null, 2));
        }
        console.log('');
      }
    });
}
