import type { Module } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';

export interface AnalysisBudget {
  maxSymbolsPerPack: number;
  maxEdgesPerPack: number;
}

export const DEFAULT_BUDGET: AnalysisBudget = {
  maxSymbolsPerPack: 50,
  maxEdgesPerPack: 200,
};

export interface ModuleEvidencePack {
  module: { name: string; path: string };
  files: { path: string; language: string | null; lineCount: number | null; commitCount: number }[];
  symbols: {
    qualifiedName: string;
    kind: string;
    signature: string | null;
    path: string;
    fanIn: number;
  }[];
  internalEdges: { from: string; to: string; type: string }[];
  incomingDependencies: string[];
  outgoingDependencies: string[];
  tests: { path: string; name: string }[];
  coChanges: { file: string; with: string; count: number }[];
  truncation: { droppedSymbols: number; droppedEdges: number };
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  edge_type: string;
}

function isInModule(path: string, moduleDir: string): boolean {
  return moduleDir === '.' || path === moduleDir || path.startsWith(`${moduleDir}/`);
}

/**
 * Ensambla el evidence pack de un módulo desde SQLite, aplicando el
 * presupuesto: los símbolos con menos fan-in se descartan primero y el
 * recorte queda explícito en `truncation` (regla 5 del plan).
 */
export function buildModuleEvidencePack(
  store: KnowledgeStore,
  snapshotId: string,
  module: Module,
  budget: AnalysisBudget = DEFAULT_BUDGET,
): ModuleEvidencePack {
  const allSymbols = store
    .listSymbols(snapshotId)
    .filter((symbol) => isInModule(symbol.path, module.path));
  const symbolIds = new Set(allSymbols.map((symbol) => symbol.id));

  const fanIn = new Map<string, number>();
  const edgeRows = store.db
    .prepare('SELECT source_id, target_id, edge_type FROM edges WHERE snapshot_id = ?')
    .all(snapshotId) as EdgeRow[];
  for (const edge of edgeRows) {
    if (symbolIds.has(edge.target_id)) {
      fanIn.set(edge.target_id, (fanIn.get(edge.target_id) ?? 0) + 1);
    }
  }

  const rankedSymbols = [...allSymbols].sort(
    (left, right) => (fanIn.get(right.id) ?? 0) - (fanIn.get(left.id) ?? 0),
  );
  const keptSymbols = rankedSymbols.slice(0, budget.maxSymbolsPerPack);
  const keptIds = new Set(keptSymbols.map((symbol) => symbol.id));
  const symbolName = new Map(allSymbols.map((symbol) => [symbol.id, symbol.qualifiedName]));

  const internalEdges: ModuleEvidencePack['internalEdges'] = [];
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  let droppedEdges = 0;
  for (const edge of edgeRows) {
    const sourceIn = symbolIds.has(edge.source_id);
    const targetIn = symbolIds.has(edge.target_id);
    if (sourceIn && targetIn) {
      if (!keptIds.has(edge.source_id) || !keptIds.has(edge.target_id)) {
        continue;
      }
      if (internalEdges.length >= budget.maxEdgesPerPack) {
        droppedEdges += 1;
        continue;
      }
      internalEdges.push({
        from: symbolName.get(edge.source_id) ?? edge.source_id,
        to: symbolName.get(edge.target_id) ?? edge.target_id,
        type: edge.edge_type,
      });
    } else if (targetIn && !sourceIn && !edge.source_id.startsWith('module://')) {
      incoming.add(edge.source_id);
    } else if (sourceIn && !targetIn && !edge.target_id.startsWith('module://')) {
      outgoing.add(edge.target_id);
    }
  }

  const files = (
    store.db
      .prepare('SELECT path, language, line_count, last_author FROM files WHERE snapshot_id = ?')
      .all(snapshotId) as { path: string; language: string | null; line_count: number | null }[]
  ).filter((file) => isInModule(file.path, module.path));

  const commitCounts = new Map<string, number>();
  const metricRows = store.db
    .prepare("SELECT subject_id, value FROM metrics WHERE snapshot_id = ? AND name = 'commit_count'")
    .all(snapshotId) as { subject_id: string; value: number }[];
  for (const metric of metricRows) {
    commitCounts.set(metric.subject_id.slice(metric.subject_id.indexOf('/', 7) + 1), metric.value);
  }

  const tests = (
    store.db.prepare('SELECT path, name FROM tests WHERE snapshot_id = ?').all(snapshotId) as {
      path: string;
      name: string;
    }[]
  ).filter((test) => isInModule(test.path, module.path));

  const coChanges = (
    store.db
      .prepare(
        "SELECT subject_id, name, value FROM metrics WHERE snapshot_id = ? AND name LIKE 'co_change:%'",
      )
      .all(snapshotId) as { subject_id: string; name: string; value: number }[]
  )
    .map((row) => ({
      file: row.subject_id.slice(row.subject_id.indexOf('/', 7) + 1),
      with: row.name.slice('co_change:'.length),
      count: row.value,
    }))
    .filter((entry) => isInModule(entry.file, module.path) || isInModule(entry.with, module.path));

  return {
    module: { name: module.name, path: module.path },
    files: files.map((file) => ({
      path: file.path,
      language: file.language,
      lineCount: file.line_count,
      commitCount: commitCounts.get(file.path) ?? 0,
    })),
    symbols: keptSymbols.map((symbol) => ({
      qualifiedName: symbol.qualifiedName,
      kind: symbol.kind,
      signature: symbol.signature,
      path: symbol.path,
      fanIn: fanIn.get(symbol.id) ?? 0,
    })),
    internalEdges,
    incomingDependencies: [...incoming].sort(),
    outgoingDependencies: [...outgoing].sort(),
    tests,
    coChanges,
    truncation: {
      droppedSymbols: allSymbols.length - keptSymbols.length,
      droppedEdges,
    },
  };
}
