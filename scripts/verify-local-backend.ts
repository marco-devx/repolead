import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { openStore } from '@repolead/knowledge-store';

if (!process.argv.includes('--real')) { throw new Error('Use --real to run the installed Ollama model on an isolated fixture.'); }
const root = mkdtempSync(join(tmpdir(), 'repolead-local-backend-'));
const reportPath = resolve('benchmarks/local-backend-acceptance.json');
const calls: { phase: string; kind: 'memory' | 'audit'; model: string; inputTokens: number; outputTokens: number; durationMs: number; doneReason: string }[] = [];
const auditVerdicts: unknown[] = [];
let phase = 'onboard';
const proxy = createServer(async (req, res) => {
  try {
    assert.ok(['/api/tags', '/api/chat'].includes(req.url!));
    let body = ''; for await (const chunk of req) { body += String(chunk); }
    if (req.url === '/api/chat') { assert.ok(calls.length < 25, 'Local smoke call ceiling'); }
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:11434${req.url}`, {
      method: req.method, headers: { 'content-type': 'application/json' },
      ...(body ? { body } : {}), signal: AbortSignal.timeout(600000),
    });
    const data = await response.json();
    if (req.url === '/api/chat') {
      const kind = JSON.parse(body).format?.properties?.verdicts ? 'audit' : 'memory';
      if (kind === 'audit' && data.message?.content) { auditVerdicts.push(JSON.parse(data.message.content)); }
      calls.push({ phase, kind, model: data.model, inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0,
        durationMs: Date.now() - started, doneReason: data.done_reason ?? `HTTP ${response.status}` });
      // Store only final JSON content; never retain model thinking.
      writeFileSync(join(root, `completion-${calls.length}.json`), JSON.stringify({ ...calls.at(-1), content: data.message?.content }, null, 2));
      console.log(`${phase}: local call ${calls.length}, ${data.prompt_eval_count} in / ${data.eval_count} out`);
    }
    res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
  } catch (error) { res.writeHead(502); res.end(JSON.stringify({ error: String(error) })); }
});
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
const cli = resolve('apps/cli/dist/index.cjs');
const run = async (args: string[]) => {
  const child = spawn(process.execPath.endsWith('bun') ? 'node' : process.execPath, [cli, ...args], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ANTHROPIC_API_KEY: 'local-test-no-remote-key', ANTHROPIC_AUTH_TOKEN: 'local-test-no-remote-token',
      REPOLEAD_TEI_URL: 'http://127.0.0.1:1', REPOLEAD_QDRANT_URL: 'http://127.0.0.1:1' },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); process.stdout.write(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); process.stderr.write(chunk); });
  const [code] = await once(child, 'close');
  writeFileSync(join(root, `${phase}.log`), output);
  assert.equal(code, 0, `${phase} must complete`);
};
const started = Date.now();
try {
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'policies'));
  writeFileSync(join(root, 'src/tickets.ts'), `export function ticketPriority(urgent: boolean): string {
  if (urgent) {
    return 'high';
  }
  return 'normal';
}
`);
  writeFileSync(join(root, 'README.md'), '# Ticket priority\n\nThis library assigns high priority to urgent tickets and normal priority otherwise.\nA future release may send email notifications; this is not implemented.\n');
  writeFileSync(join(root, '.repolead.yaml'), `analysis_mode: symbols\nlocal_model:\n  url: ${url}\n  timeoutMs: 600000\n`);
  writeFileSync(join(root, 'policies/tests.yaml'), 'id: LOCAL-TESTS\nversion: 1\nname: Untested logic\ndescription: Branching ticket logic deserves tests.\nseverity: medium\nrequired_evidence: [location, test_links]\ncandidate_detectors:\n  - name: untested_module\n    params:\n      minSymbols: 1\nllm_judgment:\n  question: Does this module have meaningful logic without linked tests?\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('add', 'src/tickets.ts', 'README.md');
  git('-c', 'user.name=Local verification', '-c', 'user.email=local@example.invalid', 'commit', '-m', 'Local backend fixture');
  // No backend flag: verify local default despite the supplied dummy Anthropic credentials.
  await run(['onboard', '.', '--no-scip', '--policies', join(root, 'policies')]);
  const initialCalls = calls.length; assert.ok(initialCalls >= 6);
  assert.ok(calls.some((call) => call.kind === 'audit'), 'Must exercise a real local policy judgment');
  phase = 'analyze-repeat'; await run(['analyze']); assert.equal(calls.length, initialCalls);
  phase = 'audit-repeat'; await run(['audit', '--backend', 'ollama', '--policies', join(root, 'policies')]); assert.equal(calls.length, initialCalls);
  phase = 'refresh-repeat'; await run(['refresh', '.', '--analyze', '--backend', 'ollama', '--no-scip']); assert.equal(calls.length, initialCalls);
  const store = await openStore(join(root, '.repolead/repolead.db'));
  try {
    const snapshot = store.getLatestSnapshot()!;
    const summaries = store.listSummaries(snapshot.id);
    const levels = [...new Set(summaries.map((summary) => summary.level))];
    for (const level of ['symbol', 'file', 'module', 'repository', 'document', 'product']) { assert.ok(levels.includes(level as typeof levels[number])); }
    assert.ok(summaries.every((summary) => summary.model.startsWith('ollama:')));
    const symbol = summaries.find((summary) => summary.level === 'symbol')!;
    assert.match(symbol.contentJson, /urgent/i); assert.match(symbol.contentJson, /high/); assert.match(symbol.contentJson, /normal/);
    const product = JSON.parse(summaries.find((summary) => summary.level === 'product')!.contentJson);
    const claims = Object.values(product).flat().filter((claim): claim is { claim: string; basis: string } => Boolean(claim && typeof claim === 'object' && 'basis' in claim));
    assert.ok(!claims.some((claim) => claim.basis === 'implemented' && /email/i.test(claim.claim) && !/not|future|planned/i.test(claim.claim)));
    writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), passed: true, fixture: root,
      durationMs: Date.now() - started, levels, summaries: summaries.map(({ level, model, contentJson }) => ({ level, model, content: JSON.parse(contentJson) })),
      initialCalls, repeatCalls: calls.length - initialCalls, calls, auditVerdicts,
      inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0), outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
      semanticChecks: { symbolMentionsUrgentHighNormal: true, plannedEmailNotPromotedToImplemented: true, auditVerdictQualityScored: false },
      limits: 'Compiled CLI, real local model, six memory levels and a policy judgment on a tiny branching TS fixture. Repeated analyze/audit/refresh reuse cache. The audit checks transport/schema/cache, not correctness of its decision. SCIP and vector services intentionally disabled; not a broad semantic benchmark or a filled 120K input.' }, null, 2) + '\n');
  } finally { store.close(); }
  console.log(`Local backend acceptance passed: ${reportPath}`);
} catch (error) {
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), passed: false, fixture: root, phase, calls, error: String(error) }, null, 2) + '\n');
  throw error;
} finally {
  proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
