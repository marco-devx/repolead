import { expect, test } from '@rstest/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, fileUri, stableSymbolId } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { buildEvidenceContext } from './evidence-context';
import { sourceDocument } from './source-excerpts';
import { countTokens } from './tokens';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repolead-evidence-'));
  const store = await openStore(':memory:');
  const repo = store.upsertRepository({ name: 'evidence', rootPath: root });
  const snapshot = store.createSnapshot({ repositoryId: repo.id, commitSha: 'abc' });
  const add = (path: string, name: string, content: string) => {
    writeFileSync(join(root, path), content);
    store.insertFiles([{ id: fileUri(repo.name, path), repositoryId: repo.id, snapshotId: snapshot.id, path, language: 'typescript',
      contentHash: contentHash(content), lineCount: content.split('\n').length, lastAuthor: null, lastCommitAt: null }]);
    store.insertSnapshotSources(snapshot.id, [{ path, content, contentHash: contentHash(content) }]);
    const id = stableSymbolId({ repository: repo.name, path, qualifiedName: name, kind: 'function' });
    store.insertSymbols([{ id, repositoryId: repo.id, snapshotId: snapshot.id, path, qualifiedName: name, kind: 'function',
      signature: null, source: 'tree-sitter', contentHash: contentHash(content), startLine: 1, endLine: content.split('\n').length }]);
    return id;
  };
  const id = add('payment.ts', 'refund', 'export function refund(amount: number) {\n  if (amount < 0) throw new RangeError("negative");\n  return amount * 1.2;\n}');
  for (let i = 0; i < 12; i += 1) { add(`refund${i}.test.ts`, `refundTest${i}`, `export function refundTest${i}() { return "refund refund refund negative ${i}"; }`); }
  const unusual = add('check.ts', 'refundCheck', 'export function refundCheck() { return "refund refund refund"; }');
  store.insertTests([{ id: 'unusual-test', snapshotId: snapshot.id, path: 'check.ts', name: 'refund test' }]);
  const leaf = { id: 'leaf-evidence', kind: 'source' as const, path: 'payment.ts', startLine: 2, endLine: 3, contentHash: 'record', parentIds: [] };
  store.insertEvidenceRecord(leaf);
  const parent = { ...leaf, id: 'derived-evidence', kind: 'symbol' as const, startLine: null, endLine: null, parentIds: [leaf.id] };
  store.insertSummary({ id: 'memory', snapshotId: snapshot.id, subjectId: 'product://evidence', level: 'product', model: 'contract', promptVersion: '1', contentHash: 'input',
    contentJson: JSON.stringify({ objective: 'Refund policy', features: [{ claim: 'Refund approval requires a manager', basis: 'documented', evidenceIds: [parent.id] }], unknowns: ['Whether manager approval is implemented is unknown'], evidenceIds: [parent.id] }), createdAt: '2026-01-01' }, [parent]);
  store.rebuildSearchIndex(snapshot.id);
  return { store, snapshot, root, id, unusual, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('evidence batch filters tests before lexical LIMIT, deduplicates sources and enforces the complete response budget', async () => {
  const f = await fixture();
  try {
    expect(f.store.searchKnowledge(f.snapshot.id, 'refund', 1, { entityKinds: ['symbol'], excludeTests: true }).map((hit) => hit.item.id)).toEqual([f.id]);
    expect(f.store.matchesKnowledge(f.store.getKnowledgeItem(f.snapshot.id, f.unusual)!, { excludeTests: true })).toBe(false);
    const result = await buildEvidenceContext({ store: f.store, snapshotId: f.snapshot.id, collection: 'unused', queries: ['refund', 'negative refund'], types: ['symbol'], maxTokens: 1600 });
    expect(result.includedIds).toEqual([f.id]); expect(result.queryCoverage).toEqual([1, 1]);
    expect(result.text).toContain('2\t  if (amount < 0) throw new RangeError("negative");');
    expect(result.text).not.toContain('refundTest'); expect(result.text).not.toContain('refundCheck');
    expect(result.tokens).toBe(countTokens(result.text)); expect(result.tokens).toBeLessThanOrEqual(1600);
    const tests = await buildEvidenceContext({ store: f.store, snapshotId: f.snapshot.id, collection: 'unused', queries: ['refundTest'], types: ['symbol'], includeTests: true, maxTokens: 1600 });
    expect(tests.text).toContain('.test.ts');
    writeFileSync(join(f.root, 'payment.ts'), 'DO NOT LEAK UNINDEXED WORKING TREE');
    const stale = await buildEvidenceContext({ store: f.store, snapshotId: f.snapshot.id, collection: 'unused', queries: ['refund'], types: ['symbol'] });
    expect(stale.includedIds).toEqual([]); expect(stale.text).toContain('source changed since indexing');
    expect(stale.text).not.toContain('DO NOT LEAK');
  } finally { f.close(); }
});

test('stored memory includes its uncertainty, basis and transitive locations without reading raw source', async () => {
  const f = await fixture();
  try {
    rmSync(join(f.root, 'payment.ts'));
    const result = await buildEvidenceContext({ store: f.store, snapshotId: f.snapshot.id, collection: 'unused', queries: ['refund manager approval'], includeSource: false, maxTokens: 2000 });
    expect(result.text).toContain('basis: documented'); expect(result.text).toContain('implemented is unknown');
    expect(result.text).toContain('payment.ts:2-3'); expect(result.text).not.toContain('return amount');
    f.store.db.prepare('UPDATE summaries SET content_json = ? WHERE id = ?').run(JSON.stringify({ objective: 'different refund policy' }), 'memory');
    const stale = await buildEvidenceContext({ store: f.store, snapshotId: f.snapshot.id, collection: 'unused', queries: ['refund'], includeSource: false });
    expect(stale.text).toContain('Summary search projection changed'); expect(stale.text).not.toContain('different refund policy');
    f.store.createSnapshot({ repositoryId: f.snapshot.repositoryId, commitSha: 'next' });
    await expect(buildEvidenceContext({ store: f.store, snapshotId: f.snapshot.id, collection: 'unused', queries: ['refund'], includeSource: false })).rejects.toThrow('changed during retrieval');
  } finally { f.close(); }
});

test('conversation receipts reuse exact validated blocks and never hide stale or missing evidence', async () => {
  const f = await fixture();
  try {
    const options = { store: f.store, snapshotId: f.snapshot.id, collection: 'unused', queries: ['refund'], types: ['symbol' as const], maxTokens: 2000 };
    const first = await buildEvidenceContext({ ...options, knownBlocks: [] });
    const hashes = first.blocks.map((block) => block.hash);
    expect(first.blocks).toHaveLength(1); expect(first.reusedBlocks).toBe(0);
    expect(first.text).toContain(`sha256=${hashes[0]}`);
    const repeat = await buildEvidenceContext({ ...options, knownBlocks: hashes });
    expect(repeat.reusedBlocks).toBe(1); expect(repeat.includedIds).toEqual(first.includedIds);
    expect(repeat.queryCoverage).toEqual(first.queryCoverage);
    expect(repeat.text).toContain('UNCHANGED'); expect(repeat.text).not.toContain('return amount');
    expect(repeat.text).toContain('still present in this conversation');
    expect(repeat.tokens).toBe(countTokens(repeat.text));
    const missing = await buildEvidenceContext({ ...options, knownBlocks: ['0'.repeat(64)] });
    expect(missing.reusedBlocks).toBe(0); expect(missing.text).toContain('return amount');
    const hidden = await buildEvidenceContext({ ...options, includeSource: false, knownBlocks: hashes });
    expect(hidden.reusedBlocks).toBe(0); expect(hidden.text).not.toContain('return amount');
    writeFileSync(join(f.root, 'payment.ts'), 'UNINDEXED CHANGE');
    const stale = await buildEvidenceContext({ ...options, knownBlocks: hashes });
    expect(stale.reusedBlocks).toBe(0); expect(stale.includedIds).toEqual([]);
    expect(stale.text).toContain('source changed since indexing');
    await expect(buildEvidenceContext({ ...options, knownBlocks: ['invalid'] })).rejects.toThrow('SHA-256');
    await expect(buildEvidenceContext({ ...options, knownBlocks: Array(129).fill('0'.repeat(64)) })).rejects.toThrow('128');
  } finally { f.close(); }
});

test('memory receipts change with claims and preserve unknowns on replay', async () => {
  const f = await fixture();
  try {
    const options = { store: f.store, snapshotId: f.snapshot.id, collection: 'unused', queries: ['refund'], includeSource: false, maxTokens: 2000 };
    const first = await buildEvidenceContext({ ...options, knownBlocks: [] });
    const hashes = first.blocks.map((block) => block.hash);
    expect(first.text).toContain('implemented is unknown');
    expect((await buildEvidenceContext({ ...options, knownBlocks: hashes })).reusedBlocks).toBe(1);
    f.store.db.prepare('UPDATE summaries SET content_json = ? WHERE id = ?').run(JSON.stringify({ objective: 'Refund changed', unknowns: ['Refund implementation not verified'] }), 'memory');
    f.store.rebuildSearchIndex(f.snapshot.id);
    const changed = await buildEvidenceContext({ ...options, knownBlocks: hashes });
    expect(changed.reusedBlocks).toBe(0); expect(changed.text).toContain('Refund implementation not verified');
    expect(changed.blocks[0]!.hash).not.toBe(hashes[0]);
  } finally { f.close(); }
});

test('AST excerpts retain enclosing branches and earlier exit guards; malformed code is never reconstructed', async () => {
  const source = ['// Unicode 🦙 before the declaration', 'export function checkout(amount: number, enabled: boolean) {',
    '  if (amount < 0) throw new RangeError("negative");',
    ...Array.from({ length: 60 }, (_, index) => `  const padding${index} = "unrelated ${index}";`),
    '  if (enabled) {', '    return charge(amount);', '  } else {', '    return null;', '  }', '}'].join('\n');
  const doc = await sourceDocument('app.ts', source);
  try {
    const excerpt = doc.extract({ startLine: 2, endLine: source.split('\n').length }, 'charge enabled', 170);
    expect(excerpt.complete).toBe(false); expect(excerpt.omittedLines).toBeGreaterThan(0); expect(countTokens(excerpt.text)).toBeLessThanOrEqual(170);
    expect(excerpt.text).toContain('if (enabled)'); expect(excerpt.text).toContain('return charge(amount)');
    expect(excerpt.text).toContain('throw new RangeError'); expect(excerpt.text).toContain('return null');
    for (const line of excerpt.text.split('\n').filter((entry) => /^\d+\t/.test(entry))) {
      const [number, ...parts] = line.split('\t'); expect(parts.join('\t')).toBe(source.split('\n')[Number(number) - 1]);
    }
  } finally { doc.close(); }
  const malformed = await sourceDocument('broken.ts', source.replace('if (enabled)', 'if (enabled'));
  try { expect(malformed.extract({ startLine: 2, endLine: source.split('\n').length }, 'charge', 170).text).toBe(''); }
  finally { malformed.close(); }
});
