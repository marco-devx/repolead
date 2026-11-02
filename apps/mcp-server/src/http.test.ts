import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';

import { afterAll, expect, test } from '@rstest/core';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openStore } from '@repolead/knowledge-store';
import type { KnowledgeStore } from '@repolead/knowledge-store';

import { startHttpServer } from './http';

const TOKEN = 'secret-token';
let server: Server | null = null;
let store: KnowledgeStore;
const ORIGIN = 'https://product.example';

async function seedAndStart(): Promise<string> {
  store = await openStore(':memory:');
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
    allowedOrigins: [ORIGIN],
    maxBodyBytes: 4096,
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}/mcp`;
}

const urlPromise = seedAndStart();

afterAll(async () => {
  if (server) { await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve())); }
  store.close();
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

test('official HTTP client negotiates, calls tools and reads resource templates', async () => {
  const client = new Client({ name: 'http-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(await urlPromise), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  try {
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe('repolead');
    expect((await client.listTools()).tools.some((tool) => tool.name === 'repo_overview')).toBe(true);
    expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(1);
    expect((await client.listResources()).resources).toEqual([]);
    const result = await client.callTool({ name: 'repo_overview', arguments: { audience: 'product' } });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text).repository).toBe('demo');
  } finally { await client.close(); }
});

test('HTTP sessions preserve the context-only tool profile and source restriction', async () => {
  await urlPromise;
  const lean = await startHttpServer([{ name: 'demo', store: store! }], { port: 0, token: TOKEN, exposeSource: false, toolProfile: 'context' });
  const address = lean.address();
  const client = new Client({ name: 'lean-http-test', version: '1' });
  try {
    if (!address || typeof address === 'string') { throw new Error('Expected TCP address.'); }
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
    expect((await client.listTools()).tools).toHaveLength(4);
    const result = await client.callTool({ name: 'get_evidence', arguments: { ranges: [{ path: 'src/a.ts' }] } });
    expect((result.content as { text: string }[])[0]!.text).toContain('source access disabled');
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => lean.close((error) => error ? reject(error) : resolve()));
  }
});

test('Origin allowlist and preflight never bypass authentication on MCP requests', async () => {
  const url = await urlPromise;
  for (const method of ['POST', 'GET', 'OPTIONS', 'DELETE']) {
    const denied = await fetch(url, { method, headers: { origin: 'https://untrusted.example', authorization: `Bearer ${TOKEN}` } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  }
  const preflight = await fetch(url, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
  const unauthenticated = await fetch(url, { method: 'POST', headers: { origin: ORIGIN } });
  expect(unauthenticated.status).toBe(401);
  const allowed = await fetch(url, { method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify(rpc('tools/list', {})) });
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get('vary')).toBe('Origin');
  expect(allowed.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  expect((await post(url, rpc('tools/list', {}), 'wrong-token!')).status).toBe(401);
});

async function chunkedPost(url: string, chunks: Buffer[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'transfer-encoding': 'chunked' } }, (response) => {
      const output: Buffer[] = [];
      response.on('data', (chunk: Buffer) => output.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(output).toString('utf8') }));
    });
    request.on('error', reject);
    for (const chunk of chunks) { request.write(chunk); }
    request.end();
  });
}

test('bounded request bodies reject malformed/oversized input and preserve split UTF-8', async () => {
  const url = await urlPromise;
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const malformed = await fetch(url, { method: 'POST', headers, body: '{' });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: 'bad request' });
  const oversized = await fetch(url, { method: 'POST', headers, body: ' '.repeat(4097) });
  expect(oversized.status).toBe(413);
  expect((await chunkedPost(url, [Buffer.alloc(2048, ' '), Buffer.alloc(2049, ' ')])).status).toBe(413);
  const repo = 'Perú 🙂';
  const bytes = Buffer.from(JSON.stringify(rpc('tools/call', { name: 'repo_overview', arguments: { repo } })));
  const split = bytes.indexOf(Buffer.from('🙂')) + 2;
  const unicode = await chunkedPost(url, [bytes.subarray(0, split), bytes.subarray(split)]);
  expect(unicode.status).toBe(200);
  const result = JSON.parse(unicode.body) as { result: { content: { text: string }[] } };
  expect(JSON.parse(result.result.content[0]!.text).error).toContain(repo);
  expect(unicode.body).not.toContain('�');
  expect((await post(url, rpc('tools/list', {}), TOKEN)).status).toBe(200);
});

test('invalid startup options and occupied ports reject without hanging; default bind is localhost', async () => {
  await urlPromise;
  const repos = [{ name: 'demo', store }];
  await expect(startHttpServer(repos, { port: 0, token: '  ' })).rejects.toThrow('nonempty');
  await expect(startHttpServer(repos, { port: -1, token: TOKEN })).rejects.toThrow('port');
  await expect(startHttpServer(repos, { port: 0, token: TOKEN, maxBodyBytes: 0 })).rejects.toThrow('maxBodyBytes');
  await expect(startHttpServer(repos, { port: 0, token: TOKEN, allowedOrigins: ['https://example.com/path'] })).rejects.toThrow('origins');
  const address = server!.address();
  expect(typeof address).toBe('object');
  if (!address || typeof address === 'string') { throw new Error('TCP address expected'); }
  expect(address.address).toBe('127.0.0.1');
  await expect(startHttpServer(repos, { port: address.port, token: TOKEN })).rejects.toThrow('EADDRINUSE');
  const unsupported = await fetch(await urlPromise, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`,
    accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '1900-01-01' }, body: JSON.stringify(rpc('tools/list', {})) });
  expect(unsupported.status).toBe(400);
  expect((await fetch((await urlPromise).replace('/mcp', '/missing'))).status).toBe(404);
});
