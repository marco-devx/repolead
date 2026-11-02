import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from '@rstest/core';
import { contentHash, fileUri, moduleUri, stableSymbolId } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { countTokens } from '@repolead/retrieval';

import { analyzeSnapshot } from './analyze';
import { buildSymbolPack } from './hierarchy';
import type { HierarchicalPack } from './hierarchy';
import type { TechLeadModel } from './model';
import { validateSummary } from './prompts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); } });

class RecordingModel implements TechLeadModel {
  readonly name = 'recording-v1';
  packs: HierarchicalPack[] = [];
  invalidResponses = 0;
  malformed = false;

  complete(request: { prompt: string; schema: Record<string, unknown> }): ReturnType<TechLeadModel['complete']> {
    const pack = JSON.parse(request.prompt.split('Evidence pack:\n')[1]!.split('\n\nReturn ')[0]!) as HierarchicalPack;
    this.packs.push(pack);
    const json: Record<string, unknown> = {};
    // Produce the exact declared output shape; meaningful assertions below inspect the supplied evidence, not invented behavior.
    const empty = (schema: Record<string, unknown>): unknown => {
      if (schema['type'] === 'array') { return []; }
      if (schema['type'] === 'object') {
        return Object.fromEntries(Object.entries(schema['properties'] as Record<string, Record<string, unknown>>)
          .map(([key, value]) => [key, empty(value)]));
      }
      return 'supported by indexed evidence';
    };
    Object.assign(json, empty(request.schema));
    json['evidenceIds'] = pack.evidence.map((entry) => entry.id);
    if (this.invalidResponses > 0) {
      this.invalidResponses -= 1;
      json['evidenceIds'] = ['ev_fabricated'];
    }
    return Promise.resolve({ json: this.malformed ? { unexpected: true } : json, inputTokens: 100, outputTokens: 20 });
  }
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repolead-hierarchy-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  const source = 'export function price(amount: number) {\n  return amount * 2;\n}\n';
  writeFileSync(join(root, 'src/price.ts'), source);
  const store = await openStore(':memory:');
  const repository = store.upsertRepository({ name: 'shop', rootPath: root });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'initial' });
  const module = { id: moduleUri('shop', 'root'), repositoryId: repository.id, snapshotId: snapshot.id, name: 'shop', path: '.' };
  store.insertModules([module]);
  const symbol = { id: stableSymbolId({ repository: 'shop', path: 'src/price.ts', kind: 'function', qualifiedName: 'price' }),
    repositoryId: repository.id, snapshotId: snapshot.id, path: 'src/price.ts', qualifiedName: 'price',
    kind: 'function' as const, signature: '(amount: number)', startLine: 1, endLine: 3,
    contentHash: contentHash(source.trimEnd()), source: 'tree-sitter' };
  store.insertSymbols([symbol]);
  store.insertFiles([{ id: fileUri('shop', symbol.path), repositoryId: repository.id, snapshotId: snapshot.id,
    path: symbol.path, language: 'typescript', contentHash: contentHash(source), lineCount: 4, lastAuthor: null, lastCommitAt: null }]);
  return { root, store, snapshot, repository, symbol, source };
}

test('source → symbol → file → module → repository, with persisted provenance and zero-call repeat', async () => {
  const { store, snapshot, symbol } = await fixture();
  try {
    const model = new RecordingModel();
    const result = await analyzeSnapshot({ store, snapshotId: snapshot.id, model, budget: { maxTokens: 2000 } });
    expect(model.packs.map((pack) => pack.subject.level)).toEqual(['symbol', 'file', 'module', 'repository']);
    expect(JSON.stringify(model.packs[0])).toContain('return amount * 2');
    expect(model.packs[0]!.truncation.omittedSourceLines).toBe(0);
    expect(result.inputTokens).toBe(400);
    for (const pack of model.packs) { expect(countTokens(JSON.stringify(pack))).toBeLessThanOrEqual(2000); }
    expect(store.getSummary(snapshot.id, symbol.id, 'symbol')).not.toBeNull();
    expect(model.packs[1]!.evidence.some((entry) => entry.kind === 'symbol')).toBe(true);
    expect(model.packs[2]!.evidence.some((entry) => entry.kind === 'file')).toBe(true);
    expect(model.packs[3]!.evidence.some((entry) => entry.kind === 'module')).toBe(true);
    for (const summary of store.listSummaries(snapshot.id)) {
      const records = store.getSummaryEvidence(summary.id);
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        for (const id of record.parentIds) { expect(store.getEvidenceRecord(id)).not.toBeNull(); }
      }
    }
    const repeat = await analyzeSnapshot({ store, snapshotId: snapshot.id, model, budget: { maxTokens: 2000 } });
    expect(repeat.inputTokens).toBe(0);
    expect(repeat.symbolsCached).toBe(1);
    expect(repeat.filesCached).toBe(1);
    expect(model.packs).toHaveLength(4);
  } finally { store.close(); }
});

