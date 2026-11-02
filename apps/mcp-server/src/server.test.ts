import { expect, test } from '@rstest/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CodeSymbol } from '@repolead/domain';
import { contentHash, fileUri, moduleUri, stableSymbolId } from '@repolead/domain';
import { countTokens } from '@repolead/retrieval';
import { openStore } from '@repolead/knowledge-store';

import { createServer } from './server';

const REPO = 'demo';

async function seedAndConnect(exposeSource = true, servedName = REPO, toolProfile: 'all' | 'context' = 'all') {
  const store = await openStore(':memory:');
  const repository = store.upsertRepository({ name: REPO, rootPath: '/tmp/does-not-exist' });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'abc' });

  store.insertModules([
    {
      id: moduleUri(REPO, 'src/payment'),
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      name: 'payment',
      path: 'src/payment',
    },
  ]);

  const make = (qualifiedName: string, kind: CodeSymbol['kind']): CodeSymbol => ({
    id: stableSymbolId({ repository: REPO, path: 'src/payment/service.ts', kind, qualifiedName }),
    repositoryId: repository.id,
    snapshotId: snapshot.id,
    path: 'src/payment/service.ts',
    qualifiedName,
    kind,
    signature: null,
    startLine: 1,
    endLine: 10,
    contentHash: 'h',
    source: 'tree-sitter',
  });
  const process_ = make('PaymentService.process', 'method');
  const checkout = make('checkout', 'function');
  const handler = make('httpHandler', 'function');
  store.insertSymbols([process_, checkout, handler]);
  store.insertEdges([
    {
      snapshotId: snapshot.id,
      sourceId: checkout.id,
      targetId: process_.id,
      edgeType: 'CALLS',
      confidence: 0.9,
      analyzer: 'scip',
      evidence: null,
    },
    {
      snapshotId: snapshot.id,
      sourceId: handler.id,
      targetId: checkout.id,
      edgeType: 'CALLS',
      confidence: 0.9,
      analyzer: 'scip',
      evidence: null,
    },
  ]);
  store.insertFinding(
    {
      id: 'finding-1',
      snapshotId: snapshot.id,
      repositoryId: repository.id,
      ruleId: 'ARCH-CYCLE-001',
      severity: 'high',
      confidence: 0.9,
      claim: 'ciclo entre módulos',
      recommendation: null,
      module: moduleUri(REPO, 'src/payment'),
      status: 'confirmed',
      supersededBy: null,
      createdAt: new Date().toISOString(),
    },
    [
      {
        id: 'evidence-1',
        ownerId: 'finding-1',
        ownerKind: 'finding',
        path: 'src/payment/service.ts',
        startLine: 1,
        endLine: 3,
        excerpt: 'import cycle',
      },
    ],
  );

  const server = createServer([{ name: servedName, store }], { exposeSource, toolProfile });
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { store, client };
}

function payloadOf(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text) as unknown;
}

test('symbol context uses its file dossier in file mode even with a different served alias', async () => {
  const { store, client } = await seedAndConnect(false, 'product-access');
  try {
    const snapshot = store.getLatestSnapshot()!;
    const content = { responsibility: 'Access rules', productFacts: [{ category: 'permission', detail: 'access.create' }] };
    store.insertSummary({ id: 'file-mode-dossier', snapshotId: snapshot.id,
      subjectId: fileUri(REPO, 'src/payment/service.ts'), level: 'file', contentJson: JSON.stringify(content),
      model: 'fixture', promptVersion: '7', contentHash: 'file-mode-content', createdAt: new Date().toISOString() });
    const payload = payloadOf(await client.callTool({ name: 'symbol_context', arguments: { symbol: 'checkout' } })) as {
      card: string; fileDossier: typeof content;
    };
    expect(payload.card).toContain('complete file dossier');
    expect(payload.fileDossier).toEqual(content);
  } finally { await client.close(); store.close(); }
});

test('overview never presents an intermediate synthesis as a completed brief', async () => {
  const { store, client } = await seedAndConnect();
  try {
    const snapshot = store.getLatestSnapshot()!;
    store.insertSummary({ id: 'partial-product', snapshotId: snapshot.id, subjectId: 'product://demo#synthesis:0:1',
      level: 'product', contentJson: JSON.stringify({ objective: 'PARTIAL' }), model: 'fixture', promptVersion: '7',
      contentHash: 'partial', createdAt: new Date().toISOString() });
    const payload = payloadOf(await client.callTool({ name: 'repo_overview', arguments: { audience: 'product' } })) as { brief: string; resource: string | null };
    expect(payload.brief).toContain('sin analizar');
    expect(payload.resource).toBeNull();
  } finally { await client.close(); store.close(); }
});

