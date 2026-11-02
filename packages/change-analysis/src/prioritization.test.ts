import { expect, test } from '@rstest/core';

import type { CodeSymbol, CoverageRecord, Finding, SourceFile } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

import { improvementOpportunities, listHotspots, opportunityEvidence, OPPORTUNITY_ANALYZER, refreshOpportunities } from './prioritization';

async function fixture() {
  const store = await openStore(':memory:');
  const repo = store.upsertRepository({ name: 'priority-fixture', rootPath: '/not-mounted' });
  const snapshot = store.createSnapshot({ repositoryId: repo.id, commitSha: 'fixture' });
  const files: SourceFile[] = ['src/hot.ts', 'src/cold.ts', 'src/hot.test.ts', 'other/small.py'].map((path) => ({
    id: path, path, repositoryId: repo.id, snapshotId: snapshot.id, contentHash: `hash:${path}`, lineCount: 50,
    language: path.endsWith('.py') ? 'python' : 'typescript', lastAuthor: null, lastCommitAt: null,
  }));
  store.insertFiles(files);
  store.insertModules([{ id: 'root', name: 'root', path: '.', repositoryId: repo.id, snapshotId: snapshot.id },
    { id: 'src', name: 'service', path: 'src', repositoryId: repo.id, snapshotId: snapshot.id },
    { id: 'other', name: 'service', path: 'other', repositoryId: repo.id, snapshotId: snapshot.id }]);
  const symbols: CodeSymbol[] = files.map((file, index) => ({
    id: `s${index}`, snapshotId: snapshot.id, repositoryId: repo.id, path: file.path, qualifiedName: `f${index}`,
    kind: 'function', signature: null, startLine: 2, endLine: 20, contentHash: `symbol:${index}`, source: 'fixture',
  }));
  store.insertSymbols(symbols);
  const measured = (id: string, name: string, value: number, analyzer: string) => ({ snapshotId: snapshot.id, subjectId: id, name, value, analyzer });
  store.insertMetrics(symbols.flatMap((symbol, index) => [
    measured(symbol.id, 'cyclomatic_complexity', [20, 1, 30, 10][index]!, 'tree-sitter-metrics-v1'),
    measured(symbol.id, 'fan_in', index === 0 ? 20 : 0, 'observed-graph-metrics-v1'),
    measured(symbol.path, 'commit_count', index === 0 ? 20 : 1, 'git'),
  ]));
  store.setSnapshotMetadata(snapshot.id, 'scip_diagnostics', JSON.stringify({ indexers: [{ status: 'complete' }] }));
  const finding: Finding = { id: 'finding', snapshotId: snapshot.id, repositoryId: repo.id, ruleId: 'COMPLEX', severity: 'high',
    confidence: 0.9, claim: 'A confirmed fixture finding', recommendation: 'Inspect the documented branches', module: 'src',
    status: 'confirmed', supersededBy: null, createdAt: '2026-01-01' };
  const addFinding = (entry: Finding, path = files[0]!.path, startLine = 2) => store.insertFinding(entry, [{ id: `proof:${entry.id}`,
    ownerId: entry.id, ownerKind: 'finding', path, startLine, endLine: 10, excerpt: 'PRIVATE_RAW_SOURCE' }]);
  addFinding(finding);
  addFinding({ ...finding, id: 'candidate', status: 'candidate' });
  addFinding({ ...finding, id: 'rejected', status: 'rejected' });
  addFinding({ ...finding, id: 'missing-file' }, 'not-indexed.ts');
  addFinding({ ...finding, id: 'bad-lines' }, files[0]!.path, 80);
  return { store, snapshot, files, symbols, finding, addFinding };
}

