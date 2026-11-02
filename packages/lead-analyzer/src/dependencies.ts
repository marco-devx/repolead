import { contentHash, DEPENDENCY_EDGE_TYPES } from '@repolead/domain';
import type { SourceFile } from '@repolead/domain';
import type { CodeGraph, KnowledgeStore } from '@repolead/knowledge-store';

export function validateReanalysisDepth(value = 3): number {
  if (!Number.isInteger(value) || value < 0 || value > 32) { throw new Error('maxReanalysisDepth must be an integer between 0 and 32.'); }
  return value;
}

/** Stable per-snapshot dependency views shared by every level of an analysis. */
export function buildDependencyIndex(store: KnowledgeStore, snapshotId: string, graph: CodeGraph, files: SourceFile[]) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const facts = new Map<string, { id: string; path: string; name: string; kind: string; contentHash: string; signature?: string | null }>();
  for (const file of files) { facts.set(file.id, { id: file.id, path: file.path, name: file.path, kind: 'file', contentHash: file.contentHash }); }
  for (const symbol of graph.symbols.values()) {
    facts.set(symbol.id, { id: symbol.id, path: symbol.path, name: symbol.qualifiedName, kind: symbol.kind,
      contentHash: symbol.contentHash, signature: symbol.signature });
  }
  for (const test of store.listTests(snapshotId)) {
    facts.set(test.id, { id: test.id, path: test.path, name: test.name, kind: 'test',
      contentHash: test.contentHash ?? byPath.get(test.path)?.contentHash ?? '' });
  }
  const mapped = new Set((store.db.prepare('SELECT DISTINCT target_id FROM symbol_references WHERE snapshot_id = ? AND is_definition = 1')
    .all(snapshotId) as { target_id: string }[]).map((row) => row.target_id));
  const outgoing = (id: string) => {
    const direct = (graph.outgoing.get(id) ?? []).filter((edge) => DEPENDENCY_EDGE_TYPES.has(edge.edgeType));
    const symbol = graph.symbols.get(id);
    const file = symbol && !mapped.has(id) ? byPath.get(symbol.path) : null;
    return [...direct, ...(file ? (graph.outgoing.get(file.id) ?? []).filter((edge) => edge.edgeType === 'IMPORTS') : [])];
  };
  const cache = new Map<string, ReturnType<typeof collect>>();
  function collect(subjectIds: string[], requestedDepth = 3) {
    const maxDepth = validateReanalysisDepth(requestedDepth);
    const seen = new Set(subjectIds);
    let frontier = [...seen];
    const dependencies: (NonNullable<ReturnType<typeof facts.get>> & { distance: number })[] = [];
    const topology: string[][] = [];
    const unresolved = new Set<string>();
    for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of outgoing(id)) {
          topology.push([id, edge.targetId, edge.edgeType, edge.analyzer]);
          if (seen.has(edge.targetId)) { continue; }
          seen.add(edge.targetId);
          const target = facts.get(edge.targetId);
          if (target) { dependencies.push({ ...target, distance: depth }); next.push(edge.targetId); }
          else { unresolved.add(edge.targetId); }
        }
      }
      frontier = next;
    }
    const boundary = new Set(frontier.flatMap((id) => outgoing(id).map((edge) => edge.targetId)).filter((id) => !seen.has(id)));
    dependencies.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    const fallback = subjectIds.some((id) => graph.symbols.has(id) && !mapped.has(id));
    return { maxDepth, resolution: fallback ? 'file-import-fallback' as const : 'indexed-dependencies' as const,
      fingerprint: contentHash(JSON.stringify({ maxDepth, dependencies, topology: topology.sort(), unresolved: [...unresolved].sort(), boundary: [...boundary].sort() })),
      dependencies, unresolvedTargets: unresolved.size, beyondDepth: boundary.size };
  }
  return {
    forSubjects(subjectIds: string[], maxDepth = 3) {
      const ids = [...new Set(subjectIds)].sort();
      const key = JSON.stringify([ids, maxDepth]);
      let result = cache.get(key);
      if (!result) { result = collect(ids, maxDepth); cache.set(key, result); }
      return result;
    },
  };
}

export type DependencyIndex = ReturnType<typeof buildDependencyIndex>;
