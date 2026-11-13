import { expect, test } from '@rstest/core';

import { contentHash, fileUri, stableSymbolId } from '@repolead/domain';
import type { CodeSymbol, KnowledgeItem } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

import { EmbeddingInputError } from './embeddings';
import type { EmbeddingsClient } from './embeddings';
import { indexSnapshot } from './indexer';
import type { IndexProgress } from './indexer';
import type { QdrantHit, QdrantPoint, QdrantSearcher } from './qdrant';
import { symbolIdToPointId } from './qdrant';
import { hybridKnowledgeSearch } from './search';
import { buildEvidenceContext } from './evidence-context';

class Vectors implements QdrantSearcher {
  points = new Map<string, QdrantPoint>();
  writes = 0;
  updates = 0;
  prunes = 0;
  ensureCollection(): Promise<void> { return Promise.resolve(); }
  upsert(_name: string, points: QdrantPoint[]): Promise<void> {
    this.writes += points.length;
    for (const point of points) { this.points.set(point.id, point); }
    return Promise.resolve();
  }
  retrieve(_name: string, ids: string[]): Promise<QdrantPoint[]> { return Promise.resolve(ids.flatMap((id) => this.points.has(id) ? [this.points.get(id)!] : [])); }
  updatePayloads(_name: string, updates: { ids: string[]; payload: Record<string, unknown> }[]): Promise<void> {
    for (const update of updates) {
      for (const id of update.ids) { Object.assign(this.points.get(id)!.payload, update.payload); this.updates += 1; }
    }
    return Promise.resolve();
  }
  prune(_name: string, repository: string, generation: string): Promise<void> {
    this.prunes += 1;
    for (const [id, point] of this.points) {
      if (point.payload['repository'] === repository && point.payload['index_generation'] !== generation) { this.points.delete(id); }
    }
    return Promise.resolve();
  }
  search(): Promise<QdrantHit[]> { return Promise.resolve([...this.points.values()].map((point) => ({ ...point, score: 1 }))); }
}

async function fixture() {
  const store = await openStore(':memory:');
  const repository = store.upsertRepository({ name: 'search-fixture', rootPath: '/not-mounted' });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: '1' });
  const sources = [
    { path: 'src/billing/processor.ts', language: 'typescript', name: 'process', content: 'export function process() {\n  return "refund xylophonic payment";\n}' },
    { path: 'src/audit/log.py', language: 'python', name: 'record', content: 'def record():\n    return "refund audit trail"' },
  ];
  const files = sources.map((source) => ({ id: fileUri(repository.name, source.path), repositoryId: repository.id, snapshotId: snapshot.id,
    path: source.path, language: source.language, contentHash: contentHash(source.content), lineCount: source.content.split('\n').length, lastAuthor: null, lastCommitAt: null }));
  store.insertFiles(files);
  store.insertSnapshotSources(snapshot.id, sources.map((source) => ({ ...source, contentHash: contentHash(source.content) })));
  const symbols: CodeSymbol[] = sources.map((source) => ({ id: stableSymbolId({ repository: repository.name, path: source.path, kind: 'function', qualifiedName: source.name }),
    snapshotId: snapshot.id, repositoryId: repository.id, path: source.path, qualifiedName: source.name, kind: 'function', signature: null,
    startLine: 1, endLine: source.content.split('\n').length, contentHash: contentHash(source.content), source: 'tree-sitter' }));
  store.insertSymbols(symbols);
  store.insertModules(['billing', 'audit'].map((name) => ({ id: `module-${name}`, name, path: `src/${name}`, snapshotId: snapshot.id, repositoryId: repository.id })));
  store.insertDocuments([{ id: 'doc-product', snapshotId: snapshot.id, repositoryId: repository.id, path: 'docs/product.md', title: 'Refunds',
    content: '# Refunds\nCustomers request reimbursement.\n## Business rules\nOnly settled transactions are refundable.', contentHash: 'doc-hash' }]);
  store.insertSummary({ id: 'summary-1', snapshotId: snapshot.id, subjectId: repository.id, level: 'product', model: 'fixture', promptVersion: '1',
    contentHash: 'summary-hash', createdAt: '2026-01-01', contentJson: JSON.stringify({ purpose: 'Refund approval workflow', evidenceIds: ['evidence-summary'] }) });
  store.insertFinding({ id: 'finding-1', snapshotId: snapshot.id, repositoryId: repository.id, ruleId: 'ARCH-1', severity: 'high', confidence: 0.9,
    claim: 'Refund processor uses global state', recommendation: 'Isolate mutable state', module: 'billing', status: 'confirmed', supersededBy: null, createdAt: '2026-01-01' },
  [{ id: 'evidence-finding', ownerId: 'finding-1', ownerKind: 'finding', path: sources[0]!.path, startLine: 1, endLine: 3, excerpt: 'mutableRefundState' }]);
  store.insertTests([{ id: 'test-1', snapshotId: snapshot.id, path: 'src/billing/refund.test.ts', name: 'refund is idempotent' }]);
  store.rebuildSearchIndex(snapshot.id);
  return { store, repository, snapshot, sources, symbols, files };
}

