import { expect, test } from '@rstest/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openStore } from '@repolead/knowledge-store';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import { countTokens } from '@repolead/retrieval';
import { createServer } from './server';
import { startHttpServer } from './http';
import { productView } from './product';

function seed(store: KnowledgeStore, name = 'access') {
  const repository = store.upsertRepository({ name, rootPath: '/private/checkout' });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'abc' });
  store.setSnapshotMetadata(snapshot.id, 'synthesis_mode', 'entrypoints');
  store.setSnapshotMetadata(snapshot.id, 'technical_analysis', JSON.stringify({ status: 'complete', synthesisMode: 'entrypoints', selectionComplete: true, scope: null, entrypoints: 1 }));
  store.setSnapshotMetadata(snapshot.id, 'product_analysis', JSON.stringify({ status: 'complete', synthesisMode: 'entrypoints' }));
  store.setSnapshotMetadata(snapshot.id, 'knowledge_projection', 'projection');
  store.setSnapshotMetadata(snapshot.id, 'entrypoint_catalog', JSON.stringify([{ name: 'ManualMarkingUseCase', kind: 'usecase', summarySubjectId: 'subject' }]));
  store.insertSummary({ id: `summary-${snapshot.id}`, snapshotId: snapshot.id, subjectId: 'subject', level: 'file', model: 'fixture',
    promptVersion: '7', contentHash: 'hash', createdAt: new Date().toISOString(), contentJson: JSON.stringify({
      responsibility: 'Record a manual marking.', businessRules: ['The access point must be active.', 'password=CANARY_PASSWORD', '```python\nprint("CANARY_CODE")\n```'],
      publicApi: ['CANARY_SIGNATURE'], dependencies: ['CANARY_DEPENDENCY'], tests: ['CANARY_TEST'],
      sideEffects: ['Records an audit event.'], errors: ['Inactive point rejects the operation.'],
      productFacts: [{ category: 'field', detail: 'credential is required.', evidenceIds: ['source-evidence'] },
        { category: 'permission', detail: 'CANARY_UNSUPPORTED_ROLE', evidenceIds: ['missing-evidence'] }],
      unknowns: ['Tenant roles require validation.', 'https://internal.invalid/CANARY_URL'],
    }) }, [{ id: 'source-evidence', kind: 'source', path: 'private/marking.py', startLine: 1, endLine: 100, contentHash: 'hash', parentIds: [] }]);
  return { repository, snapshot };
}

test('product projection allowlists functional fields and never publishes incomplete snapshots', async () => {
  const store = await openStore(':memory:');
  try {
    const { repository, snapshot } = seed(store);
    const repo = { name: 'access', store };
    const view = productView(repo)!;
    expect(view.records).toHaveLength(1);
    expect(view.records[0]!.facts).toEqual([{ category: 'field', detail: 'credential is required.' }]);
    expect(view.records[0]!.omittedFields).toBe(4);
    expect(JSON.stringify(view.records)).not.toContain('CANARY');
    expect(JSON.stringify(view.records)).not.toContain('private/marking.py');
    const next = store.createSnapshot({ repositoryId: repository.id, commitSha: 'def' });
    expect(productView(repo)!.snapshot.id).toBe(snapshot.id);
    expect(productView(repo)!.updating).toBe(true);
    store.setSnapshotMetadata(snapshot.id, 'technical_analysis', '{"status":"running"}');
    expect(productView(repo)).toBe(null);
    expect(store.getSnapshot(next.id)).not.toBe(null);
  } finally { store.close(); }
});

test('product MCP is isolated, respects budgets and does not cross repository refs', async () => {
  const store = await openStore(':memory:');
  seed(store);
  const server = createServer([{ name: 'access', store }, { name: 'other', store }], { product: true, exposeSource: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'product-test', version: '1' });
  await server.connect(a); await client.connect(b);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(['product_catalog', 'product_context', 'product_evidence', 'product_investigate']);
    expect((await client.callTool({ name: 'get_evidence', arguments: { path: 'private/marking.py' } })).isError).toBe(true);
    await expect(client.readResource({ uri: 'repolead://knowledge/access/file/c3ViamVjdA' })).rejects.toThrow();
    const response = await client.callTool({ name: 'product_context', arguments: { repo: 'access', queries: ['manual marking'], maxTokens: 2000 } });
    const text = (response.content as { text: string }[])[0]!.text;
    const payload = JSON.parse(text) as { records: { ref: string }[]; missingCategories: string[]; retrieval: { semantic: boolean } };
    expect(payload.records).toHaveLength(1);
    expect(payload.missingCategories).toContain('permission');
    expect(payload.retrieval.semantic).toBe(false);
    expect(text).not.toContain('CANARY');
    expect(countTokens(text)).toBeLessThanOrEqual(2000);
    const narrow = await client.callTool({ name: 'product_context', arguments: { repo: 'access', queries: ['manual marking'], maxTokens: 512 } });
    expect(countTokens((narrow.content as { text: string }[])[0]!.text)).toBeLessThanOrEqual(512);
    const wrong = await client.callTool({ name: 'product_evidence', arguments: { repo: 'other', ref: payload.records[0]!.ref } });
    expect((wrong.content as { text: string }[])[0]!.text).toContain('Referencia no disponible');
    const evidence = await client.callTool({ name: 'product_evidence', arguments: { repo: 'access', ref: payload.records[0]!.ref } });
    expect((evidence.content as { text: string }[])[0]!.text).toContain('The access point must be active.');
  } finally { await client.close(); await server.close(); store.close(); }
});

test('HTTP forwards product isolation and enforces bearer auth', async () => {
  const store = await openStore(':memory:'); seed(store);
  const server = await startHttpServer([{ name: 'access', store }], { product: true, port: 0, token: 'test-token' });
  const address = server.address();
  const url = new URL(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`);
  const client = new Client({ name: 'http-product-test', version: '1' });
  try {
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer test-token' } } }));
    expect((await client.listTools()).tools).toHaveLength(4);
    const call = await client.callTool({ name: 'product_catalog', arguments: {} });
    expect((call.content as { text: string }[])[0]!.text).toContain('ready');
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});

test('read-only SQLite connection sees completed writes but rejects mutations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repolead-product-readonly-'));
  const path = join(dir, 'memory.db');
  const writer = await openStore(path); seed(writer);
  const reader = await openStore(path, { readonly: true });
  try {
    expect(productView({ name: 'access', store: reader })!.records).toHaveLength(1);
    expect(() => reader.setSnapshotMetadata(reader.getLatestSnapshot()!.id, 'oops', 'write')).toThrow();
    writer.setSnapshotMetadata(writer.getLatestSnapshot()!.id, 'test', 'committed');
    expect(reader.getSnapshotMetadata(reader.getLatestSnapshot()!.id, 'test')).toBe('committed');
  } finally { reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
});
