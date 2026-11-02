import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { impactAnalysis, traceFlow } from '@repolead/change-analysis';
import { collectQuality, refreshRepository, scanRepository } from '@repolead/code-graph';
import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { countTokens } from '@repolead/retrieval';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'repolead-change-analysis-'));
const write = (path: string, source: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
try {
  write('.gitignore', '.repolead/\ncoverage/\n');
  write('package.json', '{"name":"change-acceptance"}\n');
  write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' }, include: ['src'] }));
  write('.repolead.yaml', 'modules:\n  - {name: api, path: src/api}\n  - {name: payments, path: src/payments}\n  - {name: storage, path: src/storage}\n');
  write('src/api/routes.ts', `import { handlePayment as registered } from '../payments/controller';
declare const router: { post(path: string, handler: (primary: boolean) => string): void };
router.post('/payments', registered);
export function unrelatedLabel() { return 'SOURCE_PRIVATE_MARKER'; }
`);
  write('src/payments/controller.ts', `import { primary, secondary } from './service';
export function handlePayment(first: boolean) { return first ? primary() : secondary(); }
`);
  write('src/payments/service.ts', `import { OrderRepository } from '../storage/repository';
const repository = new OrderRepository();
export function primary() { return repository.save('primary'); }
export function secondary() { return repository.save('secondary'); }
export function callbackOnly() { return repository.save; }
`);
  write('src/storage/repository.ts', `import { persistOrder } from './write';
export class OrderRepository {
  save(value: string) { return persistOrder(value); }
  private hidden() { return 'SOURCE_PRIVATE_MARKER'; }
}
`);
  write('src/storage/write.ts', `import { appendFileSync } from 'node:fs';
export function persistOrder(value: string) { appendFileSync('/tmp/repolead-never-executed', value); return value; }
`);
  write('src/payments/service.test.ts', `import { primary } from './service';
declare function test(name: string, run: () => void): void;
test('primary persists an order', () => { primary(); });
`);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Change acceptance'); git('config', 'user.email', 'change@example.invalid'); git('add', '.'); git('commit', '-m', 'Static change fixture');
  const scanned = await scanRepository({ rootPath: root });
  assert.ok(scanned.referencesResolved! > 0);
  const store = await openStore(scanned.dbPath);
  let flow: ReturnType<typeof traceFlow>; let impact: ReturnType<typeof impactAnalysis>;
  let saveId: string;
  try {
    const graph = store.loadGraph(scanned.snapshotId);
    const save = [...graph.symbols.values()].find((symbol) => symbol.qualifiedName === 'OrderRepository.save')!;
    saveId = save.id;
    flow = traceFlow(store, scanned.snapshotId, { from: 'POST /payments', to: 'persistOrder' });
    assert.ok(!('error' in flow));
    assert.equal(flow.paths.length, 2);
    assert.deepEqual(flow.paths.map((path) => path.nodes.map((node) => node.name).join(' → ')).sort(), [
      'POST /payments → handlePayment → primary → OrderRepository.save → persistOrder',
      'POST /payments → handlePayment → secondary → OrderRepository.save → persistOrder',
    ]);
    assert.ok(flow.paths.every((path) => path.edges[0]!.provenance.some((proof) => proof.analyzer === 'route-binding-scip')));
    for (const path of flow.paths) {
      for (const hop of path.edges) { assert.ok((graph.outgoing.get(hop.sourceId) ?? []).some((edge) => edge.targetId === hop.targetId && edge.edgeType === hop.type)); }
    }
    const callback = traceFlow(store, scanned.snapshotId, { from: 'callbackOnly', to: 'OrderRepository.save' });
    assert.ok(!('error' in callback)); assert.equal(callback.paths.length, 0);
    impact = impactAnalysis(store, scanned.snapshotId, { change: 'Add retry behavior to OrderRepository.save' });
    assert.ok(!('error' in impact));
    assert.ok(impact.affectedSymbols.items.some((symbol) => symbol.name === 'POST /payments'));
    assert.ok(impact.affectedSymbols.items.some((symbol) => symbol.name === 'callbackOnly'));
    assert.ok(!impact.affectedSymbols.items.some((symbol) => symbol.name === 'unrelatedLabel'));
    assert.equal(impact.relevantTests.items[0]?.name, 'primary persists an order');
    assert.ok(impact.publicContracts.items.some((symbol) => symbol.name === 'OrderRepository.save'));
    assert.ok(!impact.publicContracts.items.some((symbol) => symbol.name === 'OrderRepository.hidden'));
    assert.equal(impact.score.factors.find((factor) => factor.id === 'coverage_gap')!.status, 'unknown');
    assert.equal(impact.score.factors.find((factor) => factor.id === 'persistence')!.status, 'unknown', 'A method named save is not proof of a classified database edge.');
    const code = store.listFiles(scanned.snapshotId).filter((file) => file.language === 'typescript' && !file.path.endsWith('.test.ts'));
    const lcov = code.map((file) => {
      const lines = store.getSnapshotSource(scanned.snapshotId, file.path)!.split('\n');
      const entries = lines.flatMap((line, index) => line.trim() ? [`DA:${index + 1},1,${createHash('md5').update(line).digest('hex')}`] : []);
      return `SF:${file.path}\n${entries.join('\n')}\nend_of_record\n`;
    }).join('');
    write('coverage/fixture.lcov', lcov);
    await collectQuality({ store, snapshotId: scanned.snapshotId, tools: [], coveragePath: 'coverage/fixture.lcov' });
    impact = impactAnalysis(store, scanned.snapshotId, { symbols: [save.id] });
    assert.ok(!('error' in impact));
    assert.equal(impact.score.factors.find((factor) => factor.id === 'coverage_gap')!.status, 'reported');
    assert.equal(impact.score.factors.find((factor) => factor.id === 'coverage_gap')!.value, 1);
  } finally { store.close(); }
  const cli = join(projectRoot, 'apps/cli/dist/index.cjs');
  const cliTrace = JSON.parse(execFileSync(process.execPath, [cli, 'trace', 'POST /payments', 'persistOrder', '--db', scanned.dbPath, '--json'], { cwd: root, encoding: 'utf8' }));
  assert.equal(cliTrace.paths.length, 2);
  const cliImpact = JSON.parse(execFileSync(process.execPath, [cli, 'impact', '--symbol', saveId!, '--db', scanned.dbPath, '--json'], { cwd: root, encoding: 'utf8' }));
  assert.equal(cliImpact.score.observed, impact!.score.observed);
  const client = new Client({ name: 'change-analysis-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--db', scanned.dbPath, '--no-source'], cwd: root, stderr: 'pipe' });
  let verifiedCalls = 0;
  try {
    await client.connect(transport);
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('trace_flow') && toolNames.includes('impact_analysis'));
    for (const [name, args, field] of [
      ['trace_flow', { from: 'POST /payments', to: 'persistOrder' }, 'paths'],
      ['impact_analysis', { change: 'Add retries to OrderRepository.save' }, 'score'],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text: string }[])[0]!.text;
      assert.ok(!text.includes('SOURCE_PRIVATE_MARKER') && !text.includes('appendFileSync('));
      assert.ok(JSON.parse(text)[field]); verifiedCalls += 1;
    }
    write('src/api/routes.ts', `import { handlePayment } from '../payments/controller';
declare const router: { post(path: string, handler: (primary: boolean) => string): void };
router.post('/new-payments', handlePayment);
`);
    await refreshRepository({ rootPath: root });
    const old = await client.callTool({ name: 'trace_flow', arguments: { from: 'POST /payments', to: 'persistOrder' } });
    assert.ok(JSON.parse((old.content as { text: string }[])[0]!.text).error);
    const current = await client.callTool({ name: 'trace_flow', arguments: { from: 'POST /new-payments', to: 'persistOrder' } });
    assert.equal(JSON.parse((current.content as { text: string }[])[0]!.text).paths.length, 2); verifiedCalls += 2;
  } finally { await client.close(); }
  assert.ok(!('error' in flow!)); assert.ok(!('error' in impact!));
  const report = { generatedAt: new Date().toISOString(), runtime: { bun: process.versions.bun, platform: process.platform },
    fixture: 'Real TypeScript SCIP references, imported HTTP handler alias, two call branches, reference-only callback, public/private members and linked test',
    flow: { paths: flow.paths.map((path) => path.nodes.map((node) => node.name)), allHopsStored: true, callbackNotTreatedAsCall: true },
    impact: { affectedSymbols: impact.affectedSymbols.total, relevantTests: impact.relevantTests.total, publicContracts: impact.publicContracts.total,
      score: impact.score, coverage: 'Synthetic LCOV with MD5 source-line checksums; reported execution counts are prescribed, tests not executed.' },
    delivery: { compiledCli: true, realMcpStdio: true, noSource: true, currentSnapshotVerified: true, verifiedCalls },
    tokenSizes: { tokenizer: 'o200k_base proxy, response JSON only', trace: countTokens(JSON.stringify(flow)), impact: countTokens(JSON.stringify(impact)) },
    limits: ['Static shortest call paths, not runtime/data-flow proof; longer alternative paths are not enumerated.',
      'No arbitrary external side-effect classification; persistence and unrecorded effects stay unknown unless supplied as change facts or recorded by an analyzer.',
      'Workflow is a provisional recommendation; no collaborating agents, target tests or target source code were executed.',
      'No real LLM answer quality, provider usage or end-to-end token savings measured.'],
    scriptHash: contentHash(readFileSync(fileURLToPath(import.meta.url))) };
  writeFileSync(join(projectRoot, 'benchmarks/change-analysis-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ flowPaths: report.flow.paths, impactSymbols: report.impact.affectedSymbols, delivery: report.delivery, tokenSizes: report.tokenSizes }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