function recordingEmbeddings(): EmbeddingsClient & { inputs: string[] } {
  const inputs: string[] = [];
  return { inputs, cacheKey: async () => 'pinned-fixture-v1', embed: async (texts) => { inputs.push(...texts); return texts.map(() => [0.5, 1]); } };
}

test('vector retrieval and reranking serve file analyses and first-round syntheses without global summaries', async () => {
  const { store, snapshot, repository, files } = await fixture();
  try {
    const add = (subjectId: string, level: 'file' | 'module' | 'repository', purpose: string) => store.insertSummary({
      id: subjectId, snapshotId: snapshot.id, subjectId, level, model: 'fixture', promptVersion: '1', contentHash: contentHash(purpose),
      createdAt: '2026-01-01', contentJson: JSON.stringify({ responsibility: purpose, unknowns: [], evidenceIds: [] }),
    });
    add(files[0]!.id, 'file', 'Refund approval requires a manager; only settled payments qualify.');
    add('module-billing#synthesis:0:1', 'module', 'Refund approvals group: manager permission and settled transaction checks.');
    add('module-billing#synthesis:1:1', 'module', 'Obsolete refund global approval synthesis');
    add('module-billing', 'module', 'Obsolete refund module global brief');
    add('repo://search-fixture', 'repository', 'Obsolete refund repository global brief');
    const embeddings = recordingEmbeddings(); const qdrant = new Vectors();
    const base = { store, snapshotId: snapshot.id, repositoryName: repository.name, collection: 'first-round', embeddings, qdrant };
    await indexSnapshot(base);
    store.setSnapshotMetadata(snapshot.id, 'synthesis_mode', 'first-round');
    // The old projection and old Qdrant points must not leak archived summaries, even before reindex.
    const oldResults = await hybridKnowledgeSearch({ ...base, query: 'obsolete refund', filters: { entityKinds: ['summary'] } });
    expect(oldResults.every((hit) => !hit.item.text.includes('Obsolete'))).toBe(true);
    await indexSnapshot(base);
    const items = store.listKnowledgeItems(snapshot.id, { entityKinds: ['summary'] });
    expect(items.map((item) => item.subjectId).sort()).toEqual([files[0]!.id, 'module-billing#synthesis:0:1'].sort());
    expect([...qdrant.points.values()].filter((point) => point.payload['entity_kind'] === 'summary')).toHaveLength(2);
    const results = await hybridKnowledgeSearch({ ...base, query: 'autorización de devoluciones', filters: { entityKinds: ['summary'] },
      reranker: { rerank: async (_query, documents) => documents.map((text) => text.includes('only settled') ? 1 : 0.1) } });
    expect(results[0]!.item.subjectId).toBe(files[0]!.id);
    expect(results[0]!.sources).toContain('vector'); expect(results[0]!.sources).toContain('rerank');
    const evidence = await buildEvidenceContext({ ...base, queries: ['autorización de devoluciones'], includeSource: false, types: ['summary'] });
    expect(evidence.text).toContain('only settled payments');
    expect(evidence.text).toContain('Refund approvals group');
    expect(evidence.text).not.toContain('Obsolete');
  } finally { store.close(); }
});

