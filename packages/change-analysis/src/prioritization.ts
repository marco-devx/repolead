import type { Evidence, ImprovementOpportunity, Metric, Module, SourceFile } from '@repolead/domain';
import { contentHash } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';

export const PRIORITIZATION_VERSION = 'observed-hotspots-v1';
export const OPPORTUNITY_ANALYZER = 'repolead-prioritization';
const META_KEY = 'improvement_opportunities';
const metricNames = new Set(['cyclomatic_complexity', 'fan_in', 'commit_count']);
const TEST_PATH = /(^|\/)(?:__tests__|tests?)(?:\/|$)|(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

export interface PriorityOptions { module?: string; offset?: number; limit?: number }
export interface HotspotFactor {
  id: 'complexity' | 'fan_in' | 'churn' | 'coverage_gap';
  value: number | null;
  status: 'observed' | 'reported' | 'unknown';
  multiplier: number | null;
  maximumMultiplier: number;
  analyzer: string | null;
  subjectId: string;
  reason: string;
}
export interface Hotspot {
  symbolId: string; name: string; module: string | null;
  location: { path: string; startLine: number; endLine: number };
  sourceHash: string; symbolHash: string;
  priority: number; range: { minimum: number; maximum: number };
  factors: HotspotFactor[]; reasons: string[];
  coverage: { reportedLines: number; coveredLines: number; sourceBinding: string; analyzer: string | null };
}

function input(store: KnowledgeStore, snapshotId: string) {
  const snapshot = store.getSnapshot(snapshotId);
  if (!snapshot) { throw new Error('Unknown snapshot.'); }
  const files = store.listFiles(snapshotId); const modules = store.listModules(snapshotId);
  const symbols = store.listSymbols(snapshotId);
  const metrics = store.listMetrics(snapshotId).filter((metric) => metricNames.has(metric.name));
  const coverage = store.listCoverage(snapshotId);
  const testPaths = [...new Set(store.listTests(snapshotId).map((test) => test.path))].sort();
  const findings = store.getFindings(snapshotId, 'confirmed').sort((a, b) => a.id.localeCompare(b.id))
    .map((finding) => ({ finding, evidence: store.getEvidence(finding.id).sort((a, b) => a.id.localeCompare(b.id)) }));
  const semantic = JSON.parse(store.getSnapshotMetadata(snapshotId, 'scip_diagnostics') ?? '{}') as {
    indexers?: { status?: string }[]; reconciliation?: unknown[];
  };
  const semanticComplete = !!semantic.indexers?.length && semantic.indexers.every((entry) => entry.status === 'complete') && !semantic.reconciliation?.length;
  const hash = contentHash(JSON.stringify({ version: PRIORITIZATION_VERSION, snapshotId, files, modules, symbols, metrics,
    coverage: coverage.map(({ path, analyzer, sourceHash, lines, provenance }) => ({ path, analyzer, sourceHash, lines, sourceBinding: provenance['sourceBinding'] })),
    testPaths, findings, semanticComplete }));
  return { snapshot, files, modules, symbols, metrics, coverage, testPaths: new Set(testPaths), findings, semanticComplete, hash };
}
type Inputs = ReturnType<typeof input>;

function owner(modules: Module[], path: string): string | null {
  return modules.filter((module) => module.path === '.' || path.startsWith(`${module.path}/`))
    .sort((a, b) => b.path.length - a.path.length || a.id.localeCompare(b.id))[0]?.id ?? null;
}
function selection(modules: Module[], options: PriorityOptions) {
  const offset = options.offset ?? 0; const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('offset must be nonnegative; limit must be an integer from 1 to 200.');
  }
  if (options.module === undefined) { return { module: null, offset, limit }; }
  const exact = modules.find((module) => module.id === options.module);
  const matches = exact ? [exact] : modules.filter((module) => module.name === options.module || module.path === options.module);
  if (matches.length !== 1) { throw new Error(`Unknown or ambiguous module: ${options.module}. Use an exact module ID.`); }
  return { module: matches[0]!.id, offset, limit };
}
function page<T>(items: T[], offset: number, limit: number) {
  return { total: items.length, items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null };
}
const round = (value: number) => Math.round(value * 100) / 100;
const multiplier = (value: number, saturation: number) => 1 + 3 * Math.min(1, Math.max(0, value / saturation));
const score = (multipliers: number[]) => round((multipliers.reduce((product, value) => product * value, 1) ** 0.25 - 1) / 3 * 100);

