import { posix } from 'node:path';

import type { CodeSymbol, EdgeType } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';

import { analysisGraph, EFFECT_TYPES, limits, resolveNode, semanticStatus, traverse } from './graph';
import type { AnalysisGraph, AnalysisNode, Step, TraversalLimits } from './graph';

export interface ChangeFacts {
  publicApiChange?: boolean; schemaChange?: boolean; contractChange?: boolean;
  authorizationChange?: boolean; concurrencyChange?: boolean; externalEffects?: boolean;
  persistenceChange?: boolean; reversible?: boolean;
}
export interface ImpactOptions extends Partial<TraversalLimits> {
  change?: string; symbols?: string[]; paths?: string[]; facts?: ChangeFacts;
  offset?: number; limit?: number;
}
export interface ImpactFactor {
  id: string; weight: number; points: number | null; maximum: number;
  status: 'observed' | 'provided' | 'reported' | 'unknown';
  value: number | boolean | null; reason: string;
}
const REVERSE_TYPES: ReadonlySet<EdgeType> = new Set(['CALLS', 'DEPENDS_ON', 'EXTENDS', 'IMPLEMENTS', 'IMPORTS', ...EFFECT_TYPES]);
export const IMPACT_SCORE_VERSION = 'observed-impact-v1';

function select(graph: AnalysisGraph, options: ImpactOptions): { roots: string[]; resolution: string } | { error: string; candidates: AnalysisNode[] } {
  const roots = new Set<string>();
  for (const selector of options.symbols ?? []) {
    const found = resolveNode(graph, selector);
    if ('error' in found) { return found; }
    roots.add(found.node.id);
  }
  for (const raw of options.paths ?? []) {
    const path = posix.normalize(raw.replaceAll('\\', '/')).replace(/\/$/, '');
    if (posix.isAbsolute(path) || path === '..' || path.startsWith('../')) { return { error: `Path outside the indexed repository: ${raw}`, candidates: [] }; }
    const matches = graph.files.filter((file) => path === '.' || file.path === path || file.path.startsWith(`${path}/`));
    if (!matches.length) { return { error: `Path not indexed: ${raw}`, candidates: [] }; }
    for (const file of matches) { roots.add(file.id); }
  }
  if (roots.size) { return { roots: [...roots].sort(), resolution: 'explicit symbols/paths' }; }
  const change = options.change?.trim();
  if (!change) { return { error: 'Provide symbols, paths, or a change description naming an indexed symbol.', candidates: [] }; }
  // Exact identifier mentions locate scope; prose is never treated as evidence of an implemented change.
  const occupied: [number, number][] = [];
  const names = [...new Set([...graph.symbols.values()].map((symbol) => symbol.qualifiedName))].sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu');
    const mentions = [...change.matchAll(pattern)].filter((match) => !occupied.some(([start, end]) => match.index! < end && match.index! + name.length > start));
    if (!mentions.length) { continue; }
    const found = resolveNode(graph, name);
    if ('error' in found) { return found; }
    roots.add(found.node.id);
    for (const mention of mentions) { occupied.push([mention.index!, mention.index! + name.length]); }
  }
  return roots.size ? { roots: [...roots].sort(), resolution: 'exact identifiers mentioned in change; proposed behavior is unverified' }
    : { error: 'No exact indexed identifier in the change. Select symbols or paths; these lexical matches are suggestions only.',
      candidates: graph.store.searchSymbols(graph.snapshotId, change, 10).map((hit) => graph.nodes.get(hit.symbol.id)!) };
}

function page<T>(items: T[], offset: number, limit: number) {
  return { total: items.length, items: items.slice(offset, offset + limit),
    nextOffset: offset + limit < items.length ? offset + limit : null };
}

