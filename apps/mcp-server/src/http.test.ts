import type { Server } from 'node:http';

import { afterAll, expect, test } from '@rstest/core';

import { openStore } from '@repolead/knowledge-store';

import { startHttpServer } from './http';

const TOKEN = 'secret-token';
let server: Server | null = null;

async function seedAndStart(): Promise<string> {
  const store = await openStore(':memory:');
  const repository = store.upsertRepository({ name: 'demo', rootPath: '/tmp/none' });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'abc' });
  store.insertFinding(
    {
      id: 'finding-1',
      snapshotId: snapshot.id,
      repositoryId: repository.id,
      ruleId: 'TEST-001',
      severity: 'high',
      confidence: 0.9,
      claim: 'demo claim',
      recommendation: null,
      module: null,
      status: 'confirmed',
      supersededBy: null,
      createdAt: new Date().toISOString(),
    },
    [
      {
        id: 'evidence-1',
        ownerId: 'finding-1',
        ownerKind: 'finding',
        path: 'src/a.ts',
        startLine: 1,
        endLine: 2,
        excerpt: 'const a = 1;',
      },
    ],
  );

  server = await startHttpServer([{ name: 'demo', store }], {
    port: 0,
    token: TOKEN,
    exposeSource: false,
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}/mcp`;
}

const urlPromise = seedAndStart();

afterAll(() => {
  server?.close();
});

function rpc(method: string, params: unknown, id = 1): unknown {
  return { jsonrpc: '2.0', id, method, params };
}

async function post(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test('rechaza requests sin bearer token', async () => {
  const url = await urlPromise;
  const response = await post(url, rpc('initialize', {}));
  expect(response.status).toBe(401);
});

test('atiende el handshake MCP y tool calls con token', async () => {
  const url = await urlPromise;
  const init = await post(
    url,
    rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    }),
    TOKEN,
  );
  expect(init.status).toBe(200);
  const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
  expect(initBody.result.serverInfo.name).toBe('repolead');

  const call = await post(
    url,
    rpc('tools/call', { name: 'repo_overview', arguments: {} }, 2),
    TOKEN,
  );
  const callBody = (await call.json()) as { result: { content: { text: string }[] } };
  const payload = JSON.parse(callBody.result.content[0]!.text) as { repository: string };
  expect(payload.repository).toBe('demo');
});

test('modo producto: get_evidence nunca sirve código fuente', async () => {
  const url = await urlPromise;
  const call = await post(
    url,
    rpc('tools/call', { name: 'get_evidence', arguments: { findingId: 'finding-1' } }, 3),
    TOKEN,
  );
  const body = (await call.json()) as { result: { content: { text: string }[] } };
  const evidence = JSON.parse(body.result.content[0]!.text) as { excerpt: string; source: string }[];
  expect(evidence[0]?.excerpt).toBe('const a = 1;');
  expect(evidence[0]?.source).toBe('(source access disabled on this server)');

  const byPath = await post(
    url,
    rpc('tools/call', { name: 'get_evidence', arguments: { path: 'src/a.ts' } }, 4),
    TOKEN,
  );
  const pathBody = (await byPath.json()) as { result: { content: { text: string }[] } };
  expect(JSON.parse(pathBody.result.content[0]!.text)).toEqual({
    error: 'source access disabled on this server',
  });
});
