import type { Command } from 'commander';

import { impactAnalysis, traceFlow } from '@repolead/change-analysis';
import { openStore } from '@repolead/knowledge-store';

function common(command: Command): Command {
  return command.option('--db <path>', 'base SQLite', '.repolead/repolead.db')
    .option('--max-depth <n>', 'profundidad máxima del grafo', Number, 12)
    .option('--max-nodes <n>', 'nodos máximos', Number, 500)
    .option('--max-edges <n>', 'relaciones máximas', Number, 2000)
    .option('--json', 'resultado completo con evidencia y límites');
}
interface CommonOptions { db: string; maxDepth: number; maxNodes: number; maxEdges: number; json?: boolean }

export function registerChangeAnalysis(program: Command): void {
  common(program.command('trace <from> [to]').description('Recorre llamadas estáticas desde un endpoint/símbolo hasta un objetivo o efecto registrado'))
    .option('--max-paths <n>', 'máximo de caminos mínimos devueltos', Number, 10)
    .action(async (from: string, to: string | undefined, options: CommonOptions & { maxPaths: number }) => {
      const store = await openStore(options.db);
      try {
        const snapshot = store.getLatestSnapshot();
        if (!snapshot) { throw new Error('Sin snapshot: ejecuta repolead scan primero.'); }
        const result = traceFlow(store, snapshot.id, { from, to, maxDepth: options.maxDepth, maxNodes: options.maxNodes, maxEdges: options.maxEdges, maxPaths: options.maxPaths });
        if (options.json) { console.log(JSON.stringify(result, null, 2)); }
        else if ('error' in result) { console.error(result.error); console.error(JSON.stringify(result.candidates)); }
        else {
          for (const path of result.paths) { console.log(path.nodes.map((node) => node.name).join(' → ')); }
          if (!result.paths.length) { console.log('Sin camino observado.'); }
          for (const unknown of result.unknowns) { console.log(`? ${unknown}`); }
        }
        if ('error' in result) { process.exitCode = 1; }
      } finally { store.close(); }
    });
  common(program.command('impact').description('Analiza alcance potencial, contratos, tests y riesgo de un cambio sin ejecutar el proyecto'))
    .option('--change <text>', 'descripción que nombre un identificador indexado')
    .option('--symbol <symbol>', 'símbolo por nombre/ID; repetible', (value: string, previous: string[]) => [...previous, value], [])
    .option('--path <path>', 'archivo/directorio indexado; repetible', (value: string, previous: string[]) => [...previous, value], [])
    .option('--fact <name=value>', 'dato del cambio, p. ej. schemaChange=true o reversible=false; repetible', (value: string, previous: Record<string, boolean>) => {
      const match = /^([a-zA-Z]+)=(true|false)$/.exec(value);
      if (!match) { throw new Error('Usa --fact nombre=true o nombre=false.'); }
      return { ...previous, [match[1]!]: match[2] === 'true' };
    }, {})
    .option('--offset <n>', 'offset de cada categoría de detalle', Number, 0)
    .option('--limit <n>', 'elementos por categoría', Number, 20)
    .action(async (options: CommonOptions & { change?: string; symbol: string[]; path: string[]; fact: Record<string, boolean>; offset: number; limit: number }) => {
      const store = await openStore(options.db);
      try {
        const snapshot = store.getLatestSnapshot();
        if (!snapshot) { throw new Error('Sin snapshot: ejecuta repolead scan primero.'); }
        const result = impactAnalysis(store, snapshot.id, { change: options.change, symbols: options.symbol, paths: options.path, facts: options.fact,
          maxDepth: options.maxDepth, maxNodes: options.maxNodes, maxEdges: options.maxEdges, offset: options.offset, limit: options.limit });
        if (options.json) { console.log(JSON.stringify(result, null, 2)); }
        else if ('error' in result) { console.error(result.error); console.error(JSON.stringify(result.candidates)); }
        else {
          console.log(`Impacto observado: ${result.score.observed}/100 · rango por incertidumbre ${result.score.range.minimum}–${result.score.range.maximum}`);
          console.log(`${result.affectedSymbols.total} símbolos · ${result.affectedFiles.total} archivos · ${result.affectedModules.total} módulos · ${result.relevantTests.total} tests candidatos`);
          console.log(`Workflow ${result.recommendedWorkflow.provisional ? 'provisional' : 'sugerido'}: ${result.recommendedWorkflow.agents.join(' + ')}`);
          for (const unknown of result.unknowns) { console.log(`? ${unknown}`); }
        }
        if ('error' in result) { process.exitCode = 1; }
      } finally { store.close(); }
    });
}
