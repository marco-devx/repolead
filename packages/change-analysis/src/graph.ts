import type { CodeSymbol, EdgeType } from '@repolead/domain';
import { contentHash } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';

export interface Location { path: string; startLine: number; endLine: number; startColumn?: number; endColumn?: number }
export interface AnalysisEdge {
  id: string; sourceId: string; targetId: string; type: EdgeType;
  provenance: { analyzer: string; confidence: number; locations: Location[] }[];
}
export interface AnalysisNode { id: string; name: string; kind: string; location?: Location }

/** Only location metadata leaves this API; arbitrary stored edge evidence can contain source. */
function locations(evidence: unknown): Location[] {
  if (!evidence || typeof evidence !== 'object') { return []; }
  const value = evidence as Record<string, unknown>;
  const path = value['path'];
  if (typeof path !== 'string') { return []; }
  const entries = Array.isArray(value['locations']) ? value['locations'] : [value];
  return entries.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') { return []; }
    const row = entry as Record<string, unknown>;
    const start = row['startLine'] ?? row['line'] ?? row['importLine'];
    const end = row['endLine'] ?? start;
    if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1 || typeof end !== 'number' || !Number.isSafeInteger(end) || end < start) { return []; }
    const column = row['startColumn'] ?? row['column']; const endColumn = row['endColumn'];
    return [{ path, startLine: start, endLine: end,
      ...(typeof column === 'number' && Number.isSafeInteger(column) && column >= 0 ? { startColumn: column } : {}),
      ...(typeof endColumn === 'number' && Number.isSafeInteger(endColumn) && endColumn >= 0 ? { endColumn } : {}) }];
  });
}

