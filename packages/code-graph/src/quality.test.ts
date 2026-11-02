import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';

import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { buildFilePack, buildSymbolPack, listSourceFiles } from '@repolead/lead-analyzer';
import { DETECTORS, loadPolicies } from '@repolead/policy-engine';

import { qualityFixture } from '../test-support/quality-fixture';
import { collectQuality } from './quality';
import { scanRepository } from './scan';
import { refreshRepository } from './refresh';

test('real jscpd reads captured source, caches unchanged reports, and feeds evidence-backed policies', async () => {
  const { root, write } = qualityFixture();
  const scan = await scanRepository({ rootPath: root, scip: false });
  const store = await openStore(scan.dbPath);
  try {
    // Dirty working copy differs; analyzers must still inspect the indexed snapshot.
    write('src/two.ts', 'export const removedDuplicate = 0;\n');
    const result = await collectQuality({ store, snapshotId: scan.snapshotId, tools: ['jscpd'] });
    expect(result.tools['jscpd']?.status).toBe('complete');
    expect(result.tools['jscpd']?.cached).toBe(false);
    expect(store.listQualityIssues(scan.snapshotId).some((issue) => issue.locations.some((location) => location.path === 'src/two.ts'))).toBe(true);
    const issueCount = store.listQualityIssues(scan.snapshotId).length;
    const symbol = store.listSymbols(scan.snapshotId).find((entry) => entry.path === 'src/one.ts')!;
    const pack = buildSymbolPack(store, scan.snapshotId, root, symbol, 4000);
    expect(JSON.stringify(pack.pack)).toContain('quality:jscpd');
    const repeat = await collectQuality({ store, snapshotId: scan.snapshotId, tools: ['jscpd'] });
    expect(repeat.tools['jscpd']?.cached).toBe(true);
    expect(buildSymbolPack(store, scan.snapshotId, root, symbol, 4000).pack).toEqual(pack.pack);
    expect(store.listQualityIssues(scan.snapshotId)).toHaveLength(issueCount);
    expect(DETECTORS['tool_issue']!(store, scan.snapshotId, { analyzer: 'quality:jscpd' }).length).toBeGreaterThan(0);
    const errors = DETECTORS['metric_threshold']!(store, scan.snapshotId, { metric: 'empty_catches', threshold: 1 });
    expect(errors).toHaveLength(1); expect(errors[0]!.claim).toContain('bad');
    expect(errors[0]!.evidence.some((entry) => entry.kind === 'source_excerpt' && entry.excerpt?.includes('perform()'))).toBe(true);
    const complexity = DETECTORS['metric_threshold']!(store, scan.snapshotId, { metric: 'cyclomatic_complexity', threshold: 15 });
    expect(complexity).toHaveLength(1); expect(complexity[0]!.claim).toContain('complex');
    const policies = loadPolicies(join(process.cwd(), 'policies'));
    expect(policies.length).toBeGreaterThanOrEqual(8);
    const persistence = policies.find((policy) => policy.id === 'ARCH-PERSISTENCE-001')!;
    expect(DETECTORS[persistence.detectors[0]!.name]!(store, scan.snapshotId, persistence.detectors[0]!.params ?? {})).toHaveLength(1);
    const missing = await collectQuality({ store, snapshotId: scan.snapshotId, tools: ['jscpd'], env: { ...process.env, REPOLEAD_JSCPD_BIN: '/not-installed/jscpd' } });
    expect(missing.tools['jscpd']?.status).toBe('unavailable');
    expect(store.listQualityIssues(scan.snapshotId)).toEqual([]);
    expect(store.listMetrics(scan.snapshotId).some((metric) => metric.analyzer === 'quality:jscpd')).toBe(false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('coverage-only updates invalidate analysis facts and unavailable reports do not leave stale rates', async () => {
  const { root, write } = qualityFixture();
  const scan = await scanRepository({ rootPath: root, scip: false });
  const store = await openStore(scan.dbPath);
  try {
    const symbol = store.listSymbols(scan.snapshotId).find((entry) => entry.path === 'src/one.ts')!;
    const before = buildSymbolPack(store, scan.snapshotId, root, symbol, 4000).pack;
    await collectQuality({ store, snapshotId: scan.snapshotId, coveragePath: 'coverage/lcov.info' });
    const coverage = store.listCoverage(scan.snapshotId);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.lineRate).toBe(2 / 3); expect(coverage[0]!.branchRate).toBe(0.5);
    expect(coverage[0]!.sourceHash).toBe(contentHash(store.getSnapshotSource(scan.snapshotId, 'src/one.ts')!));
    expect(coverage[0]!.provenance['sourceBinding']).toBe('unverified');
    const after = buildSymbolPack(store, scan.snapshotId, root, symbol, 4000).pack;
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(store.listMetrics(scan.snapshotId, symbol.id).find((metric) => metric.name === 'line_coverage')?.value).toBe(2 / 3);
    const file = listSourceFiles(store, scan.snapshotId).find((entry) => entry.path === 'src/one.ts')!;
    expect(JSON.stringify(buildFilePack(store, scan.snapshotId, root, file, [symbol], [], 4000).pack)).toContain('line_coverage');
    write('coverage/lcov.info', 'SF:src/one.ts\nDA:2,1');
    const invalid = await collectQuality({ store, snapshotId: scan.snapshotId, coveragePath: 'coverage/lcov.info' });
    expect(invalid.coverage?.status).toBe('failed');
    expect(store.listCoverage(scan.snapshotId)).toEqual([]);
    expect(store.listMetrics(scan.snapshotId).some((metric) => metric.name === 'line_coverage')).toBe(false);
    expect(store.qualityFacts(scan.snapshotId, symbol.id, symbol.path).coverage).toEqual({ status: 'unknown' });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('refresh imports changed untracked coverage even when the code snapshot is current', async () => {
  const { root, write, git } = qualityFixture();
  write('.repolead.yaml', 'metrics:\n  coverage: coverage/lcov.info\n');
  git('add', '.repolead.yaml');
  const scan = await scanRepository({ rootPath: root, scip: false });
  let store = await openStore(scan.dbPath);
  try { expect(store.listCoverage(scan.snapshotId)[0]!.lineRate).toBe(2 / 3); } finally { store.close(); }
  write('coverage/lcov.info', 'SF:src/one.ts\nDA:2,1\nDA:3,1\nDA:4,1\nend_of_record\n');
  try {
    const refreshed = await refreshRepository({ rootPath: root, scip: false });
    expect(refreshed.upToDate).toBe(true);
    store = await openStore(scan.dbPath);
    expect(store.listCoverage(scan.snapshotId)[0]!.lineRate).toBe(1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
