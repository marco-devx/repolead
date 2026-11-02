import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { improvementOpportunities, listHotspots, refreshOpportunities } from '@repolead/change-analysis';
import { collectQuality, refreshRepository, scanRepository } from '@repolead/code-graph';
import { contentHash } from '@repolead/domain';
import type { ImprovementOpportunity } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import type { TechLeadModel } from '@repolead/lead-analyzer';
import { loadPolicies, runPolicies } from '@repolead/policy-engine';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'repolead-prioritization-'));
const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
const cli = join(project, 'apps/cli/dist/index.cjs');
let contractCalls = 0;
const model: TechLeadModel = {
  name: 'prescribed-prioritization-fixture-not-a-real-judge',
  complete: async ({ prompt }) => {
    contractCalls += 1;
    const candidates = JSON.parse(prompt.split('Candidates (JSON):\n')[1]!.split('\n\nReturn ')[0]!) as { index: number }[];
    return { json: { verdicts: candidates.map(({ index }) => ({ index, confirmed: true, confidence: 0.9, reasoning: 'Prescribed contract verdict; not a quality evaluation.' })) }, inputTokens: 0, outputTokens: 0 };
  },
};
try {
  write('.gitignore', '.repolead/\ncoverage/\n');
  write('package.json', '{"name":"priority-acceptance"}\n');
  write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' }, include: ['src'] }));
  write('.repolead.yaml', 'modules:\n  - {name: payments, path: src/payments}\n  - {name: api, path: src/api}\n');
  const body = `export function quote(value: number) {\n  let result = 0;\n${Array.from({ length: 16 }, (_, index) => `  if (value > ${index}) result += ${index};`).join('\n')}\n  return result; // PRIVATE_BODY_MARKER\n}\n`;
  write('src/payments/quote.ts', body);
  write('src/api/callers.ts', `import { quote } from '../payments/quote';\n${Array.from({ length: 6 }, (_, index) => `export function caller${index}() { return quote(${index}); }`).join('\n')}\n`);
  write('src/payments/quote.test.ts', `import { quote } from './quote';\ndeclare function test(name: string, run: () => void): void;\ntest('quote fixture', () => { quote(1); });\n`);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Priority acceptance'); git('config', 'user.email', 'priority@example.invalid');
  git('add', '.'); git('commit', '-m', 'Initial fixture');
  for (let index = 1; index <= 5; index += 1) {
    write('src/payments/quote.ts', `${body}// revision ${index}\n`); git('add', 'src/payments/quote.ts'); git('commit', '-m', `Fixture change ${index}`);
  }
  const scanned = await scanRepository({ rootPath: root });
  assert.ok(scanned.referencesResolved! > 0);
  const store = await openStore(scanned.dbPath);
  let hot!: ReturnType<typeof listHotspots>['items'][number];
  let findingOpportunity!: ImprovementOpportunity;
  let initialPriority = 0;
  try {
    const generated = improvementOpportunities(store, scanned.snapshotId);
    assert.equal(generated.status, 'current', 'scan must automatically publish opportunities');
    assert.equal(generated.total, 1);
    hot = listHotspots(store, scanned.snapshotId).items[0]!;
    assert.equal(hot.name, 'quote'); assert.equal(hot.factors.find((factor) => factor.id === 'complexity')!.value, 17);
    assert.equal(hot.factors.find((factor) => factor.id === 'churn')!.value, 6);
    assert.ok(hot.factors.find((factor) => factor.id === 'fan_in')!.value! >= 6);
    assert.equal(hot.factors.find((factor) => factor.id === 'coverage_gap')!.status, 'unknown');
    initialPriority = hot.priority;
    const quoteFile = store.listFiles(scanned.snapshotId).find((file) => file.path === hot.location.path)!;
    const source = store.getSnapshotSource(scanned.snapshotId, quoteFile.path)!;
    const lines = source.split('\n');
    write('coverage/fixture.lcov', `SF:${quoteFile.path}\n${lines.flatMap((line, index) => index < hot.location.endLine && line.trim()
      ? [`DA:${index + 1},0,${createHash('md5').update(line).digest('hex')}`] : []).join('\n')}\nend_of_record\n`);
    await collectQuality({ store, snapshotId: scanned.snapshotId, tools: [], coveragePath: 'coverage/fixture.lcov' });
    const covered = improvementOpportunities(store, scanned.snapshotId);
    assert.equal(covered.status, 'current', 'coverage update must automatically republish opportunities');
    assert.ok(covered.items[0]!.priority > initialPriority);
    hot = listHotspots(store, scanned.snapshotId).items[0]!;
    assert.equal(hot.factors.find((factor) => factor.id === 'coverage_gap')!.value, 1);
    const policies = loadPolicies(join(project, 'policies')).filter((policy) => policy.id === 'QUALITY-COMPLEXITY-001');
    assert.equal(policies.length, 1);
    const candidate = await runPolicies({ store, snapshotId: scanned.snapshotId, policies, model: null });
    assert.equal(candidate.candidates, 1);
    assert.equal(improvementOpportunities(store, scanned.snapshotId).total, 1, 'unjudged candidates do not become confirmed-finding opportunities');
    const judged = await runPolicies({ store, snapshotId: scanned.snapshotId, policies, model });
    assert.equal(judged.confirmed.length, 1); assert.equal(contractCalls, 1);
    const audited = improvementOpportunities(store, scanned.snapshotId);
    assert.equal(audited.status, 'current'); assert.equal(audited.total, 2);
    findingOpportunity = audited.items.find((entry) => entry.sourceKind === 'finding')!;
    assert.equal(findingOpportunity.sourceId, judged.confirmed[0]!.id);
    assert.ok(store.getEvidence(findingOpportunity.id).every((entry) => entry.path === quoteFile.path));
    const repeat = await runPolicies({ store, snapshotId: scanned.snapshotId, policies, model });
    assert.equal(repeat.cachedJudgments, 1); assert.equal(contractCalls, 1);
    assert.equal(refreshOpportunities(store, scanned.snapshotId).cached, true);
    assert.ok(!JSON.stringify(improvementOpportunities(store, scanned.snapshotId)).includes('PRIVATE_BODY_MARKER'));
  } finally { store.close(); }

  const command = (name: string, ...args: string[]) => JSON.parse(execFileSync('node', [cli, name, '--db', scanned.dbPath, '--json', ...args], { cwd: root, encoding: 'utf8' }));
  const cliHotspots = command('hotspots', '--module', 'payments');
  assert.equal(cliHotspots.total, 1); assert.equal(cliHotspots.items[0].priority, hot.priority);
  const cliOpportunities = command('opportunities', '--limit', '1');
  assert.equal(cliOpportunities.total, 2); assert.equal(cliOpportunities.items.length, 1); assert.equal(cliOpportunities.nextOffset, 1);
  const client = new Client({ name: 'prioritization-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command: 'node', args: [cli, 'serve', '--db', scanned.dbPath, '--no-source'], cwd: root, stderr: 'pipe' });
  let verifiedCalls = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError);
    const text = (result.content as { text: string }[])[0]!.text;
    assert.ok(!text.includes('PRIVATE_BODY_MARKER'));
    verifiedCalls += 1; return JSON.parse(text);
  };
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.ok(['hotspots', 'improvement_opportunities'].every((name) => tools.some((tool) => tool.name === name && tool.annotations?.readOnlyHint)));
    assert.equal((await call('hotspots', { module: 'payments' })).items[0].priority, hot.priority);
    const opportunities = await call('improvement_opportunities');
    assert.equal(opportunities.total, 2);
    const proof = await call('get_evidence', { opportunityId: findingOpportunity.id });
    assert.equal(proof.opportunity.sourceId, findingOpportunity.sourceId);
    assert.ok(proof.evidence.every((entry: { source: string }) => entry.source.includes('disabled')));

    const writer = await openStore(scanned.dbPath);
    try { writer.insertMetrics([{ snapshotId: scanned.snapshotId, subjectId: hot.symbolId, name: 'fan_in',
      value: hot.factors.find((factor) => factor.id === 'fan_in')!.value! + 1, analyzer: 'observed-graph-metrics-v1' }]); }
    finally { writer.close(); }
    assert.equal((await call('improvement_opportunities')).status, 'stale');
    assert.ok((await call('get_evidence', { opportunityId: findingOpportunity.id })).error);
    assert.equal(command('opportunities').status, 'current');
    assert.equal((await call('improvement_opportunities')).status, 'current');

    write('src/payments/quote.ts', `export function quote(value: number) { return value; }\n`);
    const refreshed = await refreshRepository({ rootPath: root });
    assert.ok(refreshed.scan);
    const current = await call('improvement_opportunities');
    assert.equal(current.status, 'current'); assert.equal(current.snapshotId, refreshed.scan.snapshotId);
    assert.equal(current.items.filter((entry: ImprovementOpportunity) => entry.sourceKind === 'finding').length, 0);
    assert.ok((await call('get_evidence', { opportunityId: findingOpportunity.id })).error);
    const fresh = await call('hotspots');
    assert.equal(fresh.items[0].factors.find((factor: { id: string }) => factor.id === 'coverage_gap').status, 'unknown');
    assert.equal(contractCalls, 1, 'No generative calls during ranking/queries/refresh');
  } finally { await client.close(); }
  const report = { generatedAt: new Date().toISOString(), runtime: { bun: process.versions.bun, platform: process.platform, compiledCli: 'Node' },
    fixture: 'Tracked TypeScript, actual SCIP references, six real Git commits, one complex function and six callers',
    measured: { initialPriority, verifiedCoveragePriority: hot.priority, factors: hot.factors },
    persistence: { scanPublishes: true, coveragePublishes: true, auditPublishes: true, excludesUnjudgedCandidates: true,
      repeatedProjectionCached: true, contractJudgeCalls: contractCalls, repeatedAuditCalls: 0, staleProjectionWithheld: true, oldSnapshotEvidenceRefused: true },
    delivery: { compiledCli: true, realMcpStdio: true, noSource: true, pagination: true, currentSnapshotVerified: true, verifiedCalls },
    limits: ['LCOV execution counts were prescribed, with actual MD5 source-line checksums; target tests were not run.',
      'The audit judge was a contract fixture, not a real generative quality evaluation.',
      'Priority is an uncalibrated heuristic; effort and business impact remain unknown.',
      'Mutation testing/Stryker is not implemented or executed by this acceptance.',
      'No provider tokens or end-to-end savings measured; deterministic prioritization makes no generative calls.'],
    scriptHash: contentHash(readFileSync(fileURLToPath(import.meta.url))) };
  writeFileSync(join(project, 'benchmarks/prioritization-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ measured: report.measured, persistence: report.persistence, delivery: report.delivery }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