export function analysisGraph(store: KnowledgeStore, snapshotId: string) {
  const graph = store.loadGraph(snapshotId);
  const files = store.listFiles(snapshotId);
  const modules = store.listModules(snapshotId);
  const nodes = new Map<string, AnalysisNode>();
  for (const file of files) { nodes.set(file.id, { id: file.id, name: file.path, kind: 'file',
    location: { path: file.path, startLine: 1, endLine: Math.max(file.lineCount ?? 1, 1) } }); }
  for (const symbol of graph.symbols.values()) { nodes.set(symbol.id, { id: symbol.id, name: symbol.qualifiedName, kind: symbol.kind,
    location: { path: symbol.path, startLine: symbol.startLine, endLine: symbol.endLine,
      ...(symbol.span ? { startColumn: symbol.span.startColumn, endColumn: symbol.span.endColumn } : {}) } }); }
  const edges = new Map<string, AnalysisEdge>();
  for (const stored of [...graph.outgoing.values()].flat()) {
    for (const id of [stored.sourceId, stored.targetId]) { if (!nodes.has(id)) { nodes.set(id, { id, name: id, kind: 'external_or_unmapped' }); } }
    const id = `relation_${contentHash(JSON.stringify([stored.sourceId, stored.targetId, stored.edgeType])).slice(0, 32)}`;
    const existing = edges.get(id) ?? { id, sourceId: stored.sourceId, targetId: stored.targetId, type: stored.edgeType, provenance: [] };
    existing.provenance.push({ analyzer: stored.analyzer, confidence: stored.confidence, locations: locations(stored.evidence) });
    edges.set(id, existing);
  }
  const outgoing = new Map<string, AnalysisEdge[]>(); const incoming = new Map<string, AnalysisEdge[]>();
  for (const edge of [...edges.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    edge.provenance.sort((a, b) => a.analyzer.localeCompare(b.analyzer));
    const out = outgoing.get(edge.sourceId) ?? []; out.push(edge); outgoing.set(edge.sourceId, out);
    const into = incoming.get(edge.targetId) ?? []; into.push(edge); incoming.set(edge.targetId, into);
  }
  return { store, snapshotId, symbols: graph.symbols, nodes, files, modules, edges, outgoing, incoming };
}
export type AnalysisGraph = ReturnType<typeof analysisGraph>;

export type Selection = { node: AnalysisNode; symbol?: CodeSymbol } | { error: string; candidates: AnalysisNode[] };
export function resolveNode(graph: AnalysisGraph, selector: string): Selection {
  const exact = graph.nodes.get(selector);
  if (exact) { return { node: exact, symbol: graph.symbols.get(exact.id) }; }
  const symbols = [...graph.symbols.values()];
  for (const predicate of [
    (symbol: CodeSymbol) => symbol.qualifiedName === selector,
    (symbol: CodeSymbol) => symbol.qualifiedName.endsWith(`.${selector}`),
    (symbol: CodeSymbol) => symbol.qualifiedName.toLowerCase() === selector.toLowerCase(),
  ]) {
    const matches = symbols.filter(predicate);
    if (matches.length === 1) { return { node: graph.nodes.get(matches[0]!.id)!, symbol: matches[0]! }; }
    if (matches.length) { return { error: `Ambiguous symbol: ${selector}. Use an exact ID.`, candidates: matches.map((symbol) => graph.nodes.get(symbol.id)!) }; }
  }
  return { error: `Unknown symbol or graph node: ${selector}`, candidates: [] };
}

export interface TraversalLimits { maxDepth: number; maxNodes: number; maxEdges: number }
export const DEFAULT_LIMITS: TraversalLimits = { maxDepth: 12, maxNodes: 500, maxEdges: 2000 };
export function limits(input: Partial<TraversalLimits> = {}): TraversalLimits {
  const result = { maxDepth: input.maxDepth ?? DEFAULT_LIMITS.maxDepth,
    maxNodes: input.maxNodes ?? DEFAULT_LIMITS.maxNodes, maxEdges: input.maxEdges ?? DEFAULT_LIMITS.maxEdges };
  for (const [name, max] of [['maxDepth', 32], ['maxNodes', 5000], ['maxEdges', 20000]] as const) {
    if (!Number.isInteger(result[name]) || result[name] < (name === 'maxDepth' ? 0 : 1) || result[name] > max) { throw new Error(`${name} must be an integer from ${name === 'maxDepth' ? 0 : 1} to ${max}.`); }
  }
  return result;
}
export interface Step { next: string; edge: AnalysisEdge; reason: string; expandFile?: boolean }
export function traverse(seeds: string[], neighbors: (id: string, expandFile: boolean) => Step[], budget: TraversalLimits,
  expandedSeeds: ReadonlySet<string> = new Set()) {
  const unique = [...new Set(seeds)].sort();
  if (unique.length > budget.maxNodes) { throw new Error('The selected roots exceed maxNodes; narrow the selection or raise the limit.'); }
  const depth = new Map(unique.map((id) => [id, 0]));
  const queue = unique.map((id) => ({ id, depth: 0, expandFile: expandedSeeds.has(id) }));
  const stateKey = (id: string, expand: boolean) => JSON.stringify([id, expand]);
  const seenStates = new Set(queue.map((entry) => stateKey(entry.id, entry.expandFile)));
  const seenState = (id: string, expand: boolean) => seenStates.has(stateKey(id, true)) || (!expand && seenStates.has(stateKey(id, false)));
  const reasons = new Map(unique.map((id) => [id, 'selected']));
  const predecessor = new Map<string, { previous: string; edge: AnalysisEdge }[]>();
  const inspected = new Map<string, AnalysisEdge>();
  let nodeLimitReached = false; let depthLimitReached = false; let edgeLimitReached = false;
  for (let head = 0; head < queue.length; head += 1) {
    const { id, depth: currentDepth, expandFile } = queue[head]!;
    for (const step of neighbors(id, expandFile).sort((a, b) => a.next.localeCompare(b.next) || a.edge.id.localeCompare(b.edge.id))) {
      const previousDepth = depth.get(step.next);
      const nextExpansion = step.expandFile ?? false;
      if (currentDepth === budget.maxDepth) { if (!seenState(step.next, nextExpansion)) { depthLimitReached = true; } continue; }
      if (!inspected.has(step.edge.id) && inspected.size >= budget.maxEdges) { edgeLimitReached = true; continue; }
      inspected.set(step.edge.id, step.edge);
      if (previousDepth === undefined) {
        if (depth.size >= budget.maxNodes) { nodeLimitReached = true; continue; }
        depth.set(step.next, currentDepth + 1); reasons.set(step.next, step.reason);
      }
      if (!seenState(step.next, nextExpansion)) {
        seenStates.add(stateKey(step.next, nextExpansion));
        queue.push({ id: step.next, depth: currentDepth + 1, expandFile: nextExpansion });
      }
      if (depth.get(step.next) === currentDepth + 1) {
        const parents = predecessor.get(step.next) ?? [];
        if (!parents.some((parent) => parent.previous === id && parent.edge.id === step.edge.id)) { parents.push({ previous: id, edge: step.edge }); }
        predecessor.set(step.next, parents);
      }
    }
  }
  return { depth, predecessor, reasons, inspected, limits: { ...budget, nodeLimitReached, depthLimitReached, edgeLimitReached,
    truncated: nodeLimitReached || depthLimitReached || edgeLimitReached } };
}

export const EFFECT_TYPES: ReadonlySet<EdgeType> = new Set(['WRITES_TO', 'READS_FROM', 'EMITS', 'CONSUMES']);
export function semanticStatus(graph: AnalysisGraph): { indexers: unknown; unknowns: string[] } {
  const metadata = JSON.parse(graph.store.getSnapshotMetadata(graph.snapshotId, 'scip_diagnostics') ?? '{}') as { indexers?: { status?: string }[]; reconciliation?: unknown[] };
  const indexers = metadata.indexers ?? [];
  const syntax = JSON.parse(graph.store.getSnapshotMetadata(graph.snapshotId, 'extraction_diagnostics') ?? '[]') as unknown[];
  return { indexers, unknowns: [
    ...(!indexers.length || indexers.some((entry) => entry.status !== 'complete')
      ? ['Semantic indexing is unavailable or incomplete; absent references do not establish absence of dependencies.'] : []),
    ...(metadata.reconciliation?.length ? [`${metadata.reconciliation.length} compiler/extraction reconciliation diagnostic(s); some bindings could not be mapped.`] : []),
    ...(syntax.length ? [`${syntax.length} extraction diagnostic(s); see doctor for syntax and unsupported declarations.`] : []),
  ] };
}
