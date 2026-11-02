import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@rstest/core';

import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

import { importMutationReport, mutationPlan, mutationResults, runMutationPlan } from './mutation';

test('mutation plans select only exact hotspot spans; imports persist source-bound paginated statuses, not historical results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repolead-mutation-unit-')); const store = await openStore(':memory:');
  try {
    const repo = store.upsertRepository({ name: 'mutation-unit', rootPath: root });
    const snapshot = store.createSnapshot({ repositoryId: repo.id, commitSha: 'fixture' });
    const source = 'export function f(x) { return x > 0; }'; writeFileSync(join(root, 'code.js'), source);
    store.insertFiles([{ id: 'file', snapshotId: snapshot.id, repositoryId: repo.id, path: 'code.js', contentHash: contentHash(source), language: 'javascript', lineCount: 1, lastAuthor: null, lastCommitAt: null }]);
    store.insertSymbols([{ id: 'hot', snapshotId: snapshot.id, repositoryId: repo.id, path: 'code.js', qualifiedName: 'f', kind: 'function',
      signature: null, startLine: 1, endLine: 1, span: { startOffset: 0, endOffset: source.length, startColumn: 0, endColumn: source.length }, contentHash: contentHash(source), source: 'fixture' }]);
    const noTargets = mutationPlan(store, snapshot.id);
    expect(noTargets.targets).toHaveLength(0);
    await expect(runMutationPlan(store, noTargets, { testCommand: 'must never run' })).rejects.toThrow('No eligible hotspots');
    store.insertMetrics([{ snapshotId: snapshot.id, subjectId: 'file', name: 'commit_count', value: 5, analyzer: 'git' }]);
    const plan = mutationPlan(store, snapshot.id, { limit: 1 });
    expect(plan.targets).toHaveLength(1); expect(plan.targets[0]!.symbolId).toBe('hot');
    const reportPath = join(root, 'report.json');
    writeFileSync(reportPath, JSON.stringify({ schemaVersion: '1', files: { 'code.js': { source, mutants: [
      { id: '1', status: 'Killed', mutatorName: 'ConditionalExpression', location: { start: { line: 1, column: 32 }, end: { line: 1, column: 33 } } },
      { id: '2', status: 'Survived', mutatorName: 'EqualityOperator', location: { start: { line: 1, column: 32 }, end: { line: 1, column: 33 } } },
    ] } } }));
    const imported = importMutationReport(store, plan, reportPath);
    expect(imported.mutationScore).toBe(50);
    expect(importMutationReport(store, plan, reportPath).id).toBe(imported.id);
    const result = mutationResults(store, snapshot.id, { limit: 1 });
    expect(result.status).toBe('reported');
    if (result.status !== 'reported') { throw new Error('Missing imported report'); }
    expect(result.mutants).toMatchObject({ total: 2, nextOffset: 1 });
    expect(result.testFreshness).toContain('Unknown');
    expect(JSON.stringify(result)).not.toContain('return x');
    const { planHash: _hash, ...forged } = plan;
    forged.targets = [{ ...plan.targets[0]!, endColumn: 1 }];
    expect(() => importMutationReport(store, { ...forged, planHash: contentHash(JSON.stringify(forged)) }, reportPath)).toThrow('no longer matches');
    writeFileSync(join(root, 'code.js'), source + '// changed');
    await expect(runMutationPlan(store, plan, { testCommand: 'must never run' })).rejects.toThrow('Indexed file changed');
    const next = store.createSnapshot({ repositoryId: repo.id, commitSha: 'next' });
    expect(mutationResults(store, next.id, { reportId: imported.id }).status).toBe('not_available');
    expect(() => importMutationReport(store, plan, reportPath)).toThrow('snapshot changed');
    for (const limit of [0, 21, 1.5]) { expect(() => mutationPlan(store, next.id, { limit })).toThrow(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
