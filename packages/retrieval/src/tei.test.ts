import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { expect, test } from '@rstest/core';

import { EmbeddingInputError, TeiEmbeddingsClient } from './embeddings';
import { TeiRerankerClient } from './reranker';

async function service(handler: (path: string, body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) { chunks.push(Buffer.from(chunk)); }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    const path = request.url!;
    requests.push({ path, body });
    const result = handler(path, body);
    response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.json));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') { throw new Error('Missing test port'); }
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => close(server) };
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('TEI sends complete inputs, batches, pins cache identity and instructs Qwen queries only', async () => {
  const mock = await service((path, body) => ({ json: path === '/info'
    ? { model_id: 'Qwen/Qwen3-Embedding-0.6B', model_sha: 'a'.repeat(40), version: 'test', model_dtype: 'float16' }
    : (body['inputs'] as string[]).map(() => [0, 1]) }));
  try {
    const client = new TeiEmbeddingsClient(mock.url);
    expect(await client.cacheKey()).toBe(await client.cacheKey());
    await client.embed(Array.from({ length: 33 }, (_, index) => `complete document ${index}`));
    await client.embedQuery('¿Dónde está la regla?');
    expect(mock.requests.filter((entry) => entry.path === '/info').length).toBe(1);
    const embed = mock.requests.filter((entry) => entry.path === '/embed');
    expect(embed.map((entry) => (entry.body['inputs'] as string[]).length)).toEqual([32, 1, 1]);
    expect(embed.every((entry) => entry.body['truncate'] === false && entry.body['normalize'] === true)).toBe(true);
    expect((embed[0]!.body['inputs'] as string[])[0]).toBe('complete document 0');
    expect((embed[2]!.body['inputs'] as string[])[0]).toContain('Instruct:');
    expect((embed[2]!.body['inputs'] as string[])[0]).toContain('Query:¿Dónde está la regla?');
  } finally { await mock.close(); }
});

test('unknown revisions disable caching; rejected and malformed embeddings fail explicitly', async () => {
  let mode = 'input';
  const mock = await service((path) => path === '/info'
    ? { json: { model_id: 'mutable-alias', model_sha: null } }
    : mode === 'input' ? { status: 413, json: { error: 'input too large' } } : { json: [[null]] });
  try {
    const client = new TeiEmbeddingsClient(mock.url);
    expect(await client.cacheKey()).toBe(null);
    await expect(client.embed(['oversized'])).rejects.toBeInstanceOf(EmbeddingInputError);
    mode = 'invalid';
    await expect(client.embed(['ordinary'])).rejects.toThrow('invalid vectors');
  } finally { await mock.close(); }
});

test('reranker preserves input order and rejects duplicate indices instead of silently assigning zeros', async () => {
  let malformed = false;
  const mock = await service(() => ({ json: malformed ? [{ index: 0, score: 1 }, { index: 0, score: 0.5 }]
    : [{ index: 1, score: 0.8 }, { index: 0, score: 0.2 }] }));
  try {
    const client = new TeiRerankerClient(mock.url);
    expect(await client.rerank('question', ['document A', 'document B'])).toEqual([0.2, 0.8]);
    expect(mock.requests[0]!.body['truncate']).toBe(false);
    malformed = true;
    await expect(client.rerank('question', ['document A', 'document B'])).rejects.toThrow('invalid scores');
  } finally { await mock.close(); }
});

test('reranker batches more than 32 complete candidates and restores their global input order', async () => {
  const documents = Array.from({ length: 70 }, (_, i) => `candidate ${i}`);
  const mock = await service((_path, body) => ({ json: (body['texts'] as string[])
    .map((text, index) => ({ index, score: Number(text.split(' ')[1]) / 100 })).reverse() }));
  try {
    const scores = await new TeiRerankerClient(mock.url).rerank('question', documents);
    expect(scores).toEqual(documents.map((_, i) => i / 100));
    expect(mock.requests.map((entry) => (entry.body['texts'] as string[]).length)).toEqual([32, 32, 6]);
    expect(mock.requests.flatMap((entry) => entry.body['texts'])).toEqual(documents);
    expect(mock.requests.every((entry) => entry.body['truncate'] === false)).toBe(true);
  } finally { await mock.close(); }
});

test('one oversized reranking input does not discard scores of supported complete documents', async () => {
  const mock = await service((_path, body) => (body['texts'] as string[]).includes('oversized')
    ? { status: 422, json: { error: 'inputs must have less than 8192 tokens' } }
    : { json: (body['texts'] as string[]).map((text, index) => ({ index, score: text === 'A' ? 0.2 : 0.8 })) });
  try {
    expect(await new TeiRerankerClient(mock.url).rerank('question', ['A', 'oversized', 'B'])).toEqual([0.2, null, 0.8]);
    expect(mock.requests.every((entry) => entry.body['truncate'] === false)).toBe(true);
  } finally { await mock.close(); }
});
