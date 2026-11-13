import { createServer } from 'node:http';
import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';
import { scanRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';
import { parseConfig } from '@repolead/config';
import { contentHash } from '@repolead/domain';

import { OllamaTechLeadModel } from './ollama-model';
import { analyzeSnapshot, analyzeSubject } from './analyze';
import { evidenceEntry, fitHierarchyPack } from './hierarchy';
import { ModelUsageError } from './model';
import { createChainFixture } from '../test-support/chain-fixture';
import { ContractModel } from '../test-support/contract-model';

interface LocalRequest {
  options: { num_predict: number; num_ctx: number };
  messages: { role: string; content: string }[];
  format: Record<string, unknown>;
}

async function localEndpoint(answer: (input: LocalRequest, index: number) => Promise<{
  reason: string; content: string; status?: number; replacementDigest?: string;
}>) {
  const requests: LocalRequest[] = []; let digest = 'a'.repeat(64);
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'qwen3.5:9b-q4_K_M', digest }] })); return; }
    let body = ''; for await (const chunk of req) { body += String(chunk); }
    const input = JSON.parse(body) as LocalRequest; requests.push(input);
    const result = await answer(input, requests.length);
    if (result.replacementDigest) { digest = result.replacementDigest; }
    res.statusCode = result.status ?? 200;
    res.end(JSON.stringify({ done: true, done_reason: result.reason, message: { content: result.content },
      prompt_eval_count: 100, eval_count: result.reason === 'length' ? input.options.num_predict : 5 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { requests, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

test('length recovery grows only the failing request, preserves cache identity and counts discarded generations', async () => {
  const endpoint = await localEndpoint(async (_input, index) => index < 3
    ? { reason: 'length', content: '{"partial":' } : { reason: 'stop', content: '{"ok":true}' });
  try {
    const model = await OllamaTechLeadModel.connect({ url: endpoint.url });
    const legacyName = `ollama:qwen3.5:9b-q4_K_M@${'a'.repeat(64)}:${contentHash(JSON.stringify({ url: endpoint.url,
      context: 131072, output: 4096, temperature: 0, think: false, version: 2 }))}`;
    expect(model.name).toBe(legacyName);
    const request = { system: 'test', prompt: 'Evidence remains unchanged.', schema: { type: 'object' } };
    const result = await model.complete(request);
    expect(endpoint.requests.map((entry) => entry.options.num_predict)).toEqual([4096, 8192, 16000]);
    expect(endpoint.requests[1]!.messages).toEqual(endpoint.requests[0]!.messages);
    expect(endpoint.requests[2]!.format).toEqual(request.schema);
    expect(endpoint.requests[2]!.options.num_ctx).toBeGreaterThan(endpoint.requests[0]!.options.num_ctx);
    expect(result.json).toEqual({ ok: true }); expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(4096 + 8192 + 5); expect(result.telemetry?.generationAttempts).toBe(3);
    await model.complete(request);
    expect(endpoint.requests[3]!.options.num_predict).toBe(4096);
    expect(model.name).toBe(legacyName);
  } finally { await endpoint.close(); }
});

test('length recovery is bounded by attempts, context headroom and the hard output ceiling', async () => {
  const endpoint = await localEndpoint(async () => ({ reason: 'length', content: '' }));
  const request = { system: 'test', prompt: 'test', schema: { type: 'object' } };
  try {
    const model = await OllamaTechLeadModel.connect({ url: endpoint.url });
    let failure: unknown;
    try { await model.complete(request); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ModelUsageError);
    expect((failure as ModelUsageError).usage).toEqual({ inputTokens: 300, outputTokens: 4096 + 8192 + 16000 });
    expect((failure as Error).message).toContain('after 3 attempt(s)');
    expect((failure as Error).message).toContain('completed summaries remain cached');
    const constrained = await OllamaTechLeadModel.connect({ url: endpoint.url, context: 8192 });
    const available = 8192 - Buffer.byteLength(request.system + request.prompt + JSON.stringify(request.schema), 'utf8') - 1024;
    await expect(constrained.complete(request)).rejects.toThrow(`output limit ${available} tokens`);
    expect(endpoint.requests.slice(3).map((entry) => entry.options.num_predict)).toEqual([4096, available]);
    expect(endpoint.requests.slice(3).every((entry) => entry.options.num_ctx <= 8192)).toBe(true);
    const maximum = await OllamaTechLeadModel.connect({ url: endpoint.url, output: 16000 });
    await expect(maximum.complete(request)).rejects.toThrow('after 1 attempt(s)');
    expect(endpoint.requests).toHaveLength(6);
  } finally { await endpoint.close(); }
});

test('non-length failures and changed model weights never trigger a length retry', async () => {
  let reason = 'unload'; let status = 200; let replacementDigest: string | undefined;
  const endpoint = await localEndpoint(async () => ({ reason, status, replacementDigest, content: '{}' }));
  const request = { system: 'test', prompt: 'test', schema: { type: 'object' } };
  try {
    const model = await OllamaTechLeadModel.connect({ url: endpoint.url });
    await expect(model.complete(request)).rejects.toThrow('incomplete: unload');
    expect(endpoint.requests).toHaveLength(1);
    status = 503;
    await expect(model.complete(request)).rejects.toThrow('HTTP 503');
    expect(endpoint.requests).toHaveLength(2);
    status = 200; reason = 'length'; replacementDigest = 'b'.repeat(64);
    await expect(model.complete(request)).rejects.toThrow('changed during generation');
    expect(endpoint.requests).toHaveLength(3);
  } finally { await endpoint.close(); }
});

test('resuming a failed synthesis preserves existing summaries and caches only complete validated output', async () => {
  const { root } = createChainFixture();
  const scan = await scanRepository({ rootPath: root, scip: false }); const store = await openStore(scan.dbPath);
  let recovering = false;
  const contract = new ContractModel();
  const endpoint = await localEndpoint(async (input) => {
    if (!recovering || input.options.num_predict === 4096) { return { reason: 'length', content: '{"responsibility":' }; }
    const completion = await contract.complete({ prompt: input.messages[1]!.content, schema: input.format });
    return { reason: 'stop', content: JSON.stringify(completion.json) };
  });
  try {
    const model = await OllamaTechLeadModel.connect({ url: endpoint.url });
    const legacyName = `ollama:qwen3.5:9b-q4_K_M@${'a'.repeat(64)}:${contentHash(JSON.stringify({ url: endpoint.url,
      context: 131072, output: 4096, temperature: 0, think: false, version: 2 }))}`;
    const legacy = new ContractModel(legacyName);
    const saved = fitHierarchyPack({ id: 'existing-file', name: 'Existing file', level: 'file' },
      [evidenceEntry('source', 'src/domain/price.ts', { source: 'export const price = 1;' })], 4000);
    const options = { store, snapshotId: scan.snapshotId, model, validationRetries: 0 };
    const before = await analyzeSubject({ ...options, model: legacy }, saved.pack, saved.evidence);
    const pack = fitHierarchyPack({ id: 'failing-module', name: 'Failing synthesis', level: 'module' }, saved.evidence.map((record) =>
      evidenceEntry('source', record.path, { source: 'export const price = 1;' })), 4000);
    await expect(analyzeSubject(options, pack.pack, pack.evidence)).rejects.toThrow('incomplete: length');
    expect(store.getSummary(scan.snapshotId, pack.pack.subject.id, 'module')).toBeNull();
    const failed = store.db.prepare("SELECT status,input_tokens,output_tokens FROM analysis_runs WHERE snapshot_id=? AND kind='module'").get(scan.snapshotId);
    expect(failed).toEqual({ status: 'failed', input_tokens: 300, output_tokens: 4096 + 8192 + 16000 });
    const cached = await analyzeSubject(options, saved.pack, saved.evidence);
    expect(cached.cached).toBe(true); expect(cached.summary.id).toBe(before.summary.id);
    expect(endpoint.requests).toHaveLength(3);
    recovering = true;
    const completed = await analyzeSubject(options, pack.pack, pack.evidence);
    expect(completed.cached).toBe(false); expect(completed.inputTokens).toBe(200); expect(completed.outputTokens).toBe(4096 + 5);
    expect(JSON.parse(completed.summary.contentJson).responsibility).toContain('Contract fixture');
    expect(endpoint.requests).toHaveLength(5);
    expect((await analyzeSubject(options, pack.pack, pack.evidence)).cached).toBe(true);
    expect(endpoint.requests).toHaveLength(5);
    expect(store.getSummary(scan.snapshotId, saved.pack.subject.id, 'file')!.id).toBe(before.summary.id);
  } finally { await endpoint.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Ollama checks installed digest, structured requests, accounting, completion and context limits', async () => {
  let digest = 'a'.repeat(64); let reason = 'stop'; let calls = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'qwen3.5:9b-q4_K_M', digest }] })); return; }
    let body = ''; for await (const chunk of req) { body += String(chunk); }
    const input = JSON.parse(body);
    expect(input.stream).toBe(false); expect(input.think).toBe(false); expect(input.options.num_ctx).toBeLessThan(131072); expect(input.options.temperature).toBe(0); expect(input.format).toEqual({ type: 'object' });
    calls += 1;
    res.end(JSON.stringify({ done: true, done_reason: reason, message: { content: '{"ok":true}' }, prompt_eval_count: 100, eval_count: 5 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const model = await OllamaTechLeadModel.connect({ url });
    const request = { system: 'test', prompt: 'test', schema: { type: 'object' } };
    const result = await model.complete(request);
    expect(result.json).toEqual({ ok: true }); expect(result.inputTokens).toBe(100); expect(result.telemetry?.provider).toBe('ollama-local');
    await expect(model.complete({ ...request, prompt: 'x'.repeat(131072) })).rejects.toThrow('context budget');
    expect(calls).toBe(1);
    reason = 'length'; await expect(model.complete(request)).rejects.toThrow('incomplete');
    digest = 'b'.repeat(64); await expect(model.complete(request)).rejects.toThrow('changed');
    await expect(OllamaTechLeadModel.connect({ url, digest: 'a'.repeat(64) })).rejects.toThrow('differs');
    const replacement = await OllamaTechLeadModel.connect({ url }); expect(replacement.name).not.toBe(model.name);
    await expect(OllamaTechLeadModel.connect({ url, model: 'absent' })).rejects.toThrow('not installed');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('a local primary handles nontrivial symbols and higher levels, counts local usage and reuses cached analyses', async () => {
  const { root } = createChainFixture();
  const scan = await scanRepository({ rootPath: root, scip: false }); const store = await openStore(scan.dbPath);
  try {
    const model = Object.assign(new ContractModel('local-primary'), { locality: 'local' as const });
    const complete = model.complete.bind(model);
    model.complete = async (request) => ({ ...await complete(request), inputTokens: 100, outputTokens: 10 });
    const options = { store, snapshotId: scan.snapshotId, model };
    const first = await analyzeSnapshot(options);
    expect(model.packs.some((pack) => pack.subject.name === 'checkout')).toBe(true);
    for (const level of ['symbol', 'file', 'module', 'repository']) {
      expect(model.packs.some((pack) => pack.subject.level === level)).toBe(true);
    }
    expect(first.localInputTokens).toBe(first.inputTokens);
    expect(first.localOutputTokens).toBe(first.outputTokens);
    expect(first.localInputTokens).toBeGreaterThan(0);
    const count = model.packs.length;
    const repeated = await analyzeSnapshot(options);
    expect(model.packs).toHaveLength(count);
    expect(repeated.localInputTokens).toBe(0);
    expect(repeated.localOutputTokens).toBe(0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('selection retains skipped source; critical and higher levels use primary; model routing participates in caching', async () => {
  const { root, git } = createChainFixture();
  writeFileSync(join(root, 'src/leaf/private.ts'), 'function tiny() { return 1; }\nexport function useful() { return tiny(); }\n'); git('add', '.');
  writeFileSync(join(root, 'src/consumer/constant.ts'), 'export function criticalConstant() { return 7; }\n'); git('add', '.');
  const scan = await scanRepository({ rootPath: root, scip: false }); const store = await openStore(scan.dbPath);
  try {
    const model = new ContractModel('primary'); const leafModel = new ContractModel('local');
    const options = { store, snapshotId: scan.snapshotId, model, leafModel, criticalModulePaths: ['src/consumer'], symbolSelection: 'public-or-nontrivial' as const };
    const first = await analyzeSnapshot(options);
    expect(first.symbolsSkipped).toBe(1);
    expect(leafModel.packs.length).toBeGreaterThan(0);
    expect(leafModel.packs.every((pack) => pack.subject.level === 'symbol' && !pack.subject.path?.startsWith('src/consumer/'))).toBe(true);
    expect(model.packs.some((pack) => pack.subject.name === 'checkout')).toBe(true);
    expect(model.packs.some((pack) => pack.subject.name === 'criticalConstant')).toBe(true);
    expect(model.packs.some((pack) => pack.subject.name === 'price')).toBe(true);
    const filePack = model.packs.find((pack) => pack.subject.level === 'file' && pack.subject.path === 'src/leaf/private.ts');
    expect(JSON.stringify(filePack)).toContain('function tiny()');
    const counts = [model.packs.length, leafModel.packs.length]; await analyzeSnapshot(options);
    expect([model.packs.length, leafModel.packs.length]).toEqual(counts);
    const replacement = new ContractModel('local-new-digest'); await analyzeSnapshot({ ...options, leafModel: replacement });
    expect(replacement.packs.length).toBe(counts[1]);
    expect(parseConfig('local_model: {}\nmodules:\n  - {name: billing, path: src/billing, critical: true}').local_model?.model).toBe('qwen3.5:9b-q4_K_M');
    expect(() => parseConfig('symbol_selection: unsafe')).toThrow();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
