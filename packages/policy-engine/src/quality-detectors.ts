import type { KnowledgeStore } from '@repolead/knowledge-store';

import type { CandidateEvidence, Detector } from './detectors';

function sourceEvidence(store: KnowledgeStore, snapshotId: string, path: string, startLine: number, endLine: number): CandidateEvidence[] {
  const source = store.getSnapshotSource(snapshotId, path);
  if (source === null) { return []; }
  const start = Math.max(1, startLine - 3);
  const end = Math.min(endLine, start + 79);
  return [{ path, startLine: start, endLine: end, kind: 'source_excerpt',
    excerpt: source.split('\n').slice(start - 1, end).join('\n') + (end < endLine ? '\n[remaining source omitted]' : '') }];
}

/** Thresholds identify candidates, never establish a design defect by themselves. */
export const metricThreshold: Detector = (store, snapshotId, params) => {
  const metricName = String(params['metric'] ?? 'cyclomatic_complexity');
  const analyzer = String(params['analyzer'] ?? 'tree-sitter-metrics-v1');
  const threshold = typeof params['threshold'] === 'number' ? params['threshold'] : 15;
  const symbols = new Map(store.listSymbols(snapshotId).map((symbol) => [symbol.id, symbol]));
  const modules = store.listModules(snapshotId).sort((a, b) => b.path.length - a.path.length);
  return store.listMetrics(snapshotId).filter((metric) => metric.name === metricName && metric.analyzer === analyzer && metric.value >= threshold)
    .flatMap((metric) => {
      const symbol = symbols.get(metric.subjectId);
      if (!symbol) { return []; }
      const facts = { metric: metric.name, value: metric.value, analyzer: metric.analyzer, threshold };
      return [{ claim: `${symbol.qualifiedName}: ${metric.name}=${metric.value} (threshold ${threshold})`,
        module: modules.find((module) => module.path === '.' || symbol.path.startsWith(`${module.path}/`))?.id ?? null, facts,
        evidence: [{ path: symbol.path, startLine: symbol.startLine, endLine: symbol.endLine, kind: 'metric' as const, excerpt: JSON.stringify(facts) },
          ...sourceEvidence(store, snapshotId, symbol.path, symbol.startLine, symbol.endLine)] }];
    });
};

export const lowCohesion: Detector = (store, snapshotId, params) => {
  const minFiles = typeof params['minFiles'] === 'number' ? params['minFiles'] : 4;
  const maxRatio = typeof params['maxRatio'] === 'number' ? params['maxRatio'] : 0.5;
  return store.listModules(snapshotId).flatMap((module) => {
    const metrics = store.listMetrics(snapshotId, module.id).filter((metric) => metric.analyzer === 'observed-graph-metrics-v1');
    const value = (name: string) => metrics.find((metric) => metric.name === name)?.value;
    if ((value('code_files') ?? 0) < minFiles || value('largest_component_ratio') === undefined || value('largest_component_ratio')! > maxRatio) { return []; }
    const facts = { scope: 'observed file dependency graph; disconnected files alone do not prove low semantic cohesion',
      files: value('code_files'), components: value('dependency_components'), largestComponentRatio: value('largest_component_ratio') };
    return [{ claim: `El módulo ${module.name} tiene ${facts.components} componentes de dependencias desconectados`, module: module.id, facts,
      evidence: [{ path: module.path, startLine: null, endLine: null, kind: 'metric' as const, excerpt: JSON.stringify(facts) }] }];
  });
};

export const toolIssue: Detector = (store, snapshotId, params) => {
  const analyzer = String(params['analyzer'] ?? 'quality:jscpd');
  const rule = params['rule'] === undefined ? null : new RegExp(String(params['rule']));
  return store.listQualityIssues(snapshotId).filter((issue) => issue.analyzer === analyzer && (!rule || rule.test(issue.ruleId)))
    .map((issue) => ({ claim: `${issue.analyzer} ${issue.ruleId}: ${issue.message}`, module: null,
      facts: { analyzer: issue.analyzer, ruleId: issue.ruleId, details: issue.details },
      evidence: issue.locations.flatMap((location) => [
        { ...location, kind: 'metric' as const, excerpt: JSON.stringify({ rule: issue.ruleId, analyzer: issue.analyzer, ...issue.details }) },
        ...sourceEvidence(store, snapshotId, location.path, location.startLine, location.endLine),
      ]) }));
};
