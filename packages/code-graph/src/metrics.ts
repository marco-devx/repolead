import type { CodeSymbol, Edge, Metric, Module, SourceFile } from '@repolead/domain';

export const GRAPH_METRICS_ANALYZER = 'observed-graph-metrics-v1';
const referenceTypes = new Set(['CALLS', 'DEPENDS_ON', 'EXTENDS', 'IMPLEMENTS']);

/** Deduplicate callers/targets; a CALLS and a DEPENDS_ON edge must not count twice. */
export function graphMetrics(snapshotId: string, symbols: CodeSymbol[], files: SourceFile[], modules: Module[], edges: Edge[]): Metric[] {
  const metrics: Metric[] = [];
  const add = (subjectId: string, name: string, value: number) => metrics.push({ snapshotId, subjectId, name, value, analyzer: GRAPH_METRICS_ANALYZER });
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const fileIds = new Map(files.map((file) => [file.path, file.id]));
  const fileById = new Map(files.map((file) => [file.id, file]));
  const owner = new Map(files.map((file) => [file.id, modules.filter((module) => module.path === '.' || file.path.startsWith(`${module.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]?.id]));
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  const connect = (map: Map<string, Set<string>>, from: string, to: string) => {
    const set = map.get(from) ?? new Set<string>(); set.add(to); map.set(from, set);
  };
  const fileEdges = new Map<string, [string, string]>();
  const testLinks = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.edgeType === 'TESTED_BY') { connect(testLinks, edge.sourceId, edge.targetId); }
    if (referenceTypes.has(edge.edgeType) && edge.sourceId !== edge.targetId) {
      connect(outgoing, edge.sourceId, edge.targetId); connect(incoming, edge.targetId, edge.sourceId);
      const source = byId.get(edge.sourceId); const target = byId.get(edge.targetId);
      const from = source ? fileIds.get(source.path) : fileById.has(edge.sourceId) ? edge.sourceId : null;
      const to = target ? fileIds.get(target.path) : fileById.has(edge.targetId) ? edge.targetId : null;
      if (from && to && from !== to) { fileEdges.set(`${from}\n${to}`, [from, to]); }
    }
    if (edge.edgeType === 'IMPORTS' && edge.sourceId !== edge.targetId) { fileEdges.set(`${edge.sourceId}\n${edge.targetId}`, [edge.sourceId, edge.targetId]); }
  }
  for (const symbol of symbols) {
    add(symbol.id, 'fan_in', incoming.get(symbol.id)?.size ?? 0);
    add(symbol.id, 'fan_out', outgoing.get(symbol.id)?.size ?? 0);
    const file = fileIds.get(symbol.path);
    add(symbol.id, 'file_test_links', file ? testLinks.get(file)?.size ?? 0 : 0);
  }
  for (const file of files) {
    add(file.id, 'test_links', testLinks.get(file.id)?.size ?? 0);
  }
  for (const module of modules) {
    const own = new Set(files.filter((file) => owner.get(file.id) === module.id && ['typescript', 'javascript', 'python'].includes(file.language ?? '')).map((file) => file.id));
    const ca = new Set<string>(); const ce = new Set<string>();
    const neighbors = new Map([...own].map((id) => [id, new Set<string>()]));
    let internal = 0;
    for (const [from, to] of fileEdges.values()) {
      const source = owner.get(from); const target = owner.get(to);
      if (source === module.id && target !== module.id) { ce.add(target ?? to); }
      if (target === module.id && source && source !== module.id) { ca.add(source); }
      if (own.has(from) && own.has(to)) { neighbors.get(from)!.add(to); neighbors.get(to)!.add(from); internal += 1; }
    }
    add(module.id, 'coupling_in', ca.size); add(module.id, 'coupling_out', ce.size);
    if (ca.size + ce.size) { add(module.id, 'instability', ce.size / (ca.size + ce.size)); }
    add(module.id, 'code_files', own.size); add(module.id, 'internal_dependency_edges', internal);
    if (!own.size) { continue; }
    const seen = new Set<string>(); let components = 0; let largest = 0;
    for (const id of own) {
      if (seen.has(id)) { continue; }
      components += 1; let size = 0; const stack = [id]; seen.add(id);
      while (stack.length) {
        const current = stack.pop()!; size += 1;
        for (const target of neighbors.get(current) ?? []) { if (!seen.has(target)) { seen.add(target); stack.push(target); } }
      }
      largest = Math.max(largest, size);
    }
    add(module.id, 'dependency_components', components); add(module.id, 'largest_component_ratio', largest / own.size);
  }
  return metrics;
}