/** Potential blast radius from stored references; no LLM, source execution or repository writes. */
export function impactAnalysis(store: KnowledgeStore, snapshotId: string, options: ImpactOptions) {
  const budget = limits(options); const offset = options.offset ?? 0; const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) { throw new Error('offset must be nonnegative; limit must be an integer from 1 to 200.'); }
  const facts = options.facts ?? {};
  const factKeys = new Set(['publicApiChange', 'schemaChange', 'contractChange', 'authorizationChange', 'concurrencyChange', 'externalEffects', 'persistenceChange', 'reversible']);
  if (Object.entries(facts).some(([key, value]) => !factKeys.has(key) || typeof value !== 'boolean')) { throw new Error('facts accepts only documented boolean change facts.'); }
  const graph = analysisGraph(store, snapshotId);
  const selected = select(graph, options);
  if ('error' in selected) { return selected; }
  const directScope = new Set(selected.roots); const directQueue = [...selected.roots];
  for (let head = 0; head < directQueue.length; head += 1) {
    for (const edge of graph.outgoing.get(directQueue[head]!) ?? []) {
      if (edge.type === 'CONTAINS' && !directScope.has(edge.targetId)) { directScope.add(edge.targetId); directQueue.push(edge.targetId); }
    }
  }
  const mapped = new Set((store.db.prepare('SELECT DISTINCT target_id FROM symbol_references WHERE snapshot_id = ? AND is_definition = 1')
    .all(snapshotId) as { target_id: string }[]).map((row) => row.target_id));
  const fallback = new Set<string>();
  const wholeFiles = new Set(selected.roots.filter((id) => graph.nodes.get(id)?.kind === 'file'));
  const walked = traverse(selected.roots, (id, expandFile) => {
    const node = graph.nodes.get(id)!;
    const steps: Step[] = (graph.incoming.get(id) ?? []).filter((edge) => REVERSE_TYPES.has(edge.type) && (edge.type !== 'IMPORTS' || expandFile))
      .map((edge) => ({ next: edge.sourceId, edge, expandFile: edge.type === 'IMPORTS',
        reason: edge.type === 'IMPORTS' ? 'file import: usage may be unrelated to the proposed change' : `incoming ${edge.type}` }));
    // A change to a file/class/interface potentially changes its declarations; ownership is not a call.
    if (['class', 'interface'].includes(node.kind) || (node.kind === 'file' && expandFile)) {
      steps.push(...(graph.outgoing.get(id) ?? []).filter((edge) => edge.type === 'CONTAINS')
        .map((edge) => ({ next: edge.targetId, edge, reason: 'declaration inside selected/affected container' })));
    }
    if (graph.symbols.has(id) && node.kind !== 'endpoint' && !mapped.has(id)) {
      fallback.add(id);
      steps.push(...(graph.incoming.get(id) ?? []).filter((edge) => edge.type === 'CONTAINS')
        .map((edge) => ({ next: edge.sourceId, edge, expandFile: graph.nodes.get(edge.sourceId)?.kind === 'file',
          reason: 'file/container fallback: no mapped compiler definition' })));
    }
    return steps;
  }, budget, wholeFiles);
  const affected = [...walked.depth].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const affectedIds = new Set(walked.depth.keys());
  const affectedSymbols = affected.flatMap(([id, depth]) => graph.symbols.has(id) ? [{ ...graph.nodes.get(id)!, depth,
    reason: walked.reasons.get(id)!, via: (walked.predecessor.get(id) ?? []).map((parent) => parent.edge.id) }] : []);
  const paths = new Set(affected.flatMap(([id]) => graph.nodes.get(id)?.location?.path ?? []));
  const affectedFiles = graph.files.filter((file) => paths.has(file.path)).sort((a, b) => a.path.localeCompare(b.path));
  const affectedModules = [...new Set(affectedFiles.flatMap((file) => {
    const owner = graph.modules.filter((module) => module.path === '.' || file.path.startsWith(`${module.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return owner ? [owner.id] : [];
  }))].map((id) => graph.modules.find((module) => module.id === id)!).sort((a, b) => a.path.localeCompare(b.path));
  const exports = store.listExports(snapshotId);
  const exported = new Set(exports.flatMap((binding) => binding.symbolId ? [binding.symbolId] : []));
  const publicMember = (symbol: CodeSymbol) => symbol.kind === 'method' && symbol.visibility === 'public'
    && (graph.incoming.get(symbol.id) ?? []).some((edge) => edge.type === 'CONTAINS' && exported.has(edge.sourceId));
  const contracts = affectedSymbols.filter((symbol) => exported.has(symbol.id) || symbol.kind === 'endpoint' || publicMember(graph.symbols.get(symbol.id)!))
    .map((node) => ({ id: node.id, name: node.name, kind: node.kind, location: node.location,
      exports: exports.filter((entry) => entry.symbolId === node.id).map((entry) => ({ path: entry.path, name: entry.exportedName, line: entry.startLine, typeOnly: entry.typeOnly })),
      route: graph.symbols.get(node.id)?.route ?? null }));
  const relevantIds = new Set([...affectedIds, ...affectedFiles.map((file) => file.id)]);
  const testEdges = [...graph.edges.values()].filter((edge) => edge.type === 'TESTED_BY' && relevantIds.has(edge.sourceId));
  const testPaths = new Set(testEdges.flatMap((edge) => graph.nodes.get(edge.targetId)?.location?.path ?? []));
  const allTests = store.listTests(snapshotId);
  const knownTestPaths = new Set([...testPaths, ...allTests.map((test) => test.path)]);
  const tests = allTests.filter((test) => testPaths.has(test.path) || affectedIds.has(test.id) || paths.has(test.path))
    .map((test) => ({ id: test.id, name: test.name, path: test.path, startLine: test.startLine, endLine: test.endLine }));
  // A caller change can alter effects in unchanged callees. Follow calls separately
  // without incorrectly labeling those callees as files that necessarily need edits.
  const effectRoots = [...directScope].sort();
  const effectsRootsOmitted = Math.max(0, effectRoots.length - budget.maxNodes);
  const effectWalk = traverse(effectRoots.slice(0, budget.maxNodes), (id) => (graph.outgoing.get(id) ?? [])
    .filter((edge) => edge.type === 'CALLS' || EFFECT_TYPES.has(edge.type))
    .map((edge) => ({ next: edge.targetId, edge, reason: edge.type })), budget);
  const effects = [...effectWalk.inspected.values()].filter((edge) => EFFECT_TYPES.has(edge.type));
  const truncated = walked.limits.truncated || effectWalk.limits.truncated || effectsRootsOmitted > 0;
  const coverages = store.listCoverage(snapshotId);
  const coverage = affectedFiles.filter((file) => ['typescript', 'javascript', 'python'].includes(file.language ?? '') && !knownTestPaths.has(file.path)).map((file) => {
    const record = coverages.find((entry) => entry.path === file.path);
    const usable = !!record && record.sourceHash === file.contentHash && record.lineRate !== null && record.provenance['sourceBinding'] === 'reported-lines-verified';
    return { path: file.path, status: usable ? 'reported-lines-verified' : 'unknown',
      lineRate: record?.lineRate ?? null, branchRate: record?.branchRate ?? null,
      analyzer: record?.analyzer ?? null, sourceBinding: record?.provenance['sourceBinding'] ?? 'missing',
      sourceHashMatches: record ? record.sourceHash === file.contentHash : null,
      reportedLines: record?.lines.length ?? 0, coveredLines: record?.lines.filter((line) => line.hits > 0).length ?? 0 };
  });
  const findings = store.getFindings(snapshotId, 'confirmed').filter((finding) =>
    (finding.module && affectedModules.some((module) => module.id === finding.module)) || store.getEvidence(finding.id).some((entry) => paths.has(entry.path)))
    .map((finding) => ({ findingId: finding.id, ruleId: finding.ruleId, severity: finding.severity, confidence: finding.confidence,
      claim: finding.claim.length > 300 ? `${finding.claim.slice(0, 300)}… [preview]` : finding.claim }));
  const factors: ImpactFactor[] = [];
  const countFactor = (id: string, weight: number, value: number, saturation: number, reason: string) => {
    const points = Math.min(weight, Math.ceil(value / saturation * weight));
    factors.push({ id, weight, value, points, maximum: walked.limits.truncated ? weight : points, status: 'observed', reason });
  };
  const booleanFactor = (id: string, weight: number, supplied: boolean | undefined, observed: boolean, reason: string) => {
    const value = supplied ?? (observed ? true : null); const points = value === null ? null : value ? weight : 0;
    factors.push({ id, weight, value, points, maximum: points ?? weight,
      status: supplied !== undefined ? 'provided' : value === null ? 'unknown' : 'observed',
      reason: supplied !== undefined ? `Caller-provided change fact (not independently verified). ${reason}` : reason });
  };
  countFactor('affected_symbols', 10, affectedSymbols.length, 20, 'Potential affected symbols; saturates at 20.');
  countFactor('transitive_dependents', 10, affectedSymbols.filter((symbol) => !directScope.has(symbol.id)).length, 40, 'Reachable symbols outside the directly selected declarations; saturates at 40.');
  booleanFactor('public_api', 10, facts.publicApiChange, contracts.length > 0, 'Public exports, routes or public methods are exposed in the scope; actual compatibility changes require review.');
  booleanFactor('schema', 10, facts.schemaChange, affectedFiles.some((file) => /\.(sql|prisma|proto|graphql)$/i.test(file.path)), 'Schema artifact exposure is a risk signal; schema migration semantics are not inferred.');
  booleanFactor('contract', 10, facts.contractChange, affectedSymbols.some((symbol) => ['interface', 'type'].includes(symbol.kind)), 'Type/interface contract exposure; a breaking contract change is not established.');
  booleanFactor('authorization', 10, facts.authorizationChange, false, 'Authorization/security impact requires explicit change context; names alone are insufficient.');
  booleanFactor('concurrency', 8, facts.concurrencyChange, false, 'Concurrency consequences are not inferred from async syntax or static calls.');
  booleanFactor('external_effects', 8, facts.externalEffects, effects.length > 0, 'Only recorded effect edges establish observed effect exposure; other external effects remain unknown.');
  booleanFactor('persistence', 8, facts.persistenceChange, effects.some((edge) => ['READS_FROM', 'WRITES_TO'].includes(edge.type)), 'Recorded reads/writes indicate storage/resource exposure, not transaction correctness.');
  const coverageKnown = !walked.limits.truncated && coverage.length > 0 && coverage.every((entry) => entry.status === 'reported-lines-verified' && entry.reportedLines > 0);
  const totalLines = coverage.reduce((sum, entry) => sum + entry.reportedLines, 0);
  const fraction = coverageKnown ? coverage.reduce((sum, entry) => sum + entry.coveredLines, 0) / totalLines : null;
  const coveragePoints = fraction === null ? null : Math.ceil((1 - fraction) * 8);
  factors.push({ id: 'coverage_gap', weight: 8, value: fraction, points: coveragePoints, maximum: coveragePoints ?? 8,
    status: fraction === null ? 'unknown' : 'reported', reason: 'Line-weighted coverage of affected code files, only with matching snapshot hashes and verified reported lines. This does not prove whole-build freshness or test assertions.' });
  booleanFactor('irreversibility', 4, facts.reversible === undefined ? undefined : !facts.reversible, false, 'Rollback/reversibility requires explicit change context.');
  countFactor('modules', 4, affectedModules.length, 4, 'Distinct owning modules; saturates at four.');
  const observed = factors.reduce((sum, factor) => sum + (factor.points ?? 0), 0);
  const upper = factors.reduce((sum, factor) => sum + factor.maximum, 0);
  const missingFactors = factors.filter((factor) => factor.status === 'unknown').map((factor) => factor.id);
  const tier = observed >= 60 ? 'cross-cutting' : observed >= 25 ? 'module' : 'localized';
  const semantic = semanticStatus(graph);
  // Pagination applies independently to each category; counts and scores use the whole bounded traversal.
  const relations = [...new Map([...walked.inspected.values(), ...effectWalk.inspected.values(), ...testEdges].map((edge) => [edge.id, edge])).values()];
  return { snapshotId, selection: { resolution: selected.resolution, roots: selected.roots.map((id) => graph.nodes.get(id)!) },
    scope: 'potential impact in the observed snapshot graph; not a claim that every dependent must be edited',
    affectedSymbols: page(affectedSymbols, offset, limit),
    affectedFiles: page(affectedFiles.map((file) => ({ id: file.id, path: file.path })), offset, limit),
    affectedModules: page(affectedModules.map((module) => ({ id: module.id, name: module.name, path: module.path })), offset, limit),
    publicContracts: page(contracts, offset, limit), relevantTests: page(tests, offset, limit),
    sideEffects: page(effects, offset, limit), risks: page(findings, offset, limit), coverage: page(coverage, offset, limit),
    relations: page(relations, offset, limit),
    score: { version: IMPACT_SCORE_VERSION, observed, range: { minimum: observed, maximum: upper }, factors,
      interpretation: 'Versioned prioritization heuristic, not a defect probability or calibrated effort estimate. Unknown factors contribute no observed points and retain their weight in the upper bound.' },
    recommendedWorkflow: { tier, provisional: missingFactors.length > 0 || truncated || fallback.size > 0 || semantic.unknowns.length > 0,
      agents: tier === 'cross-cutting' ? ['architect', 'coder', 'critic', 'cleaner', 'reviewer', 'tester'] : tier === 'module' ? ['coder', 'cleaner', 'architect'] : ['coder', 'reviewer'],
      specificationRequired: tier === 'cross-cutting', requiredChecks: missingFactors,
      note: 'Recommendation only; no agents or tests are launched. Resolve unknowns and review the change before final workflow selection.' },
    limits: { ...walked.limits, truncated, effects: effectWalk.limits, effectsRootsOmitted, offset, limit }, indexers: semantic.indexers,
    unknowns: [...semantic.unknowns, ...(fallback.size ? [`${fallback.size} symbol(s) lack compiler definitions; conservative file/container propagation may include unrelated code.`] : []),
      ...(truncated ? ['The graph traversal is incomplete; counts are lower bounds within the observed graph.'] : []),
      ...(missingFactors.length ? [`Unknown scoring factors: ${missingFactors.join(', ')}.`] : []),
      'TESTED_BY links and referenced test files identify candidates to run, not executed coverage or proof of assertions.',
      ...(affectedSymbols.some((symbol) => symbol.kind === 'method' && !graph.symbols.get(symbol.id)?.visibility) ? ['Some member visibility is unknown (including Python/legacy snapshots); review exported-class contracts explicitly.'] : []),
      'Dynamic dispatch, external callers, reflection and unrecorded side effects may add impact beyond the indexed graph.',
    ] };
}
