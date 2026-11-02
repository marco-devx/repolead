import { createServer } from 'node:http';
import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';
import { scanRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';
import { parseConfig } from '@repolead/config';

import { OllamaTechLeadModel } from './ollama-model';
import { analyzeSnapshot } from './analyze';
import { createChainFixture } from '../test-support/chain-fixture';
import { ContractModel } from '../test-support/contract-model';

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
