import type { CodeSymbol } from '@repolead/domain';
import { sliceSource } from '@repolead/domain';
import type { CodeGraph, KnowledgeStore } from '@repolead/knowledge-store';

export type SymbolSelection = 'all' | 'public-or-nontrivial';
const effects = new Set(['READS_FROM', 'WRITES_TO', 'EMITS', 'CONSUMES']);

export function simpleLeaf(store: KnowledgeStore, snapshotId: string, graph: CodeGraph, symbol: CodeSymbol, criticalPaths: string[] = []): boolean {
  if (!['function', 'method'].includes(symbol.kind) || symbol.route || symbol.endLine - symbol.startLine + 1 > 5) { return false; }
  if (criticalPaths.some((path) => path === '.' || symbol.path === path || symbol.path.startsWith(`${path}/`))) { return false; }
  if ((graph.outgoing.get(symbol.id) ?? []).some((edge) => effects.has(edge.edgeType) || edge.edgeType === 'CALLS')) { return false; }
  const complexity = store.db.prepare("SELECT MAX(value) AS value FROM metrics WHERE snapshot_id = ? AND subject_id = ? AND name = 'cyclomatic_complexity'").get(snapshotId, symbol.id) as { value: number | null } | undefined;
  if (complexity?.value !== 1 || !/\.[cm]?[jt]sx?$/.test(symbol.path)) { return false; }
  const source = store.getSnapshotSource(snapshotId, symbol.path);
  if (source === null) { return false; }
  const body = sliceSource(source, symbol).match(/^[^{]*\{\s*return\s+([^;{}\n]+)\s*;?\s*\}\s*$/)?.[1]?.trim();
  // The small model is restricted to literal/identity returns and simple scalar conversions.
  // Arithmetic, branching, object construction and composed calls need the primary model.
  return !!body && /^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?|[-+]?\d+(?:\.\d+)?|"[^"\\]*"|'[^'\\]*'|(?:String|Number|Boolean)\(\s*[A-Za-z_$][\w$]*\s*\))$/.test(body);
}

/** Only private, short, branch-free functions are omitted; their full source remains in file dossiers. */
export function selectSymbols(store: KnowledgeStore, snapshotId: string, symbols: CodeSymbol[], mode: SymbolSelection = 'all') {
  if (!['all', 'public-or-nontrivial'].includes(mode)) { throw new Error('Unknown symbol selection mode.'); }
  const exported = new Set(store.listExports(snapshotId).map((entry) => entry.symbolId));
  const selected: CodeSymbol[] = []; const skipped: CodeSymbol[] = [];
  for (const symbol of symbols) {
    const metric = store.db.prepare("SELECT MAX(value) AS value FROM metrics WHERE snapshot_id = ? AND subject_id = ? AND name = 'cyclomatic_complexity'").get(snapshotId, symbol.id) as { value: number | null } | undefined;
    const trivial = (symbol.kind === 'function' || (symbol.kind === 'method' && symbol.visibility === 'private')) && !symbol.route && !exported.has(symbol.id)
      && symbol.visibility !== 'public' && symbol.endLine - symbol.startLine + 1 <= 5 && metric?.value === 1;
    (mode === 'public-or-nontrivial' && trivial ? skipped : selected).push(symbol);
  }
  return { selected, skipped };
}