test('entrypoint indexing keeps all raw code but vector search serves only selected usecase/page analyses', async () => {
  const { store, snapshot, repository, files } = await fixture();
  try {
    for (const file of files) {
      store.insertSummary({ id: `summary-${file.id}`, snapshotId: snapshot.id, subjectId: file.id, level: 'file', model: 'fixture',
        promptVersion: '1', contentHash: file.id, createdAt: '2026-01-01',
        contentJson: JSON.stringify({ responsibility: `Refund approval analysis ${file.path}`, unknowns: [] }) });
    }
    store.insertSummary({ id: 'old-group', snapshotId: snapshot.id, subjectId: 'module-billing#synthesis:0:1', level: 'module',
      model: 'fixture', promptVersion: '1', contentHash: 'old', createdAt: '2026-01-01', contentJson: JSON.stringify({ responsibility: 'Refund old synthesis' }) });
    const embeddings = recordingEmbeddings(); const qdrant = new Vectors();
    const base = { store, snapshotId: snapshot.id, repositoryName: repository.name, collection: 'entrypoints', embeddings, qdrant };
    await indexSnapshot(base);
    store.setSnapshotMetadata(snapshot.id, 'synthesis_mode', 'entrypoints');
    store.setSnapshotMetadata(snapshot.id, 'entrypoint_catalog', JSON.stringify([{ kind: 'usecase', name: 'RefundUseCase',
      path: files[0]!.path, summarySubjectId: files[0]!.id }]));
    const oldResults = await hybridKnowledgeSearch({ ...base, query: 'refund', filters: { entityKinds: ['summary'] } });
    expect(oldResults.map((hit) => hit.item.subjectId)).toEqual([files[0]!.id]);
    await indexSnapshot(base);
    const summaries = store.listKnowledgeItems(snapshot.id, { entityKinds: ['summary'] });
    expect(summaries).toHaveLength(1); expect(summaries[0]!.title).toBe('usecase: RefundUseCase');
    expect(store.listKnowledgeItems(snapshot.id, { entityKinds: ['symbol'] })).toHaveLength(2);
    const evidence = await buildEvidenceContext({ ...base, queries: ['autorización de devoluciones'], includeSource: false, types: ['summary'] });
    expect(evidence.text).toContain('RefundUseCase'); expect(evidence.text).not.toContain('old synthesis');
  } finally { store.close(); }
});

test('SQLite alone rebuilds complete symbol bodies and every knowledge kind; filters apply before LIMIT', async () => {
  const { store, snapshot, symbols } = await fixture();
  try {
    const body = store.searchKnowledge(snapshot.id, 'xylophonic')[0]!.item;
    expect(body.id).toBe(symbols[0]!.id);
    expect(body.sourceComplete).toBe(true);
    const hits = await hybridKnowledgeSearch({ store, snapshotId: snapshot.id, collection: 'test', query: 'refund', candidateLimit: 1, limit: 1,
      filters: { language: 'python', module: 'audit', entityKinds: ['symbol'] } });
    expect(hits.map((hit) => hit.item.id)).toEqual([symbols[1]!.id]);
    for (const [query, type] of [['approval', 'summary'], ['reimbursement', 'document'], ['global state', 'finding'], ['idempotent', 'test']] as const) {
      expect(store.searchKnowledge(snapshot.id, query, 1, { entityKinds: [type] })[0]?.item.entityKind).toBe(type);
    }
    const embeddings = recordingEmbeddings();
    const qdrant = new Vectors();
    await indexSnapshot({ store, snapshotId: snapshot.id, repositoryName: 'search-fixture', collection: 'test', embeddings, qdrant });
    expect(embeddings.inputs.some((text) => text.includes('return "refund xylophonic payment"'))).toBe(true);
    expect(new Set([...qdrant.points.values()].map((point) => point.payload['entity_kind'])).size).toBe(5);
    store.rebuildSearchIndex(snapshot.id);
    expect(store.searchKnowledge(snapshot.id, 'xylophonic').length).toBe(1);
    const next = store.createSnapshot({ repositoryId: symbols[0]!.repositoryId, commitSha: '2' });
    expect(store.searchKnowledge(next.id, 'xylophonic')).toEqual([]);
    expect(store.getSnapshotSource(snapshot.id, symbols[0]!.path)).toContain('xylophonic');
  } finally { store.close(); }
});

