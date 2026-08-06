import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import { openStore } from '@repolead/knowledge-store';
import { loadPolicies, runPolicies } from '@repolead/policy-engine';

import { backendLabel, pickModel } from '../model-select';

export function registerAudit(program: Command): void {
  program
    .command('audit')
    .description('Ejecuta el policy pack: detectores determinísticos + Claude como juez')
    .option('--db <path>', 'ruta del archivo SQLite', '.repolead/repolead.db')
    .option('--policies <dir>', 'directorio de policies YAML', join(process.cwd(), 'policies'))
    .option('--model <name>', 'modelo para el juicio')
    .option('--backend <backend>', 'api | claude-code')
    .option('--no-judge', 'guarda los candidatos sin juicio LLM (status candidate)')
    .action(async (options: {
      db: string;
      policies: string;
      model?: string;
      backend?: string;
      judge: boolean;
    }) => {
      if (!existsSync(options.policies)) {
        console.error(`No existe el directorio de policies: ${options.policies}`);
        process.exitCode = 1;
        return;
      }
      const store = await openStore(options.db);
      const snapshot = store.getLatestSnapshot();
      if (!snapshot) {
        console.error('No hay snapshots: corre `repolead scan` primero.');
        process.exitCode = 1;
        return;
      }

      const policies = loadPolicies(options.policies);
      const model = options.judge ? pickModel(options.backend, options.model) : null;
      console.log(
        `${policies.length} policies · juez: ${model ? `${backendLabel(model)} (${model.name})` : 'desactivado'}`,
      );

      const result = await runPolicies({ store, snapshotId: snapshot.id, policies, model });

      console.log(
        `✓ ${result.candidates} candidatos → ${result.confirmed.length} ${result.judged ? 'confirmados' : 'guardados sin juicio'}, ${result.rejected} rechazados`,
      );
      for (const finding of result.confirmed) {
        const evidence = store.getEvidence(finding.id);
        console.log(
          `\n[${finding.severity.toUpperCase()}] ${finding.ruleId} (confianza ${finding.confidence.toFixed(2)})`,
        );
        console.log(`  ${finding.claim}`);
        for (const item of evidence.slice(0, 3)) {
          console.log(`  · ${item.path}${item.startLine ? `:${item.startLine}` : ''}`);
        }
      }
      store.close();
    });
}
