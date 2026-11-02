import { Command, Option } from 'commander';
import { analyzeDataFlow, dataFlowResults } from '@repolead/change-analysis';
import { openStore } from '@repolead/knowledge-store';

export function registerDataFlow(program: Command): void {
  program.command('dataflow <source-method> <sink-call>')
    .description('Consulta flujos Joern desde parámetros de un método hasta argumentos de una llamada; --run los calcula')
    .option('--db <path>', 'base SQLite', '.repolead/repolead.db')
    .addOption(new Option('--language <language>', 'frontend Joern').choices(['javascript', 'python']).default('javascript'))
    .option('--max-paths <n>', 'máximo de caminos', Number, 10)
    .option('--timeout-ms <n>', 'límite del proceso Joern', Number, 300000)
    .option('--run', 'ejecuta el analizador estático opcional sobre fuente capturada; no ejecuta tests')
    .action(async (sourceMethod: string, sinkCall: string, options: { db: string; language: 'javascript' | 'python'; maxPaths: number; timeoutMs: number; run?: boolean }) => {
      const store = await openStore(options.db);
      try {
        const snapshot = store.getLatestSnapshot(); if (!snapshot) { throw new Error('Sin snapshot: ejecuta scan.'); }
        const query = { sourceMethod, sinkCall, language: options.language, maxPaths: options.maxPaths, timeoutMs: options.timeoutMs };
        const result = options.run ? await analyzeDataFlow(store, snapshot.id, query) : dataFlowResults(store, snapshot.id, query, options.maxPaths);
        console.log(JSON.stringify(result, null, 2));
      } finally { store.close(); }
    });
}
