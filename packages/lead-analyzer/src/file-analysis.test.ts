import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';
import { refreshRepository, scanRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';

import { analyzeSnapshot } from './analyze';
import { planFileAnalysis } from './file-analysis';
import { synthesizeComplete, synthesizeFirstRound } from './bounded-synthesis';
import { evidenceEntry } from './hierarchy';
import { ContractModel } from '../test-support/contract-model';
import { createChainFixture } from '../test-support/chain-fixture';

test('file mode covers all source lines including late validation, reuses cache, and invalidates changed consumers only', async () => {
  const fixture = createChainFixture();
  const source = Array.from({ length: 40 }, (_, i) => `export class Request${i} { required = true; maxLength = ${i + 1}; }`).join('\n')
    + '\nexport function finalValidation(value: string) { if (!value) throw new Error("permission required"); return value; }\n';
  writeFileSync(join(fixture.root, 'src/leaf/price.ts'), source);
  try {
    const scan = await scanRepository({ rootPath: fixture.root, scip: false });
    const store = await openStore(scan.dbPath);
    try {
      const model = new ContractModel();
      const options = { store, snapshotId: scan.snapshotId, model, analysisMode: 'files' as const,
        budget: { maxTokens: 120000, filePackBytes: 4096, maxSourceLinesPerPack: 10, maxReanalysisDepth: 1 } };
      const plan = planFileAnalysis(options);
      const file = plan.plans.find((entry) => entry.file.path === 'src/leaf/price.ts')!;
      expect(file.packs.length).toBeGreaterThan(1);
      const covered = file.packs.flatMap((packed) => packed.evidence.filter((entry) => entry.kind === 'source')
        .flatMap((entry) => Array.from({ length: entry.endLine! - entry.startLine! + 1 }, (_, i) => entry.startLine! + i)));
      expect(covered).toEqual(Array.from({ length: source.split('\n').length }, (_, i) => i + 1));
      for (const packed of file.packs) {
        expect(packed.pack.truncation).toEqual({ omittedEvidence: 0, omittedSourceLines: 0 });
        expect(Buffer.byteLength(JSON.stringify(packed.pack))).toBeLessThanOrEqual(4096);
      }
      const first = await analyzeSnapshot(options);
      expect(first.briefGenerated).toBe(false);
      expect(store.listSummaries(scan.snapshotId, 'repository')).toEqual([]);
      expect(store.listSummaries(scan.snapshotId).every((summary) => !/#synthesis:[1-9]/.test(summary.subjectId))).toBe(true);
      expect(JSON.parse(store.getSnapshotMetadata(scan.snapshotId, 'technical_analysis')!)).toMatchObject({
        synthesisMode: 'first-round', status: 'complete', globalSummariesSkipped: true, completeSourceCoverage: true,
      });
      expect(first.symbolsAnalyzed).toBe(0);
      expect(first.symbolsSkipped).toBeGreaterThan(40);
      expect(model.packs.some((pack) => pack.subject.level === 'symbol')).toBe(false);
      expect(JSON.stringify(model.packs)).toContain('permission required');
      const calls = model.packs.length;
      expect(calls).toBeLessThan(plan.symbolsCovered);
      await analyzeSnapshot(options);
      expect(model.packs.length).toBe(calls);
      writeFileSync(join(fixture.root, 'src/leaf/price.ts'), source.replace('permission required', 'approval required'));
      const refreshed = await refreshRepository({ rootPath: fixture.root, scip: false });
      expect(store.getSnapshotMetadata(refreshed.scan!.snapshotId, 'synthesis_mode')).toBe('first-round');
      const next = { ...options, snapshotId: refreshed.scan!.snapshotId };
      await analyzeSnapshot(next);
      const changed = model.packs.slice(calls);
      expect(JSON.stringify(changed)).toContain('approval required');
      expect(changed.some((pack) => pack.subject.path === 'src/unrelated/format.ts')).toBe(false);
      const count = model.packs.length;
      await analyzeSnapshot(next);
      expect(model.packs.length).toBe(count);
    } finally { store.close(); }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('first-round synthesis reuses historical first-round packets and never produces another round or a global dossier', async () => {
  const store = await openStore(':memory:');
  try {
    const repo = store.upsertRepository({ name: 'first-round', rootPath: '/not-mounted' });
    const snapshot = store.createSnapshot({ repositoryId: repo.id, commitSha: 'fixture' });
    const model = new ContractModel();
    const { analyzeSubject } = await import('./analyze');
    const entries = Array.from({ length: 35 }, (_, i) => evidenceEntry('source', `src/part${i}.ts`,
      { source: `unique_rule_${i}: ${'complete condition '.repeat(15)}` }));
    const subject = { id: 'module://first-round/root', name: 'first-round', path: '.', level: 'module' as const };
    const limits = { maxTokens: 120000, maxBytes: 4096 };
    const run = async (input: Parameters<Parameters<typeof synthesizeComplete>[3]>[0]) =>
      (await analyzeSubject({ store, snapshotId: snapshot.id, model }, input.pack, input.evidence)).summary;
    await synthesizeComplete(subject, entries, limits, run);
    const initial = model.packs.length;
    const rounds: number[] = [];
    const groups = await synthesizeFirstRound(subject, entries, limits, run, {}, (count) => rounds.push(count));
    expect(groups.length).toBeGreaterThan(1);
    expect(rounds).toEqual([groups.length]);
    expect(model.packs).toHaveLength(initial);
    expect(groups.every((summary) => /#synthesis:0:\d+$/.test(summary.subjectId))).toBe(true);
    const generated: string[] = [];
    await synthesizeFirstRound({ ...subject, id: 'fresh-module' }, entries, limits, async (input) => {
      generated.push(input.pack.subject.id);
      return run(input);
    });
    expect(generated).toHaveLength(groups.length);
    expect(generated.every((id) => /^fresh-module#synthesis:0:\d+$/.test(id))).toBe(true);
    store.setSnapshotMetadata(snapshot.id, 'synthesis_mode', 'first-round');
    expect(store.listVisibleSummaries(snapshot.id).every((summary) => /#synthesis:0:\d+$/.test(summary.subjectId))).toBe(true);
    expect(store.getSummary(snapshot.id, subject.id, 'module')).not.toBeNull();
  } finally { store.close(); }
});

test('bounded synthesis consumes every child instead of dropping the tail', async () => {
  const store = await openStore(':memory:');
  try {
    const repository = store.upsertRepository({ name: 'complete', rootPath: '/not-mounted' });
    const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'fixture' });
    const model = new ContractModel();
    const { analyzeSubject } = await import('./analyze');
    const entries = Array.from({ length: 35 }, (_, i) => evidenceEntry('source', `src/file${i}.ts`,
      { source: `rule_${i}: ${'exact constraint '.repeat(15)}` }, { startLine: 1, endLine: 1 }));
    const summary = await synthesizeComplete({ id: 'module://complete', name: 'complete', level: 'module' }, entries,
      { maxTokens: 120000, maxBytes: 4096 }, async (input) => (await analyzeSubject(
        { store, snapshotId: snapshot.id, model }, input.pack, input.evidence)).summary);
    expect(summary.subjectId).toBe('module://complete');
    expect(model.packs.length).toBeGreaterThan(1);
    for (const entry of entries) {
      expect(model.packs.some((pack) => pack.evidence.some((evidence) => evidence.path === entry.record.path))).toBe(true);
    }
    expect(model.packs.every((pack) => pack.truncation.omittedEvidence === 0)).toBe(true);
    const before = model.packs.length;
    await expect(synthesizeComplete({ id: 'oversize', name: 'oversize', level: 'module' },
      [evidenceEntry('source', 'large.ts', { source: 'x'.repeat(10000) })], { maxTokens: 120000, maxBytes: 4096 },
      async () => { throw new Error('must not generate'); })).rejects.toThrow('No evidence was silently dropped');
    expect(model.packs.length).toBe(before);
  } finally { store.close(); }
});
