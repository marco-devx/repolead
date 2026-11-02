import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { openStore } from '@repolead/knowledge-store';

if (!process.argv.includes('--real')) { throw new Error('Use --real for the isolated local-model check.'); }
const resumeIndex = process.argv.indexOf('--resume');
const root = resumeIndex >= 0 ? resolve(process.argv[resumeIndex + 1]!) : mkdtempSync(join(tmpdir(), 'repolead-file-mode-'));
const reportPath = resolve('benchmarks/file-mode-acceptance.json');
const calls: { inputTokens: number; outputTokens: number; durationMs: number }[] = [];
if (resumeIndex >= 0) {
  const store = await openStore(join(root, '.repolead/repolead.db'));
  try {
    const rows = store.db.prepare("SELECT input_tokens, output_tokens, started_at, finished_at FROM analysis_runs WHERE status='completed' ORDER BY started_at")
      .all() as { input_tokens: number; output_tokens: number; started_at: string; finished_at: string }[];
    calls.push(...rows.map((row) => ({ inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      durationMs: Date.parse(row.finished_at) - Date.parse(row.started_at) })));
  } finally { store.close(); }
}
const preexistingCalls = calls.length;
const proxy = createServer(async (req, res) => {
  try {
    assert.ok(['/api/tags', '/api/chat'].includes(req.url!));
    let body = ''; for await (const chunk of req) { body += String(chunk); }
    if (req.url === '/api/chat') { assert.ok(calls.length < 10, 'Bounded real-model check'); }
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:11434${req.url}`, { method: req.method,
      headers: { 'content-type': 'application/json' }, ...(body ? { body } : {}), signal: AbortSignal.timeout(600000) });
    const data = await response.json();
    if (req.url === '/api/chat') { calls.push({ inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0, durationMs: Date.now() - started }); }
    res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
  } catch (error) { res.writeHead(502); res.end(JSON.stringify({ error: String(error) })); }
});
const resumePort = resumeIndex >= 0 ? Number(new URL(readFileSync(join(root, '.repolead.yaml'), 'utf8').match(/url:\s*(\S+)/)![1]!).port) : 0;
proxy.listen(resumePort, '127.0.0.1'); await once(proxy, 'listening');
const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
const cli = resolve('apps/cli/dist/index.cjs');
const started = Date.now();
async function run(label: string, args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env,
    REPOLEAD_TEI_URL: 'http://127.0.0.1:1', REPOLEAD_QDRANT_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const [code] = await once(child, 'exit'); writeFileSync(join(root, `${label}.log`), output);
  assert.equal(code, 0, output); console.log(`${label}: ${calls.length} cumulative model calls`);
}
try {
  if (resumeIndex < 0) {
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/access.ts'), [
    ...Array.from({ length: 8 }, (_, index) => `export interface Request${index} { document: string; age: number; }`),
    'export function createAccess(input: Request0, permissions: string[]) {',
    '  if (!permissions.includes("access.create")) throw new Error("Access denied");',
    '  if (!input.document) throw new Error("Document is required");',
    '  if (input.document.length > 12) throw new Error("Document exceeds 12 characters");',
    '  if (input.age < 18) return { status: "rejected", message: "Minimum age is 18" };',
    '  console.info("ACCESS_CREATED");',
    '  return { status: "approved", document: input.document };',
    '}',
  ].join('\n') + '\n');
  writeFileSync(join(root, '.repolead.yaml'), `analysis_mode: files\nlocal_model:\n  url: ${url}\n  timeoutMs: 600000\n`);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('add', 'src/access.ts');
  git('-c', 'user.name=RepoLead verification', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'File mode fixture');
  await run('onboard', ['onboard', '.', '--no-scip', '--no-audit', '--no-product']);
  } else { await run('resume', ['analyze', '--audience', 'technical']); }
  const initialCalls = calls.length;
  if (resumeIndex < 0) { assert.equal(initialCalls, 3, 'One file + module + repository, no per-symbol generations'); }
  const store = await openStore(join(root, '.repolead/repolead.db'));
  let facts: unknown;
  let messages: unknown;
  try {
    const snapshot = store.getLatestSnapshot()!;
    assert.equal(store.listSummaries(snapshot.id, 'symbol').length, 0);
    const dossier = JSON.parse(store.listSummaries(snapshot.id, 'file')[0]!.contentJson);
    facts = dossier.productFacts;
    messages = dossier.errors;
    // Literal messages may be in the dedicated errors list rather than duplicated in productFacts.
    const text = JSON.stringify({ productFacts: dossier.productFacts, errors: dossier.errors });
    assert.match(text, /access\.create/); assert.match(text, /Document is required/);
    assert.match(text, /12/); assert.match(text, /18/); assert.match(text, /ACCESS_CREATED/);
    assert.match(text, /approved/); assert.match(text, /rejected/);
    assert.ok(dossier.productFacts.every((fact: { evidenceIds: string[] }) => fact.evidenceIds.length > 0));
    assert.equal(JSON.parse(store.getSnapshotMetadata(snapshot.id, 'technical_analysis')!).completeSourceCoverage, true);
  } finally { store.close(); }
  await run('repeat', ['refresh', '.', '--analyze', '--no-scip', '--no-product']);
  assert.equal(calls.length, initialCalls, 'Unchanged refresh generates zero new calls');
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), passed: true, fixture: root,
    model: 'qwen3.5:9b-q4_K_M', durationMs: Date.now() - started, initialCalls, preexistingCalls, resumed: resumeIndex >= 0,
    repeatCalls: calls.length - initialCalls,
    calls, productFacts: facts, messages, limits: 'Real local model and compiled CLI on a small synthetic TS permission/validation/audit fixture. Checks preservation of selected concrete facts and valid evidence citations; not proof of universal quality equivalence or WLT wall-clock speed. Literal messages may be retained in the dedicated errors list rather than duplicated in productFacts; architectural risk interpretations are not scored.' }, null, 2) + '\n');
  console.log(`Passed: ${reportPath}`);
} catch (error) {
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), passed: false,
    fixture: root, calls, error: String(error) }, null, 2) + '\n');
  throw error;
} finally { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); }