function rank(data: Inputs) {
  const files = new Map(data.files.map((file) => [file.path, file]));
  const coverageByPath = new Map(data.coverage.map((record) => [record.path, record]));
  const metrics = new Map(data.metrics.map((metric) => [JSON.stringify([metric.subjectId, metric.name, metric.analyzer]), metric]));
  const metric = (subject: string, name: string, analyzer: string): Metric | undefined => {
    const found = metrics.get(JSON.stringify([subject, name, analyzer]));
    return found && Number.isFinite(found.value) && found.value >= 0 ? found : undefined;
  };
  let excludedTestSymbols = 0; let consideredSymbols = 0;
  const hotspots: Hotspot[] = [];
  for (const symbol of data.symbols) {
    if (!['function', 'method'].includes(symbol.kind)) { continue; }
    if (data.testPaths.has(symbol.path) || TEST_PATH.test(symbol.path)) { excludedTestSymbols += 1; continue; }
    const file = files.get(symbol.path);
    if (!file) { continue; }
    consideredSymbols += 1;
    const complexity = metric(symbol.id, 'cyclomatic_complexity', 'tree-sitter-metrics-v1');
    const fanIn = metric(symbol.id, 'fan_in', 'observed-graph-metrics-v1');
    const churn = metric(file.id, 'commit_count', 'git');
    const record = coverageByPath.get(symbol.path);
    const reported = record?.lines.filter((line) => line.line >= symbol.startLine && line.line <= symbol.endLine) ?? [];
    const sourceBinding = record?.provenance['sourceBinding'];
    const usable = !!record && sourceBinding === 'reported-lines-verified' && record.sourceHash === file.contentHash && reported.length > 0
      && reported.every((line) => Number.isSafeInteger(line.line) && Number.isSafeInteger(line.hits) && line.hits >= 0)
      && new Set(reported.map((line) => line.line)).size === reported.length;
    const covered = reported.filter((line) => line.hits > 0).length;
    const gap = usable ? 1 - covered / reported.length : null;
    const factors: HotspotFactor[] = [];
    const add = (id: HotspotFactor['id'], measurement: Metric | undefined, saturation: number, reason: string, incomplete = false) => {
      const value = measurement?.value ?? null;
      const normalized = value === null ? null : multiplier(id === 'complexity' ? Math.max(0, value - 1) : value, saturation);
      factors.push({ id, value, status: value === null ? 'unknown' : 'observed', multiplier: normalized,
        maximumMultiplier: incomplete || normalized === null ? 4 : normalized, analyzer: measurement?.analyzer ?? null,
        subjectId: id === 'churn' ? file.id : symbol.id, reason });
    };
    add('complexity', complexity, 19, 'AST cyclomatic complexity, saturates at 20; nested callable bodies are measured separately.');
    add('fan_in', fanIn, 20, 'Distinct observed reference sources, saturates at 20; includes callbacks/type references, not only calls. Missing/incomplete semantic indexing leaves an uncertainty range.', !data.semanticComplete);
    add('churn', churn, 20, 'File commit count within the last 500 repository commits, saturates at 20. File-level proxy, not per-symbol churn or an annual change rate.');
    factors.push({ id: 'coverage_gap', value: gap, status: gap === null ? 'unknown' : 'reported',
      multiplier: gap === null ? null : multiplier(gap, 1), maximumMultiplier: gap === null ? 4 : multiplier(gap, 1),
      analyzer: record?.analyzer ?? null, subjectId: symbol.id,
      reason: 'Uncovered fraction of checksum-verified reported lines inside this symbol. Missing/stale/unverified reports are unknown. Line hits do not prove assertions or whole-build freshness.' });
    const reasons = [
      ...(complexity && complexity.value >= 10 ? ['cyclomatic complexity >= 10'] : []),
      ...(fanIn && fanIn.value >= 5 ? ['at least 5 observed reference sources'] : []),
      ...(churn && churn.value >= 5 ? ['file changed in at least 5 of the last 500 repository commits'] : []),
      ...(gap !== null && gap >= 0.5 ? ['at least half of verified reported lines in the symbol are uncovered'] : []),
    ];
    if (!reasons.length) { continue; }
    const priority = score(factors.map((factor) => factor.multiplier ?? 1));
    hotspots.push({ symbolId: symbol.id, name: symbol.qualifiedName, module: owner(data.modules, symbol.path),
      location: { path: symbol.path, startLine: symbol.startLine, endLine: symbol.endLine }, sourceHash: file.contentHash, symbolHash: symbol.contentHash,
      priority, range: { minimum: priority, maximum: score(factors.map((factor) => factor.maximumMultiplier)) }, factors, reasons,
      coverage: { reportedLines: usable ? reported.length : 0, coveredLines: usable ? covered : 0,
        sourceBinding: usable ? 'reported-lines-verified' : 'unknown', analyzer: record?.analyzer ?? null } });
  }
  return { hotspots: hotspots.sort((a, b) => b.priority - a.priority || a.symbolId.localeCompare(b.symbolId)), consideredSymbols, excludedTestSymbols };
}