test('changed bodies embed once, unchanged points update only metadata; deletion and empty snapshots purge only their repository', async () => {
  const { store, snapshot, repository, sources, symbols, files } = await fixture();
  try {
    const embeddings = recordingEmbeddings();
    const qdrant = new Vectors();
    const base = { store, repositoryName: repository.name, collection: 'test', embeddings, qdrant };
    await indexSnapshot({ ...base, snapshotId: snapshot.id });
    const initial = qdrant.writes;
    const repeated: IndexProgress[] = [];
    await indexSnapshot({ ...base, snapshotId: snapshot.id, onProgress: (value) => repeated.push(value) });
    expect(repeated[0]?.embedded).toBe(0);
    expect(qdrant.writes).toBe(initial);
    expect(qdrant.updates).toBe(0);
    qdrant.points.set('other-repository', { id: 'other-repository', vector: [1, 0], payload: { repository: 'other' } });
    const next = store.createSnapshot({ repositoryId: repository.id, commitSha: '2' });
    const changed = sources[0]!.content.replace('xylophonic', 'newmarker');
    store.insertFiles(files.map((file, index) => ({ ...file, snapshotId: next.id, contentHash: index === 0 ? contentHash(changed) : file.contentHash })));
    store.insertSnapshotSources(next.id, sources.map((source, index) => ({ path: source.path, content: index === 0 ? changed : source.content, contentHash: contentHash(index === 0 ? changed : source.content) })));
    store.insertSymbols(symbols.map((symbol, index) => ({ ...symbol, snapshotId: next.id, contentHash: index === 0 ? contentHash(changed) : symbol.contentHash })));
    const progress: IndexProgress[] = [];
    await indexSnapshot({ ...base, snapshotId: next.id, onProgress: (value) => progress.push(value) });
    expect(progress[0]?.embedded).toBe(1);
    expect(progress[0]?.reused).toBe(1);
    expect(qdrant.writes).toBe(initial + 1);
    expect(qdrant.updates).toBe(1);
    expect(qdrant.points.size).toBe(3);
    const empty = store.createSnapshot({ repositoryId: repository.id, commitSha: '3' });
    expect(await indexSnapshot({ ...base, snapshotId: empty.id })).toBe(0);
    expect([...qdrant.points.keys()]).toEqual(['other-repository']);
  } finally { store.close(); }
});

test('index failure releases its lease and preserves existing points; rejected input is explicit and stays in FTS', async () => {
  const { store, snapshot, repository, symbols } = await fixture();
  try {
    const qdrant = new Vectors();
    const base = { store, snapshotId: snapshot.id, repositoryName: repository.name, collection: 'test', qdrant };
    await expect(indexSnapshot({ ...base, embeddings: { embed: async () => { throw new Error('offline'); } } })).rejects.toThrow('offline');
    expect(qdrant.prunes).toBe(0);
    expect(store.db.prepare('SELECT * FROM vector_index_leases').all()).toEqual([]);
    const output: IndexProgress[] = [];
    await indexSnapshot({ ...base, embeddings: { embed: async (texts) => {
      if (texts.some((text) => text.includes('xylophonic'))) { throw new EmbeddingInputError('Input too long'); }
      return texts.map(() => [1, 0]);
    } }, onProgress: (value) => output.push(value) });
    expect(output[0]?.omitted).toEqual([{ itemId: symbols[0]!.id, reason: 'Input too long' }]);
    expect(store.getSnapshotMetadata(snapshot.id, 'vector_refresh_pending')).toBe('true');
    expect(store.searchKnowledge(snapshot.id, 'xylophonic')[0]?.item.id).toBe(symbols[0]!.id);
    store.db.prepare('INSERT INTO vector_index_leases VALUES (?, ?, ?)').run('test', 'another-process', Date.now() + 50000);
    await expect(indexSnapshot({ ...base, embeddings: recordingEmbeddings() })).rejects.toThrow('lease');
  } finally { store.close(); }
});