test('context profile reduces tool schema tokens and refuses hidden tools while retaining retrieval', async () => {
  const full = await seedAndConnect(); const lean = await seedAndConnect(true, REPO, 'context');
  try {
    const all = await full.client.listTools(); const context = await lean.client.listTools();
    expect(context.tools.map((tool) => tool.name).sort()).toEqual(['context_pack', 'get_evidence', 'repo_overview', 'search']);
    expect(countTokens(JSON.stringify(context))).toBeLessThan(countTokens(JSON.stringify(all)));
    const overview = payloadOf(await lean.client.callTool({ name: 'repo_overview', arguments: {} })) as { repository: string };
    expect(overview.repository).toBe(REPO);
    expect((await lean.client.callTool({ name: 'impact_analysis', arguments: { symbols: ['checkout'] } })).isError).toBe(true);
  } finally { await full.client.close(); await lean.client.close(); full.store.close(); lean.store.close(); }
});

test('MCP evidence combines search and exact source, uses the indexed collection and enforces no-source', async () => {
  const store = await openStore(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'repolead-mcp-evidence-'));
  const repository = store.upsertRepository({ name: 'evidence', rootPath: root });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'abc' });
  const source = 'export function refund(amount: number) {\n  if (amount < 0) throw new RangeError("negative");\n  return amount;\n}';
  writeFileSync(join(root, 'payment.ts'), source);
  store.insertFiles([{ id: fileUri('evidence', 'payment.ts'), repositoryId: repository.id, snapshotId: snapshot.id, path: 'payment.ts',
    language: 'typescript', contentHash: contentHash(source), lineCount: 4, lastAuthor: null, lastCommitAt: null }]);
  store.insertSnapshotSources(snapshot.id, [{ path: 'payment.ts', content: source, contentHash: contentHash(source) }]);
  store.insertSymbols([{ id: 'refund', repositoryId: repository.id, snapshotId: snapshot.id, path: 'payment.ts', qualifiedName: 'refund',
    kind: 'function', signature: null, startLine: 1, endLine: 4, contentHash: contentHash(source), source: 'tree-sitter' }]);
  store.rebuildSearchIndex(snapshot.id);
  store.setSnapshotMetadata(snapshot.id, 'vector_index', JSON.stringify({ collection: 'custom-evidence-collection' }));
  const requests: string[] = [];
  const service = createHttpServer(async (request, response) => {
    for await (const _chunk of request) { /* drain the complete request */ }
    requests.push(request.url!);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/embed' ? [[1, 0]] : request.url?.includes('/points/search') ? { result: [] } : {}));
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  const address = service.address(); if (!address || typeof address === 'string') { throw new Error('Missing port'); }
  const environment = ['REPOLEAD_TEI_URL', 'REPOLEAD_QDRANT_URL', 'REPOLEAD_RERANKER_URL'];
  const previous = environment.map((key) => process.env[key]);
  environment.forEach((key) => { process.env[key] = `http://127.0.0.1:${address.port}`; });
  const connect = async (exposeSource: boolean) => {
    const server = createServer([{ name: 'evidence', store }], { exposeSource, toolProfile: 'context' });
    const client = new Client({ name: 'evidence-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]); return client;
  };
  const client = await connect(true); const privateClient = await connect(false);
  const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { text: string }[])[0]!.text;
  try {
    const args = { queries: ['refund', 'negative refund'], types: ['symbol'], maxTokens: 1200 };
    const result = await client.callTool({ name: 'context_pack', arguments: args });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('2\t  if (amount < 0) throw new RangeError("negative");');
    expect(countTokens(textOf(result))).toBeLessThanOrEqual(1200);
    expect(requests).toContain('/collections/custom-evidence-collection/points/search');
    const receipted = textOf(await client.callTool({ name: 'context_pack', arguments: { ...args, knownBlocks: [] } }));
    const receipts = [...receipted.matchAll(/sha256=([a-f0-9]{64})/g)].map((match) => match[1]!);
    expect(receipts).toHaveLength(1);
    const repeated = textOf(await client.callTool({ name: 'context_pack', arguments: { ...args, knownBlocks: receipts } }));
    expect(repeated).toContain('UNCHANGED'); expect(repeated).not.toContain('return amount');
    const hidden = textOf(await privateClient.callTool({ name: 'context_pack', arguments: args }));
    expect(hidden).toContain('raw source disabled'); expect(hidden).not.toContain('return amount');
    for (const invalid of [{ ...args, mode: 'map' }, { ...args, query: 'refund' }, { ...args, symbols: ['refund'] },
      { ...args, knownBlocks: ['invalid'] }, { query: 'refund', mode: 'map', knownBlocks: [] }]) {
      expect((await client.callTool({ name: 'context_pack', arguments: invalid })).isError).toBe(true);
    }
  } finally {
    await client.close(); await privateClient.close(); store.close(); rmSync(root, { recursive: true, force: true });
    environment.forEach((key, i) => { if (previous[i] === undefined) { delete process.env[key]; } else { process.env[key] = previous[i]; } });
    service.closeAllConnections(); await new Promise<void>((resolve) => service.close(() => resolve()));
  }
});

test('MCP batch source respects one budget, live snapshot hashes, no-source and selector disambiguation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repolead-source-batch-'));
  const store = await openStore(':memory:');
  const repository = store.upsertRepository({ name: 'batch', rootPath: root });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'abc' });
  for (const path of ['one.ts', 'two.ts']) {
    const source = `export const value = ${JSON.stringify(path)};\n`;
    writeFileSync(join(root, path), source);
    store.insertFiles([{ id: fileUri('batch', path), repositoryId: repository.id, snapshotId: snapshot.id,
      path, language: 'typescript', contentHash: contentHash(source), lineCount: 2, lastAuthor: null, lastCommitAt: null }]);
  }
  const connect = async (exposeSource: boolean) => {
    const server = createServer([{ name: 'batch', store }], { exposeSource });
    const client = new Client({ name: 'batch-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    return client;
  };
  const client = await connect(true); const privateClient = await connect(false);
  const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { text: string }[])[0]!.text;
  const args = { ranges: [{ path: 'one.ts' }, { path: 'two.ts' }], maxTokens: 500 };
  try {
    const large = textOf(await client.callTool({ name: 'get_evidence', arguments: { ranges: args.ranges, maxTokens: 120000 } }));
    expect(large).toContain('budget 120000');
    expect((await client.callTool({ name: 'get_evidence', arguments: { ranges: args.ranges, maxTokens: 120001 } })).isError).toBe(true);
    const text = textOf(await client.callTool({ name: 'get_evidence', arguments: args }));
    expect(text).toContain('1\texport const value = "two.ts";');
    expect(text).toContain(snapshot.id); expect(countTokens(text)).toBeLessThanOrEqual(500);
    expect(textOf(await privateClient.callTool({ name: 'get_evidence', arguments: args }))).toContain('source access disabled');
    expect((await client.callTool({ name: 'get_evidence', arguments: { ...args, path: 'one.ts' } })).isError).toBe(true);
    writeFileSync(join(root, 'one.ts'), 'changed after scan');
    const stale = textOf(await client.callTool({ name: 'get_evidence', arguments: args }));
    expect(stale).toContain('source changed since indexing'); expect(stale).not.toContain('changed after scan');
    const invalid = textOf(await client.callTool({ name: 'get_evidence', arguments: { ranges: [{ path: '../outside.ts' }] } }));
    expect(invalid).toContain('UNAVAILABLE');
  } finally { await client.close(); await privateClient.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('symbol lookup accepts stable IDs and never silently selects a duplicate name', async () => {
  const { store, client } = await seedAndConnect();
  try {
    const snapshot = store.getLatestSnapshot()!;
    const original = store.listSymbols(snapshot.id).find((symbol) => symbol.qualifiedName === 'checkout')!;
    const duplicate = { ...original, id: stableSymbolId({ repository: REPO, path: 'src/other.ts', kind: original.kind, qualifiedName: original.qualifiedName }), path: 'src/other.ts' };
    store.insertSymbols([duplicate]);
    const ambiguous = payloadOf(await client.callTool({ name: 'symbol_context', arguments: { symbol: 'checkout' } })) as { error: string };
    expect(ambiguous.error).toContain('ambiguo');
    expect(ambiguous.error).toContain(duplicate.id);
    const exact = payloadOf(await client.callTool({ name: 'symbol_context', arguments: { symbol: duplicate.id } })) as { location: string };
    expect(exact.location).toContain('src/other.ts');
  } finally { await client.close(); store.close(); }
});

test('module lookup rejects duplicate names, and accepts an exact path or stable ID', async () => {
  const { store, client } = await seedAndConnect();
  try {
    const snapshot = store.getLatestSnapshot()!;
    const other = { id: moduleUri(REPO, 'src/other/payment'), repositoryId: snapshot.repositoryId,
      snapshotId: snapshot.id, name: 'payment', path: 'src/other/payment' };
    store.insertModules([other]);
    const ambiguous = payloadOf(await client.callTool({ name: 'module_context', arguments: { module: 'payment' } })) as { error: string };
    expect(ambiguous.error).toContain('ambiguo');
    expect(ambiguous.error).toContain(other.id);
    for (const module of [other.path, other.id]) {
      const exact = payloadOf(await client.callTool({ name: 'module_context', arguments: { module } })) as { path: string };
      expect(exact.path).toBe(other.path);
    }
  } finally { await client.close(); store.close(); }
});

test('multi-repository resolution requires a unique alias and explicit disambiguation for shared IDs', async () => {
  const first = await seedAndConnect();
  const second = await seedAndConnect();
  const client = new Client({ name: 'multi-repo-test', version: '1' });
  try {
    await first.client.close(); await second.client.close();
    expect(() => createServer([{ name: 'same', store: first.store }, { name: 'same', store: second.store }])).toThrow('unique');
    expect(() => createServer([{ name: ' ', store: first.store }])).toThrow('nonempty');
    const server = createServer([{ name: 'Uno / Perú', store: first.store }, { name: 'Dos', store: second.store }]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    for (const [name, args] of [
      ['symbol_context', { symbol: 'checkout' }],
      ['module_context', { module: 'payment' }],
      ['trace_flow', { from: 'checkout', to: 'PaymentService.process' }],
      ['get_evidence', { findingId: 'finding-1' }],
    ] as const) {
      const ambiguous = payloadOf(await client.callTool({ name, arguments: args })) as { error: string };
      expect(ambiguous.error).toMatch(/ambigu/);
      const scoped = payloadOf(await client.callTool({ name, arguments: { ...args, repo: 'Dos' } })) as { repo: string } | { repo: string }[];
      expect(Array.isArray(scoped) ? scoped[0]!.repo : scoped.repo).toBe('Dos');
    }
    const overview = payloadOf(await client.callTool({ name: 'repo_overview', arguments: {} })) as { repos: { repo: string }[] };
    expect(overview.repos.map((repo) => repo.repo)).toEqual(['Uno / Perú', 'Dos']);
    const unknown = payloadOf(await client.callTool({ name: 'repo_overview', arguments: { repo: 'missing' } })) as { error: string };
    expect(unknown.error).toContain('desconocido');
    const noScope = payloadOf(await client.callTool({ name: 'impact_analysis', arguments: { symbols: ['checkout'] } })) as { error: string };
    expect(noScope.error).toContain('pasa repo');
    const impact = payloadOf(await client.callTool({ name: 'impact_analysis', arguments: { repo: 'Dos', symbols: ['checkout'] } })) as { repo: string; affectedSymbols: { total: number } };
    expect(impact.repo).toBe('Dos'); expect(impact.affectedSymbols.total).toBeGreaterThan(0);
    const joernScope = payloadOf(await client.callTool({ name: 'trace_flow', arguments: { engine: 'joern', from: 'entry', to: 'sink' } })) as { error: string };
    expect(joernScope.error).toContain('explicit repository');
    const joern = payloadOf(await client.callTool({ name: 'trace_flow', arguments: { repo: 'Dos', engine: 'joern', from: 'entry', to: 'sink' } })) as { status: string };
    expect(joern.status).toBe('not_available');
    const ignoredBounds = payloadOf(await client.callTool({ name: 'trace_flow', arguments: { repo: 'Dos', engine: 'joern', from: 'entry', to: 'sink', maxDepth: 1 } })) as { error: string };
    expect(ignoredBounds.error).toContain('do not apply');
    for (const name of ['hotspots', 'improvement_opportunities']) {
      const missing = payloadOf(await client.callTool({ name, arguments: {} })) as { error: string };
      expect(missing.error).toContain('Specify repo');
      const scoped = payloadOf(await client.callTool({ name, arguments: { repo: 'Dos' } })) as { repo: string };
      expect(scoped.repo).toBe('Dos');
    }
  } finally { await client.close(); await first.client.close(); await second.client.close(); first.store.close(); second.store.close(); }
});

test('a historical finding never reads current snapshot source at its old coordinates', async () => {
  const { store, client } = await seedAndConnect();
  try {
    const previous = store.getLatestSnapshot()!;
    store.createSnapshot({ repositoryId: previous.repositoryId, commitSha: 'new' });
    expect(store.getEvidence('finding-1')).toHaveLength(1); // Historical record is still stored.
    const result = payloadOf(await client.callTool({ name: 'get_evidence', arguments: { findingId: 'finding-1' } })) as { error: string };
    expect(result.error).toContain('sin evidencia');
    expect(JSON.stringify(result)).not.toContain('import cycle');
  } finally { await client.close(); store.close(); }
});

test('el servidor MCP expone las tools de conocimiento y responde overview y callers', async () => {
  const { store, client } = await seedAndConnect();

  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
    'architecture_findings',
    'context_pack',
    'find_callers',
    'find_references',
    'get_evidence',
    'hotspots',
    'impact_analysis',
    'improvement_opportunities',
    'module_context',
    'mutation_results',
    'repo_overview',
    'search',
    'symbol_context',
    'trace_flow',
  ]);

  const overview = payloadOf(await client.callTool({ name: 'repo_overview', arguments: {} })) as {
    repository: string;
    stats: { symbols: number };
    modules: string[];
  };
  expect(overview.repository).toBe(REPO);
  expect(overview.stats.symbols).toBe(3);
  expect(overview.modules).toEqual(['payment']);

  const callers = payloadOf(
    await client.callTool({
      name: 'find_callers',
      arguments: { symbol: 'PaymentService.process', transitiveDepth: 3 },
    }),
  ) as { callersByDepth: string[][] };
  expect(callers.callersByDepth).toEqual([['checkout'], ['httpHandler']]);

  store.close();
});

test('context_pack entrega contexto acotado y stdio observa snapshots nuevos', async () => {
  const { store, client } = await seedAndConnect();
  const context = await client.callTool({ name: 'context_pack', arguments: { symbols: ['checkout'], maxTokens: 600 } });
  const text = (context.content as { text: string }[])[0]!.text;
  expect(text).toContain('checkout');
  expect(text).toContain('Budget 600');
  const previous = store.getLatestSnapshot()!;
  const next = store.createSnapshot({ repositoryId: previous.repositoryId, commitSha: 'next' });
  store.db.prepare('UPDATE snapshots SET created_at = ? WHERE id = ?').run('2099-01-01T00:00:00Z', next.id);
  const overview = payloadOf(await client.callTool({ name: 'repo_overview', arguments: {} })) as { stats: { symbols: number } };
  expect(overview.stats.symbols).toBe(0);
  await client.close();
  store.close();
});

test('findings filtrables y evidencia con contrato de preview', async () => {
  const { store, client } = await seedAndConnect();

  const findings = payloadOf(
    await client.callTool({ name: 'architecture_findings', arguments: { severity: ['high'] } }),
  ) as { findings: { findingId: string; ruleId: string }[] };
  expect(findings.findings.length).toBe(1);
  expect(findings.findings[0]?.ruleId).toBe('ARCH-CYCLE-001');

  const evidence = payloadOf(
    await client.callTool({
      name: 'get_evidence',
      arguments: { findingId: findings.findings[0]!.findingId },
    }),
  ) as { path: string; excerpt: string }[];
  expect(evidence[0]?.path).toBe('src/payment/service.ts');
  expect(evidence[0]?.excerpt).toBe('import cycle');

  const search = payloadOf(
    await client.callTool({ name: 'search', arguments: { query: 'payment process' } }),
  ) as { results: { symbol: string }[] };
  expect(search.results[0]?.symbol).toBe('PaymentService.process');

  store.close();
});

test('MCP resources expose every persisted level, refresh dynamically and preserve no-source', async () => {
  const { store, client } = await seedAndConnect(false, 'Demo / Perú');
  try {
    expect((await client.listResources()).resources).toEqual([]);
    const snapshot = store.getLatestSnapshot()!;
    const symbol = store.listSymbols(snapshot.id)[0]!;
    const evidence = { id: 'ev_source', kind: 'source' as const, path: symbol.path,
      startLine: 1, endLine: 10, contentHash: 'source-fingerprint', parentIds: [] };
    for (const level of ['symbol', 'file', 'module', 'repository', 'document', 'product'] as const) {
      const subjectId = level === 'symbol' ? symbol.id : `${level}://demo/src/payment`;
      store.insertSummary({ id: `summary-${level}`, snapshotId: snapshot.id, subjectId, level,
        contentJson: JSON.stringify({ purpose: `${level} detail`, evidenceIds: [evidence.id], unknowns: [] }),
        model: 'fixture', promptVersion: '3', contentHash: level, createdAt: new Date().toISOString() }, [evidence]);
    }
    const resources = (await client.listResources()).resources;
    expect(resources).toHaveLength(6);
    const product = payloadOf(await client.callTool({ name: 'repo_overview', arguments: { audience: 'product' } })) as {
      audience: string; brief: { purpose: string }; resource: string;
    };
    expect(product.audience).toBe('product');
    expect(product.brief.purpose).toBe('product detail');
    expect(product.resource).toContain('/product/');
    for (const resource of resources) {
      const result = await client.readResource({ uri: resource.uri });
      const text = (result.contents[0] as { text: string }).text;
      const payload = JSON.parse(text) as { repo: string; snapshotId: string; evidence: unknown[] };
      expect(payload.repo).toBe('Demo / Perú');
      expect(payload.snapshotId).toBe(snapshot.id);
      expect(payload.evidence).toHaveLength(1);
      expect(text).not.toContain('source access disabled'); // no source read was attempted
    }
    const provenance = payloadOf(await client.callTool({ name: 'get_evidence', arguments: { evidenceId: evidence.id } })) as {
      evidence: { id: string }; source?: string;
    };
    expect(provenance.evidence.id).toBe(evidence.id);
    expect(provenance.source).toBeUndefined();
    const card = payloadOf(await client.callTool({ name: 'symbol_context', arguments: { symbol: symbol.qualifiedName } })) as { card: { purpose: string } };
    expect(card.card.purpose).toBe('symbol detail');
    store.createSnapshot({ repositoryId: snapshot.repositoryId, commitSha: 'next' });
    expect((await client.listResources()).resources).toHaveLength(0);
    await expect(client.readResource({ uri: resources[0]!.uri })).rejects.toThrow('No analysis');
  } finally { await client.close(); store.close(); }
});

test('product mode reads persisted document ranges without source access or a mounted repository', async () => {
  const { store, client } = await seedAndConnect(false);
  try {
    const snapshot = store.getLatestSnapshot()!;
    store.insertDocuments([{ id: 'doc', snapshotId: snapshot.id, repositoryId: snapshot.repositoryId, path: 'docs/product.md', title: 'Product',
      contentHash: 'fixture', content: ['# Product', ...Array.from({ length: 250 }, (_, index) => `Business rule ${index}`)].join('\n') }]);
    const result = payloadOf(await client.callTool({ name: 'get_evidence', arguments: { documentId: 'doc', startLine: 2, endLine: 250 } })) as { text: string; source: string };
    expect(result.source).toBe('indexed_document');
    expect(result.text).toContain('Business rule 0');
    expect(result.text).toContain('Business rule 248');
    expect(result.text).not.toContain('truncated');
    const source = payloadOf(await client.callTool({ name: 'get_evidence', arguments: { path: 'src/payment/service.ts' } })) as { error: string };
    expect(source.error).toContain('disabled');
    store.createSnapshot({ repositoryId: snapshot.repositoryId, commitSha: 'next-document' });
    const missing = payloadOf(await client.callTool({ name: 'get_evidence', arguments: { documentId: 'doc' } })) as { error: string };
    expect(missing.error).toContain('current snapshot');
  } finally { await client.close(); store.close(); }
});