const limitations = [
  'Priority is a versioned heuristic, not defect probability, remediation effort or business value. Business-critical logic is not inferred from names.',
  'Each factor contributes a multiplier from 1 to 4; the geometric mean maps to 0–100. Unknown factors use 1 only for the lower bound and 4 for the upper bound. Ranking uses the lower bound, so incomplete data can rank below fully measured code.',
  'Static references may miss dynamic/external callers. Git history is bounded to 500 repository commits; coverage describes only reported lines.',
  'No tests, mutation testing, external tools or generative models are run by this query.',
];

export function listHotspots(store: KnowledgeStore, snapshotId: string, options: PriorityOptions = {}) {
  const data = input(store, snapshotId); const selected = selection(data.modules, options); const result = rank(data);
  return { snapshotId, version: PRIORITIZATION_VERSION, inputHash: data.hash,
    consideredSymbols: result.consideredSymbols, excludedTestSymbols: result.excludedTestSymbols,
    ...page(result.hotspots.filter((entry) => selected.module === null || entry.module === selected.module), selected.offset, selected.limit),
    limits: { offset: selected.offset, limit: selected.limit }, limitations };
}

function validLocation(entry: Evidence, files: Map<string, SourceFile>, modules: Module[]) {
  const file = files.get(entry.path);
  if (!file) { return entry.startLine === null && entry.endLine === null && modules.some((module) => module.path === entry.path); }
  return file && (entry.startLine === null || (Number.isInteger(entry.startLine) && entry.startLine >= 1
    && (file.lineCount === null || entry.startLine <= file.lineCount)))
    && (entry.endLine === null || (entry.startLine !== null && Number.isInteger(entry.endLine) && entry.endLine >= entry.startLine
      && (file.lineCount === null || entry.endLine <= file.lineCount)));
}