test('large default analysis keeps source beyond the former 1200-line cutoff', async () => {
  const { root, store, snapshot, symbol } = await fixture();
  try {
    const source = ['export function price(amount: number) {', ...Array.from({ length: 1500 }, () => '  amount += 0;'), '  return amount;', '}'].join('\n');
    writeFileSync(join(root, symbol.path), source);
    store.db.prepare('UPDATE symbols SET content_hash = ?, end_line = ? WHERE id = ?')
      .run(contentHash(source), 1503, symbol.id);
    store.db.prepare('UPDATE files SET content_hash = ?, line_count = ? WHERE path = ?')
      .run(contentHash(source), 1503, symbol.path);
    const model = new RecordingModel();
    await analyzeSnapshot({ store, snapshotId: snapshot.id, model });
    expect(model.packs[0]!.truncation.omittedSourceLines).toBe(0);
    expect(JSON.stringify(model.packs[0])).toContain('1502\\t  return amount;');
  } finally { store.close(); }
});

test('rejects fabricated evidence and retries with a correction, accounting for both attempts', async () => {
  const { store, snapshot } = await fixture();
  try {
    const model = new RecordingModel();
    model.invalidResponses = 1;
    const result = await analyzeSnapshot({ store, snapshotId: snapshot.id, model });
    expect(model.packs).toHaveLength(5);
    expect(result.inputTokens).toBe(500);
    expect(store.listSummaries(snapshot.id)).toHaveLength(4);
    expect(JSON.stringify(store.listSummaries(snapshot.id))).not.toContain('ev_fabricated');
  } finally { store.close(); }
});

test('malformed output fails bounded retries without persisting unvalidated summaries', async () => {
  const { store, snapshot } = await fixture();
  try {
    const model = new RecordingModel();
    model.malformed = true;
    await expect(analyzeSnapshot({ store, snapshotId: snapshot.id, model, validationRetries: 1 })).rejects.toThrow();
    expect(model.packs).toHaveLength(2);
    expect(store.listSummaries(snapshot.id)).toHaveLength(0);
    const row = store.db.prepare('SELECT status, input_tokens FROM analysis_runs').get() as { status: string; input_tokens: number };
    expect(row.status).toBe('failed');
    expect(row.input_tokens).toBe(200);
  } finally { store.close(); }
});

test('changing analysis policy invalidates cache, and explicit snapshot never reads another snapshot', async () => {
  const { store, snapshot, repository } = await fixture();
  try {
    const model = new RecordingModel();
    await analyzeSnapshot({ store, snapshotId: snapshot.id, model });
    const original = store.getSummary(snapshot.id, `repo://${repository.name}`, 'repository')!;
    const other = store.upsertRepository({ name: 'other', rootPath: '/other' });
    store.createSnapshot({ repositoryId: other.id, commitSha: 'newer' });
    const cached = await analyzeSnapshot({ store, snapshotId: snapshot.id, model });
    expect(cached.inputTokens).toBe(0);
    const changed = await analyzeSnapshot({ store, snapshotId: snapshot.id, model, policyVersion: 'new-policy' });
    expect(changed.symbolsAnalyzed).toBe(1);
    expect(changed.filesAnalyzed).toBe(1);
    expect(changed.briefGenerated).toBe(true);
    expect(store.getSummary(snapshot.id, `repo://${repository.name}`, 'repository')).not.toBeNull();
    expect(store.getSummary(snapshot.id, 'repo://other', 'repository')).toBeNull();
    const calls = model.packs.length;
    await analyzeSnapshot({ store, snapshotId: snapshot.id, model });
    expect(model.packs).toHaveLength(calls);
    expect(store.getSummary(snapshot.id, `repo://${repository.name}`, 'repository')?.contentHash).toBe(original.contentHash);
  } finally { store.close(); }
});

test('source truncation and changed source cannot masquerade as a complete behavioral analysis', async () => {
  const { store, snapshot, symbol, source, root } = await fixture();
  try {
    const pack = buildSymbolPack(store, snapshot.id, root, symbol, 2000, 1);
    expect(pack.pack.truncation.omittedSourceLines).toBe(2);
    expect(JSON.stringify(pack.pack)).toContain('"complete":false');
    writeFileSync(join(root, symbol.path), source.replace('* 2', '* 3'));
    const model = new RecordingModel();
    await analyzeSnapshot({ store, snapshotId: snapshot.id, model });
    expect(JSON.stringify(model.packs[0])).not.toContain('return amount');
    const card = JSON.parse(store.getSummary(snapshot.id, symbol.id, 'symbol')!.contentJson) as { unknowns: string[] };
    expect(card.unknowns.some((message) => message.includes('Source unavailable'))).toBe(true);
    expect(card.unknowns.some((message) => message.includes('3 source lines'))).toBe(true);
  } finally { store.close(); }
});

test('nested claims cannot cite an omitted evidence entry', () => {
  expect(() => validateSummary('module', {
    responsibility: 'demo', publicApi: [], dependencies: { incoming: [], outgoing: [] }, mainFlows: [],
    strengths: [{ claim: 'made up', evidenceIds: ['omitted'] }], risks: [], opportunities: [],
    testStrategy: 'unknown', evidenceIds: ['allowed'], unknowns: [],
  }, new Set(['allowed']))).toThrow('Unknown or omitted evidence ID');
});