test('hotspots combine measured factors, exclude tests, paginate and expose coverage/indexing uncertainty', async () => {
  const { store, snapshot } = await fixture();
  try {
    const report = listHotspots(store, snapshot.id, { limit: 1 });
    expect(report.consideredSymbols).toBe(3); expect(report.excludedTestSymbols).toBe(1);
    expect(report.total).toBe(2); expect(report.nextOffset).toBe(1);
    const hot = report.items[0]!;
    expect(hot.symbolId).toBe('s0'); expect(hot.range.maximum).toBe(100);
    expect(hot.range.minimum).toBeLessThan(100);
    expect(hot.factors.find((factor) => factor.id === 'coverage_gap')).toMatchObject({ status: 'unknown', value: null, multiplier: null });
    expect(hot.factors.find((factor) => factor.id === 'churn')!.subjectId).toBe('src/hot.ts');
    expect(listHotspots(store, snapshot.id, { offset: 1, limit: 1 }).items[0]!.symbolId).toBe('s3');
    expect(listHotspots(store, snapshot.id, { module: 'src' }).items).toHaveLength(1);
    expect(listHotspots(store, snapshot.id, { module: 'root' }).items).toHaveLength(0); // Exact owner; no silent descendant expansion.
    expect(() => listHotspots(store, snapshot.id, { module: 'service' })).toThrow('ambiguous');
    expect(() => listHotspots(store, snapshot.id, { module: 'absent' })).toThrow('Unknown');
    for (const options of [{ limit: 0 }, { limit: 201 }, { offset: -1 }, { offset: 0.5 }]) {
      expect(() => listHotspots(store, snapshot.id, options)).toThrow();
    }
    store.setSnapshotMetadata(snapshot.id, 'scip_diagnostics', '{}');
    const partial = listHotspots(store, snapshot.id).items.find((entry) => entry.symbolId === 's3')!;
    expect(partial.factors.find((factor) => factor.id === 'fan_in')).toMatchObject({ value: 0, status: 'observed', maximumMultiplier: 4 });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_RAW_SOURCE');
  } finally { store.close(); }
});

test('coverage uses matching source hashes and only reported lines in the symbol; stale/unverified reports stay unknown', async () => {
  const { store, snapshot, files } = await fixture();
  try {
    const record: CoverageRecord = { snapshotId: snapshot.id, path: files[0]!.path, analyzer: 'fixture-lcov', sourceHash: files[0]!.contentHash,
      lineRate: 1, branchRate: null, lines: [{ line: 2, hits: 0 }, { line: 3, hits: 0 }, { line: 40, hits: 100 }],
      provenance: { sourceBinding: 'reported-lines-verified' } };
    store.insertCoverage([record]);
    const hot = listHotspots(store, snapshot.id).items[0]!;
    expect(hot.priority).toBe(100); expect(hot.range).toEqual({ minimum: 100, maximum: 100 });
    expect(hot.coverage.reportedLines).toBe(2); expect(hot.coverage.coveredLines).toBe(0);
    expect(hot.factors.find((factor) => factor.id === 'coverage_gap')!.value).toBe(1); // Do not use the misleading whole-file rate.
    for (const invalid of [
      { ...record, sourceHash: 'old-source' }, { ...record, provenance: { sourceBinding: 'unverified' } },
      { ...record, lines: [{ line: 40, hits: 0 }] }, { ...record, lines: [{ line: 2, hits: 0 }, { line: 2, hits: 1 }] },
      { ...record, lines: [{ line: 2, hits: -1 }] },
    ]) {
      store.insertCoverage([invalid]);
      expect(listHotspots(store, snapshot.id).items[0]!.factors.find((factor) => factor.id === 'coverage_gap')!.status).toBe('unknown');
    }
  } finally { store.close(); }
});