test('search rejects stale/untrusted vector hits, applies filters again and uses query instructions', async () => {
  const { store, snapshot, symbols } = await fixture();
  try {
    const items = store.listKnowledgeItems(snapshot.id);
    const good = items.find((item) => item.id === symbols[0]!.id)!;
    const other = items.find((item) => item.id === symbols[1]!.id)!;
    const hit = (item: KnowledgeItem, extra: Record<string, unknown> = {}): QdrantHit => ({ id: symbolIdToPointId(item.id), score: 1,
      payload: { item_id: item.id, snapshot_id: snapshot.id, repository: 'search-fixture', embedding_hash: item.contentHash, ...extra } });
    let queryCalls = 0;
    const qdrant = new Vectors();
    qdrant.search = async () => [hit(good, { embedding_hash: 'stale' }), hit(good, { snapshot_id: 'old' }), hit(good, { repository: 'wrong' }), hit(other), hit(good)];
    const result = await hybridKnowledgeSearch({ store, snapshotId: snapshot.id, collection: 'test', query: 'semantic-only-question', qdrant,
      filters: { language: 'typescript' }, embeddings: { embed: async () => { throw new Error('Wrong query method'); }, embedQuery: async () => { queryCalls += 1; return [1, 0]; } } });
    expect(queryCalls).toBe(1);
    expect(result.map((entry) => entry.item.id)).toEqual([good.id]);
    expect(result[0]?.sources).toEqual(['vector']);
  } finally { store.close(); }
});

test('outages and malformed reranking preserve lexical results with warnings; containment is not reference popularity', async () => {
  const { store, snapshot, symbols } = await fixture();
  try {
    store.insertEdges([{ snapshotId: snapshot.id, sourceId: 'file', targetId: symbols[0]!.id, edgeType: 'CONTAINS', confidence: 1, analyzer: 'fixture', evidence: null }]);
    const warnings: string[] = [];
    const result = await hybridKnowledgeSearch({ store, snapshotId: snapshot.id, query: 'refund', collection: 'test', qdrant: new Vectors(),
      embeddings: { embed: async () => { throw new Error('offline'); } }, reranker: { rerank: async () => [NaN] }, onWarning: (message) => warnings.push(message) });
    expect(result.length).toBeGreaterThan(1);
    expect(warnings.length).toBe(2);
    expect(result.every((hit) => !hit.sources.includes('rerank') && !hit.sources.includes('graph'))).toBe(true);
  } finally { store.close(); }
});

test('knowledge replaced during embedding cannot publish or purge vectors for an obsolete projection', async () => {
  const { store, snapshot, repository } = await fixture();
  try {
    const qdrant = new Vectors();
    await expect(indexSnapshot({ store, snapshotId: snapshot.id, repositoryName: repository.name, collection: 'test', qdrant,
      embeddings: { embed: async (texts) => {
        store.insertSummary({ id: 'concurrent-summary', snapshotId: snapshot.id, subjectId: repository.id, level: 'product', model: 'other', promptVersion: '1',
          contentHash: 'changed', contentJson: '{"purpose":"Concurrent change"}', createdAt: '2026-10-31' });
        store.rebuildSearchIndex(snapshot.id);
        return texts.map(() => [0.5, 1]);
      } } })).rejects.toThrow('knowledge changed');
    expect(qdrant.writes).toBe(0);
    expect(qdrant.prunes).toBe(0);
    expect(store.db.prepare('SELECT * FROM vector_index_leases').all()).toEqual([]);
  } finally { store.close(); }
});