/** Materialized projection; synchronous publication keeps evidence, entries and freshness atomic. */
export function refreshOpportunities(store: KnowledgeStore, snapshotId: string) {
  const data = input(store, snapshotId);
  const previous = JSON.parse(store.getSnapshotMetadata(snapshotId, META_KEY) ?? '{}') as { inputHash?: string; count?: number; omittedFindings?: number };
  if (previous.inputHash === data.hash) { return { snapshotId, cached: true, count: previous.count ?? 0, omittedFindings: previous.omittedFindings ?? 0 }; }
  const ranked = rank(data); const files = new Map(data.files.map((file) => [file.path, file]));
  const createdAt = new Date().toISOString(); const items: ImprovementOpportunity[] = []; const evidence: Evidence[] = [];
  const idFor = (kind: string, sourceId: string) => `opportunity_${contentHash(JSON.stringify([data.snapshot.repositoryId, snapshotId, PRIORITIZATION_VERSION, kind, sourceId])).slice(0, 32)}`;
  const severity = { info: 5, low: 20, medium: 45, high: 75, critical: 100 };
  let omittedFindings = 0;
  for (const { finding, evidence: sourceEvidence } of data.findings) {
    const locations = sourceEvidence.filter((entry) => validLocation(entry, files, data.modules));
    if (!locations.length) { omittedFindings += 1; continue; }
    const id = idFor('finding', finding.id);
    const candidateModules = [...new Set(locations.map((entry) => data.modules.find((module) => module.path === entry.path)?.id ?? owner(data.modules, entry.path)))];
    const module = data.modules.some((entry) => entry.id === finding.module) ? finding.module : candidateModules.length === 1 ? candidateModules[0]! : null;
    items.push({ id, snapshotId, module, title: `${finding.ruleId}: ${finding.claim}`,
      description: finding.recommendation ?? 'Review the confirmed finding and its evidence before selecting a change.',
      priority: severity[finding.severity], subjectId: null, sourceKind: 'finding', sourceId: finding.id,
      analyzer: OPPORTUNITY_ANALYZER, inputHash: data.hash, createdAt,
      details: { version: PRIORITIZATION_VERSION, severity: finding.severity, confidence: finding.confidence,
        priorityBasis: 'Severity: info 5, low 20, medium 45, high 75, critical 100. Confidence is reported separately; scores are not calibrated across finding and hotspot categories.',
        effort: 'unknown', businessImpact: 'unknown', omittedEvidence: sourceEvidence.length - locations.length,
        sourceEvidence: locations.map((entry) => ({ evidenceId: entry.id, path: entry.path, startLine: entry.startLine, endLine: entry.endLine,
          kind: files.has(entry.path) ? 'file' : 'module', sourceHash: files.get(entry.path)?.contentHash ?? null,
          moduleId: data.modules.find((module) => module.path === entry.path)?.id ?? null })) } });
    for (const entry of locations) { evidence.push({ ...entry, id: `${id}_${contentHash(entry.id).slice(0, 16)}`, ownerId: id, ownerKind: 'opportunity', excerpt: null }); }
  }
  for (const hotspot of ranked.hotspots) {
    const id = idFor('hotspot', hotspot.symbolId);
    items.push({ id, snapshotId, module: hotspot.module, title: `Review hotspot: ${hotspot.name}`,
      description: `Inspect complexity and callers, verify tests, then consider targeted mutation testing. Signals: ${hotspot.reasons.join('; ')}.`,
      priority: hotspot.priority, subjectId: hotspot.symbolId, sourceKind: 'hotspot', sourceId: hotspot.symbolId,
      details: { version: PRIORITIZATION_VERSION, hotspot, effort: 'unknown', businessImpact: 'unknown' }, analyzer: OPPORTUNITY_ANALYZER, inputHash: data.hash, createdAt });
    evidence.push({ id: `${id}_location`, ownerId: id, ownerKind: 'opportunity', ...hotspot.location, excerpt: null });
  }
  store.db.transaction(() => {
    store.replaceOpportunities(snapshotId, OPPORTUNITY_ANALYZER, items, evidence);
    store.setSnapshotMetadata(snapshotId, META_KEY, JSON.stringify({ version: PRIORITIZATION_VERSION, inputHash: data.hash, count: items.length, omittedFindings, createdAt }));
  })();
  return { snapshotId, cached: false, count: items.length, omittedFindings };
}

export function improvementOpportunities(store: KnowledgeStore, snapshotId: string, options: PriorityOptions = {}) {
  const data = input(store, snapshotId); const selected = selection(data.modules, options);
  const metadata = JSON.parse(store.getSnapshotMetadata(snapshotId, META_KEY) ?? '{}') as { inputHash?: string; createdAt?: string; omittedFindings?: number };
  const status = !metadata.inputHash ? 'not_generated' : metadata.inputHash === data.hash ? 'current' : 'stale';
  const items = status === 'current' ? store.listOpportunities(snapshotId, OPPORTUNITY_ANALYZER)
    .filter((entry) => selected.module === null || entry.module === selected.module).map((entry) => ({ ...entry, evidence: store.getEvidence(entry.id) })) : [];
  return { snapshotId, version: PRIORITIZATION_VERSION, inputHash: data.hash, status, generatedAt: metadata.createdAt ?? null,
    omittedFindings: metadata.omittedFindings ?? 0, ...page(items, selected.offset, selected.limit),
    limits: { offset: selected.offset, limit: selected.limit }, limitations,
    hint: status === 'current' ? 'Read sourceKind/sourceId and evidence for provenance; use get_evidence with opportunityId for indexed source.'
      : 'Projection unavailable or stale. Run repolead opportunities to regenerate; scan, metrics and audit also update it.' };
}

/** Current projection only: never bind old opportunity coordinates to newer source. */
export function opportunityEvidence(store: KnowledgeStore, snapshotId: string, opportunityId: string) {
  const data = input(store, snapshotId);
  const metadata = JSON.parse(store.getSnapshotMetadata(snapshotId, META_KEY) ?? '{}') as { inputHash?: string };
  if (metadata.inputHash !== data.hash) { return null; }
  const opportunity = store.listOpportunities(snapshotId, OPPORTUNITY_ANALYZER).find((entry) => entry.id === opportunityId);
  return opportunity ? { opportunity, evidence: store.getEvidence(opportunity.id) } : null;
}
