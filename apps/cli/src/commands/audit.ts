import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import { openStore } from '@repolead/knowledge-store';
import { analysisBudget, loadConfig } from '@repolead/config';
import { loadPolicies, runPolicies } from '@repolead/policy-engine';

import { backendLabel, pickModel } from '../model-select';
import { tokenBudget } from './context';

export function registerAudit(program: Command): void {
  program
    .command('audit')
    .description('Ejecuta el policy pack: detectores determinísticos + modelo generativo como juez')
    .option('--db <path>', 'ruta del archivo SQLite', '.repolead/repolead.db')
    .option('--policies <dir>', 'directorio de policies YAML', join(process.cwd(), 'policies'))
    .option('--model <name>', 'modelo para el juicio')
    .option('--backend <backend>', 'ollama (default) | api | claude-code')
    .option('--context-tokens <n>', 'presupuesto del prompt por lote de candidatos (config o 120000)', tokenBudget)
    .option('--no-judge', 'guarda los candidatos sin juicio LLM (status candidate)')
    .action(async (options: {
      db: string;
      policies: string;
      model?: string;
      backend?: string;
      judge: boolean;
      contextTokens?: number;
    }) => {
      if (!existsSync(options.policies)) {
        console.error(`No existe el directorio de policies: ${options.policies}`);
        process.exitCode = 1;
        return;
      }
      const store = await openStore(options.db);
      try {
      const snapshot = store.getLatestSnapshot();
      if (!snapshot) {
        console.error('No hay snapshots: corre `repolead scan` primero.');
        process.exitCode = 1;
        return;
      }

      const policies = loadPolicies(options.policies);
      const repository = store.getRepository(snapshot.repositoryId)!;
      const { config } = loadConfig(repository.rootPath);
      const model = options.judge ? await pickModel(options.backend ?? config.model.backend, options.model ?? config.model.name, config.local_model) : null;
      console.log(
        `${policies.length} policies · juez: ${model ? `${backendLabel(model)} (${model.name})` : 'desactivado'}`,
      );

      const result = await runPolicies({ store, snapshotId: snapshot.id, policies, model,
        maxTokens: analysisBudget(config, options.contextTokens).maxTokens,
        maxFindingsPerModule: config.analysis_budget.max_findings_per_module,
        maxEvidencePerFinding: config.analysis_budget.max_evidence_per_finding });

      console.log(
        `✓ ${result.candidates} candidatos → ${result.confirmed.length} ${result.judged ? 'confirmados' : 'guardados sin juicio'}, ${result.rejected} rechazados`,
      );
      console.log(`  caché: ${result.cachedJudgments} juicios · sin evidencia requerida: ${result.missingEvidence} · omitidos por presupuesto: ${result.omittedCandidates} candidatos / ${result.omittedEvidence} evidencias`);
      console.log(`  tokens: ${result.inputTokens} in / ${result.outputTokens} out`);
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
      } finally { store.close(); }
    });
}