test('opportunities persist only confirmed findings with evidence plus hotspots, cache repeats and reject stale/historical evidence', async () => {
  const { store, snapshot, finding } = await fixture();
  try {
    expect(improvementOpportunities(store, snapshot.id).status).toBe('not_generated');
    const first = refreshOpportunities(store, snapshot.id);
    expect(first).toMatchObject({ cached: false, count: 3, omittedFindings: 2 });
    const report = improvementOpportunities(store, snapshot.id);
    expect(report.status).toBe('current'); expect(report.items[0]!.sourceId).toBe('finding');
    expect(report.items.every((entry) => entry.evidence.length > 0)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_RAW_SOURCE');
    const id = report.items[0]!.id;
    expect(opportunityEvidence(store, snapshot.id, id)!.evidence[0]!.path).toBe('src/hot.ts');
    expect(report.items[0]!.details['effort']).toBe('unknown');
    expect(refreshOpportunities(store, snapshot.id)).toMatchObject({ cached: true, count: 3 });
    expect(improvementOpportunities(store, snapshot.id)).toEqual(report);
    store.insertMetrics([{ snapshotId: snapshot.id, subjectId: 's0', name: 'fan_in', value: 10, analyzer: 'observed-graph-metrics-v1' }]);
    expect(improvementOpportunities(store, snapshot.id)).toMatchObject({ status: 'stale', total: 0, items: [] });
    expect(opportunityEvidence(store, snapshot.id, id)).toBeNull();
    refreshOpportunities(store, snapshot.id);
    expect(improvementOpportunities(store, snapshot.id).items.map((entry) => entry.id).sort()).toEqual(report.items.map((entry) => entry.id).sort());
    store.insertFinding({ ...finding, status: 'rejected' });
    refreshOpportunities(store, snapshot.id);
    expect(improvementOpportunities(store, snapshot.id).total).toBe(2);
    expect(store.getEvidence(id)).toHaveLength(0);
    const next = store.createSnapshot({ repositoryId: snapshot.repositoryId, commitSha: 'next' });
    expect(opportunityEvidence(store, next.id, id)).toBeNull();
    expect(listHotspots(store, next.id).items).toHaveLength(0);
    refreshOpportunities(store, next.id);
    expect(improvementOpportunities(store, next.id)).toMatchObject({ status: 'current', total: 0 });
    expect(store.listOpportunities(snapshot.id, OPPORTUNITY_ANALYZER)).toHaveLength(2);
  } finally { store.close(); }
});

test('projection replacement is atomic, preserves legacy rows and rejects mixed owners', async () => {
  const { store, snapshot } = await fixture();
  try {
    store.db.prepare('INSERT INTO opportunities(id,snapshot_id,title,description,created_at) VALUES (?,?,?,?,?)')
      .run('legacy', snapshot.id, 'User suggestion', 'Preserve me', '2025');
    refreshOpportunities(store, snapshot.id);
    const existing = store.listOpportunities(snapshot.id, OPPORTUNITY_ANALYZER);
    const proof = store.getEvidence(existing[0]!.id)[0]!;
    expect(() => store.replaceOpportunities(snapshot.id, OPPORTUNITY_ANALYZER, existing, [proof, proof])).toThrow();
    expect(store.listOpportunities(snapshot.id, OPPORTUNITY_ANALYZER)).toEqual(existing);
    expect(store.getEvidence(existing[0]!.id)).toEqual([proof]);
    expect(() => store.replaceOpportunities(snapshot.id, OPPORTUNITY_ANALYZER, existing, [{ ...proof, ownerId: 'other' }])).toThrow('Invalid');
    expect(store.db.prepare('SELECT title FROM opportunities WHERE id=?').get('legacy')).toEqual({ title: 'User suggestion' });
  } finally { store.close(); }
});

test('confirmed module findings retain module evidence without pretending it is a source file', async () => {
  const { store, snapshot, finding } = await fixture();
  try {
    store.insertFinding({ ...finding, id: 'cohesion', module: null }, [{ id: 'module-proof', ownerId: 'cohesion', ownerKind: 'finding',
      path: 'src', startLine: null, endLine: null, excerpt: '{"dependency_components":4}' }]);
    refreshOpportunities(store, snapshot.id);
    const entry = improvementOpportunities(store, snapshot.id).items.find((item) => item.sourceId === 'cohesion')!;
    expect(entry.module).toBe('src');
    expect(entry.details['sourceEvidence']).toEqual([{ evidenceId: 'module-proof', path: 'src', startLine: null, endLine: null,
      kind: 'module', sourceHash: null, moduleId: 'src' }]);
    expect(opportunityEvidence(store, snapshot.id, entry.id)!.evidence).toHaveLength(1);
  } finally { store.close(); }
});
