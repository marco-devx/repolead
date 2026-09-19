import { readFileSync } from 'node:fs';

import type { Command } from 'commander';

import { openStore } from '@repolead/knowledge-store';
import { benchmarkTokens, buildContextPack, validateTokenBudget } from '@repolead/retrieval';
import type { TokenBenchmarkCase } from '@repolead/retrieval';

export function tokenBudget(value: string): number {
  return validateTokenBudget(Number(value));
}

export function registerContext(program: Command): void {
  program.command('context')
    .description('Contexto compacto por tarea, con presupuesto de tokens y cobertura explícita; sin LLM')
    .argument('[query...]', 'tarea o nombres para priorizar')
    .option('--db <path>', 'base de conocimiento', '.repolead/repolead.db')
    .option('--module <name>', 'nombre o ruta del módulo')
    .option('--symbols <names...>', 'nombres exactos o IDs de los símbolos')
    .option('--tokens <n>', 'presupuesto o200k_base del texto devuelto', tokenBudget, 2000)
    .option('--source', 'incluir código completo de los símbolos objetivo si cabe')
    .option('--json', 'incluir métricas en JSON (tokens mide el campo text)')
    .action(async (query: string[], options: { db: string; module?: string; symbols?: string[]; tokens: number; source?: boolean; json?: boolean }) => {
      const store = await openStore(options.db);
      try {
        const snapshot = store.getLatestSnapshot();
        if (!snapshot) {
          throw new Error('Corre repolead scan primero.');
        }
        const pack = buildContextPack({store, snapshotId: snapshot.id, query: query.join(' '), module: options.module,
          symbols: options.symbols, maxTokens: options.tokens, includeSource: options.source});
        console.log(options.json ? JSON.stringify(pack, null, 2) : pack.text);
      } finally {
        store.close();
      }
    });

  program.command('benchmark-tokens')
    .description('Compara tokens de archivos relevantes vs. contexto con código completo, sin usar un LLM')
    .requiredOption('--cases <path>', 'JSON: [{name, symbols: [nombre o ID]}]')
    .option('--db <path>', 'base de conocimiento', '.repolead/repolead.db')
    .option('--tokens <n>', 'presupuesto por caso', tokenBudget, 2000)
    .action(async (options: { db: string; cases: string; tokens: number }) => {
      const parsed: unknown = JSON.parse(readFileSync(options.cases, 'utf8'));
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((entry: unknown) => {
        if (!entry || typeof entry !== 'object') {
          return true;
        }
        const value = entry as Record<string, unknown>;
        return typeof value['name'] !== 'string' || !Array.isArray(value['symbols']) || value['symbols'].length === 0 ||
          value['symbols'].some((symbol: unknown) => typeof symbol !== 'string') ||
          (value['module'] !== undefined && typeof value['module'] !== 'string');
      })) {
        throw new Error('Formato de casos inválido: se requiere [{name, symbols: [nombre o ID]}].');
      }
      const store = await openStore(options.db);
      try {
        const snapshot = store.getLatestSnapshot();
        if (!snapshot) {
          throw new Error('Corre repolead scan primero.');
        }
        console.log(JSON.stringify(benchmarkTokens(store, snapshot.id, parsed as TokenBenchmarkCase[], options.tokens), null, 2));
      } finally {
        store.close();
      }
    });
}
