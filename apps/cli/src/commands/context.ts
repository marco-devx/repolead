import { readFileSync } from 'node:fs';

import type { Command } from 'commander';

import { KNOWLEDGE_KINDS } from '@repolead/domain';
import type { KnowledgeKind } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { benchmarkTokens, buildContextPack, buildEvidenceContext, indexedCollection, retrievalServices, validateTokenBudget } from '@repolead/retrieval';
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
    .option('--tokens <n>', 'presupuesto o200k_base: 120000 por defecto; máximo 120000', tokenBudget)
    .option('--source', 'incluir código completo de los símbolos objetivo si cabe')
    .option('--no-source', 'excluir código crudo, también en modo evidencia')
    .option('--evidence', 'buscar y reunir fragmentos citados y memoria en una sola respuesta')
    .option('--questions <path>', 'JSON con 1–8 consultas; activa evidencia y reemplaza query')
    .option('--types <kinds>', 'en evidencia: symbol,summary,document,finding,test separados por coma')
    .option('--include-tests', 'incluir tests en la búsqueda de evidencia')
    .option('--known-blocks <path>', 'JSON de recibos SHA-256 aún disponibles en la conversación; [] activa recibos, requiere --evidence')
    .option('--json', 'incluir métricas en JSON (tokens mide el campo text)')
    .action(async (query: string[], options: { db: string; module?: string; symbols?: string[]; tokens?: number; source?: boolean; json?: boolean;
      evidence?: boolean; questions?: string; types?: string; includeTests?: boolean; knownBlocks?: string }) => {
      const store = await openStore(options.db);
      try {
        const snapshot = store.getLatestSnapshot();
        if (!snapshot) {
          throw new Error('Corre repolead scan primero.');
        }
        let pack;
        if (options.evidence || options.questions) {
          if (options.symbols?.length || (options.questions && query.length)) { throw new Error('Evidencia acepta query o --questions, sin --symbols.'); }
          const queries: unknown = options.questions ? JSON.parse(readFileSync(options.questions, 'utf8')) : [query.join(' ')];
          const knownBlocks: unknown = options.knownBlocks ? JSON.parse(readFileSync(options.knownBlocks, 'utf8')) : undefined;
          if (knownBlocks !== undefined && (!Array.isArray(knownBlocks) || knownBlocks.some((value) => typeof value !== 'string'))) { throw new Error('--known-blocks requiere un array JSON de recibos SHA-256.'); }
          if (!Array.isArray(queries) || queries.some((value) => typeof value !== 'string')) { throw new Error('--questions requiere un array JSON de textos.'); }
          const types = options.types?.split(',');
          if (types && (!types.length || types.some((type) => !KNOWLEDGE_KINDS.includes(type as KnowledgeKind)))) { throw new Error('Tipos de conocimiento inválidos.'); }
          const modules = options.module ? store.listModules(snapshot.id).filter((module) => [module.id, module.name, module.path].includes(options.module!)) : [];
          if (options.module && modules.length !== 1) { throw new Error('Módulo desconocido o ambiguo; usa su ruta exacta.'); }
          pack = await buildEvidenceContext({ store, snapshotId: snapshot.id, collection: indexedCollection(store, snapshot.id),
            queries, maxTokens: options.tokens, types: types as KnowledgeKind[] | undefined, filters: { module: modules[0]?.path },
            includeSource: options.source ?? true, includeTests: options.includeTests, knownBlocks: knownBlocks as string[] | undefined, ...await retrievalServices() });
        } else {
          if (options.types || options.includeTests || options.knownBlocks) { throw new Error('--types/--include-tests/--known-blocks requieren --evidence.'); }
          pack = buildContextPack({store, snapshotId: snapshot.id, query: query.join(' '), module: options.module,
            symbols: options.symbols, maxTokens: options.tokens, includeSource: options.source});
        }
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
