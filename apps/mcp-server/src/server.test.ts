import { expect, test } from '@rstest/core';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CodeSymbol } from '@repolead/domain';
import { moduleUri, stableSymbolId } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

import { createServer } from './server';

const REPO = 'demo';

async function seedAndConnect() {
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

  const server = createServer(store);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { store, client };
}

function payloadOf(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text) as unknown;
}

test('el servidor MCP expone las 7 tools y responde overview y callers', async () => {
  const { store, client } = await seedAndConnect();

  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
    'architecture_findings',
    'find_callers',
    'get_evidence',
    'module_context',
    'repo_overview',
    'search',
    'symbol_context',
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
  ) as { symbol: string }[];
  expect(search[0]?.symbol).toBe('PaymentService.process');

  store.close();
});
