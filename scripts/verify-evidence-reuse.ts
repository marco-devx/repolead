import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { refreshRepository, scanRepository } from '@repolead/code-graph';
import { contentHash } from '@repolead/domain';
import { countTokens } from '@repolead/retrieval';

// Measure transport content, not an LLM answer, inference bill, or the manual-exploration roadmap gate.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'repolead-evidence-reuse-'));
const paths = ['adapters/git/src/index.ts', 'packages/code-graph/src/refresh.ts',
  'packages/lead-analyzer/src/analyze.ts', 'packages/lead-analyzer/src/dependencies.ts',
  'packages/lead-analyzer/src/file-analysis.ts'];
const manifest = paths.map((path) => {
  const source = readFileSync(join(project, path), 'utf8');
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source);
  return { path, sha256: contentHash(source), bytes: Buffer.byteLength(source) };
});
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
let transport: StdioClientTransport | undefined;
let client: Client | undefined;
try {
  writeFileSync(join(root, 'package.json'), '{"name":"repolead-reuse-acceptance"}\n');
  writeFileSync(join(root, '.gitignore'), '.repolead/\n');
  git('init', '-b', 'main'); git('config', 'user.name', 'Acceptance'); git('config', 'user.email', 'acceptance@example.invalid');
  git('add', '.'); git('commit', '-m', 'Captured current source');
  const scanned = await scanRepository({ rootPath: root, scip: false });
  const stderr: string[] = [];
  transport = new StdioClientTransport({ command: process.execPath,
    args: [join(project, 'apps/cli/dist/index.cjs'), 'serve', '--db', scanned.dbPath, '--tool-profile', 'context'],
    cwd: root, stderr: 'pipe', env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      REPOLEAD_TEI_URL: 'http://127.0.0.1:1', REPOLEAD_QDRANT_URL: 'http://127.0.0.1:1', REPOLEAD_RERANKER_URL: 'http://127.0.0.1:1' } });
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  client = new Client({ name: 'evidence-reuse-acceptance', version: '1' });
  await client.connect(transport);
  const args = { mode: 'evidence', queries: ['collectHistory CO_CHANGE_MAX_FILES_PER_COMMIT history',
    'refreshRepository invalidation changed files', 'buildDependencyIndex dependency fingerprint', 'analyzeFiles planFileAnalysis'],
    types: ['symbol'], maxTokens: 120000 };
  const call = async (knownBlocks: string[]) => {
    const request = { name: 'context_pack', arguments: { ...args, knownBlocks } };
    const response = await client!.callTool(request);
    assert.ok(!response.isError, JSON.stringify(response));
    const text = (response.content as { type: string; text: string }[]).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    const hashes = [...text.matchAll(/sha256=([a-f0-9]{64})/g)].map((match) => match[1]!);
    return { request, response, text, hashes, requestTokens: countTokens(JSON.stringify(request)),
      responseTokens: countTokens(JSON.stringify(response)), textTokens: countTokens(text) };
  };
  const initial = await call([]);
  assert.ok(initial.hashes.length >= 4, 'Real queries must retrieve multiple source blocks.');
  assert.ok(!initial.text.includes('UNCHANGED sha256='));
  const repeated = await call(initial.hashes);
  assert.deepEqual(repeated.hashes, initial.hashes);
  assert.equal([...repeated.text.matchAll(/UNCHANGED sha256=/g)].length, initial.hashes.length);
  assert.ok(!repeated.text.includes('export async function'));
  assert.ok(repeated.responseTokens < initial.responseTokens, 'Same evidence should cost fewer response tokens on reuse.');
  const recovered = await call([]);
  assert.equal(recovered.text, initial.text, 'Compacted/forgotten context can always request complete blocks again.');
  // Mutate only the isolated capture. The running WLT indexes, models and services remain untouched.
  const path = 'adapters/git/src/index.ts';
  const source = readFileSync(join(root, path), 'utf8');
  assert.ok(source.includes('const CO_CHANGE_MAX_FILES_PER_COMMIT = 30;'));
  writeFileSync(join(root, path), source.replace('const CO_CHANGE_MAX_FILES_PER_COMMIT = 30;', 'const CO_CHANGE_MAX_FILES_PER_COMMIT = 29;'));
  const stale = await call(initial.hashes);
  assert.ok(stale.text.includes('source changed since indexing'));
  const refreshed = await refreshRepository({ rootPath: root, scip: false });
  const changed = await call(initial.hashes);
  assert.ok(changed.hashes.some((hash) => !initial.hashes.includes(hash)), 'Changed file produces newly delivered blocks.');
  assert.ok(changed.text.includes('CO_CHANGE_MAX_FILES_PER_COMMIT = 29'));
  assert.ok(changed.text.includes('UNCHANGED '), 'Unrelated unchanged blocks stay reusable after a new snapshot.');
  const summarize = (value: typeof initial) => ({ requestTokens: value.requestTokens, responseTokens: value.responseTokens,
    textTokens: value.textTokens, requestAndResponseTokens: value.requestTokens + value.responseTokens, hashes: value.hashes, text: value.text });
  const report = { generatedAt: new Date().toISOString(), passed: true, tokenizer: 'o200k_base', manifest,
    transport: 'Compiled Node CLI, official MCP SDK, stdio, isolated current-source capture; lexical retrieval only',
    initial: summarize(initial), repeated: summarize(repeated), recovered: summarize(recovered), changed: summarize(changed),
    responseReductionPercent: (1 - repeated.responseTokens / initial.responseTokens) * 100,
    requestAndResponseReductionPercent: (1 - (repeated.requestTokens + repeated.responseTokens) / (initial.requestTokens + initial.responseTokens)) * 100,
    scanMs: scanned.durationMs, refreshMs: refreshed.durationMs,
    checks: ['Same receipts reuse all returned blocks', 'Lost conversation blocks can be fetched again',
      'Unindexed source changes invalidate receipts', 'Indexed changes send new content', 'Unrelated blocks reuse across snapshots'],
    limits: ['Counts are logical transport tokens, not model input/output usage or billing.',
      'The first retrieval is not free. Reuse requires the exact previous text to remain in the client conversation.',
      'No generative quality evaluation or comparison with equivalent manual exploration; this does not complete the roadmap 90% gate.',
      'Five real source files, fixed queries, lexical retrieval; no synthetic padding, remote calls or production-index mutation.'], stderr };
  writeFileSync(join(project, 'benchmarks/evidence-reuse-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, blocks: initial.hashes.length, responseReductionPercent: report.responseReductionPercent,
    requestAndResponseReductionPercent: report.requestAndResponseReductionPercent, initialTokens: initial.requestTokens + initial.responseTokens,
    repeatedTokens: repeated.requestTokens + repeated.responseTokens }));
} finally {
  await client?.close(); await transport?.close(); rmSync(root, { recursive: true, force: true });
}
