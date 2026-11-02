import type { KnowledgeStore } from '@repolead/knowledge-store';

import { analysisGraph, DEFAULT_LIMITS, EFFECT_TYPES, limits, resolveNode, semanticStatus, traverse } from './graph';
import type { AnalysisEdge, AnalysisNode, TraversalLimits } from './graph';

export interface FlowOptions extends Partial<TraversalLimits> { from: string; to?: string; maxPaths?: number }

/** Shortest static call/effect witnesses. IMPORTS, CONTAINS and type references are never execution edges. */
export function traceFlow(store: KnowledgeStore, snapshotId: string, options: FlowOptions) {
  const budget = limits(options); const maxPaths = options.maxPaths ?? 10;
  if (!Number.isInteger(maxPaths) || maxPaths < 1 || maxPaths > 100) { throw new Error('maxPaths must be an integer from 1 to 100.'); }
  const graph = analysisGraph(store, snapshotId);
  const from = resolveNode(graph, options.from);
  if ('error' in from) { return from; }
  const to = options.to ? resolveNode(graph, options.to) : undefined;
  if (to && 'error' in to) { return to; }
  const walked = traverse([from.node.id], (id) => (graph.outgoing.get(id) ?? [])
    .filter((edge) => edge.type === 'CALLS' || EFFECT_TYPES.has(edge.type))
    .map((edge) => ({ next: edge.targetId, edge, reason: edge.type })), budget);
  const targets: { id: string; effect?: AnalysisEdge }[] = to ? [{ id: to.node.id }] : [...walked.inspected.values()]
    .filter((edge) => EFFECT_TYPES.has(edge.type) && walked.depth.has(edge.targetId)).map((edge) => ({ id: edge.sourceId, effect: edge }));
  const paths: { nodes: AnalysisNode[]; edges: AnalysisEdge[]; confidence: number }[] = [];
  // A predecessor DAG only connects depth n to n+1, so recursion/cycles cannot duplicate nodes in a path.
  for (const target of targets) {
    if (!walked.depth.has(target.id)) { continue; }
    const stack = [{ ids: target.effect ? [target.id, target.effect.targetId] : [target.id], edges: target.effect ? [target.effect] : [] as AnalysisEdge[] }];
    while (stack.length && paths.length <= maxPaths) {
      const partial = stack.pop()!; const current = partial.ids[0]!;
      if (current === from.node.id) {
        paths.push({ nodes: partial.ids.map((id) => graph.nodes.get(id)!), edges: partial.edges,
          confidence: partial.edges.reduce((minimum, edge) => Math.min(minimum, Math.max(...edge.provenance.map((proof) => proof.confidence))), 1) });
      } else {
        for (const parent of [...(walked.predecessor.get(current) ?? [])].reverse()) {
          stack.push({ ids: [parent.previous, ...partial.ids], edges: [parent.edge, ...partial.edges] });
        }
      }
    }
    if (paths.length > maxPaths) { break; }
  }
  const semantic = semanticStatus(graph);
  const pathsTruncated = paths.length > maxPaths;
  return { snapshotId, from: from.node, to: to?.node ?? null, strategy: 'shortest static paths per explicit target or recorded effect edge',
    paths: paths.slice(0, maxPaths), visitedNodes: walked.depth.size, examinedEdges: walked.inspected.size,
    confidenceMeaning: 'Minimum of the strongest stored analyzer confidence at each hop; not a runtime probability.',
    limits: { ...walked.limits, maxPaths, pathsTruncated }, indexers: semantic.indexers,
    unknowns: [...semantic.unknowns,
      'Static paths do not establish runtime execution, branch feasibility, ordering, or data flow. Longer alternative paths are not enumerated.',
      ...(walked.limits.truncated || pathsTruncated ? ['Traversal/output was bounded; missing paths cannot be interpreted as unreachable.'] : []),
      ...(!to ? ['Only recorded READS_FROM/WRITES_TO/EMITS/CONSUMES edges identify effect targets; arbitrary API calls are not classified as effects.'] : []),
      ...(!paths.length ? ['No path was observed in the selected indexed relations; this is not proof of runtime unreachability.'] : []),
    ] };
}

export const FLOW_DEFAULTS = { ...DEFAULT_LIMITS, maxPaths: 10 };
