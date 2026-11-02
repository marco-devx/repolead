import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';
import { refreshRepository, scanRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';

import { analyzeSnapshot } from './analyze';
import { planFileAnalysis } from './file-analysis';
import { synthesizeComplete } from './bounded-synthesis';
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
