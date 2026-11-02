import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { importMutationReport, mutationPlan, mutationResults } from '@repolead/change-analysis';
import { refreshRepository, scanRepository } from '@repolead/code-graph';
import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'repolead-mutation-'));
const cli = join(project, 'apps/cli/dist/index.cjs');
const write = (path: string, source: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
try {
  write('.gitignore', '.repolead/\n');
  write('package.json', '{"name":"mutation-fixture","type":"module"}\n');
  const body = `export function price(x) { if (x < 0) return 0; return x + 1; }\nexport function untouched() { return 'PRIVATE_BODY_MARKER'; }\n`;
  write('src/price.js', body);
  write('test/price.test.js', `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { price } from '../src/price.js';\ntest('price', () => { assert.equal(price(-1), 0); assert.equal(price(2), 3); });\n`);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Mutation fixture'); git('config', 'user.email', 'mutation@example.invalid'); git('add', '.'); git('commit', '-m', 'Initial fixture');
  for (let index = 1; index < 5; index += 1) { write('src/price.js', `${body}// revision ${index}\n`); git('add', '.'); git('commit', '-m', `Revision ${index}`); }
  const scanned = await scanRepository({ rootPath: root, scip: false });
  const command = (args: string[]) => JSON.parse(execFileSync('node', [cli, 'mutation', '--db', scanned.dbPath, '--json', ...args], { cwd: root, encoding: 'utf8', timeout: 120000 }));
  const plan = command(['--limit', '1']);
  assert.equal(plan.targets.length, 1); assert.equal(plan.targets[0].startLine, 1); assert.equal(plan.targets[0].endLine, 1);
  const noReports = await openStore(scanned.dbPath);
  try { assert.equal(mutationResults(noReports, scanned.snapshotId).status, 'not_available'); } finally { noReports.close(); }
  assert.throws(() => command(['--run']), /test-command/);
  const started = Date.now();
  const execution = command(['--limit', '1', '--run', '--test-command', 'node --test test/price.test.js', '--timeout-ms', '60000']);
  const durationMs = Date.now() - started;
  assert.equal(execution.version, '10.1.1'); assert.equal(execution.origin, 'executed');
  assert.ok(execution.counts.Killed > 0); assert.equal(execution.counts.Pending, 0);
  assert.equal(readFileSync(join(root, 'src/price.js'), 'utf8'), `${body}// revision 4\n`);
  const config = JSON.parse(readFileSync(execution.configPath, 'utf8'));
  assert.equal(config.inPlace, false); assert.equal(config.mutate.length, 1); assert.equal(config.mutate[0], plan.mutate[0]);
  const saved = command(['--results', '--page-size', '1']);
  assert.equal(saved.id, execution.id); assert.equal(saved.mutants.items.length, 1);
  assert.ok(saved.mutants.items.every((mutant: { location: { start: { line: number }; end: { line: number } } }) => mutant.location.start.line === 1 && mutant.location.end.line === 1));
  assert.ok(!JSON.stringify(saved).includes('PRIVATE_BODY_MARKER'));
  const store = await openStore(scanned.dbPath);
  let importedId: string;
  try {
    const currentPlan = mutationPlan(store, scanned.snapshotId, { limit: 1 });
    const imported = importMutationReport(store, currentPlan, execution.reportPath);
    importedId = imported.id; assert.equal(imported.mutationScore, execution.mutationScore);
    const full = mutationResults(store, scanned.snapshotId);
    assert.equal(full.status, 'reported');
    if (full.status !== 'reported') { throw new Error('Missing imported report'); }
    assert.equal(full.origin, 'imported'); assert.equal(full.mutants!.total, saved.mutants.total);
    assert.ok(full.mutants!.items.every((mutant) => mutant.location.start.line === 1 && mutant.location.end.line === 1));
    const forged = JSON.parse(readFileSync(execution.reportPath, 'utf8'));
    forged.files['src/price.js'].source += '// unrelated version'; write('forged.json', JSON.stringify(forged));
    assert.throws(() => importMutationReport(store, currentPlan, join(root, 'forged.json')), /hash mismatch/);
  } finally { store.close(); }
  const doctor = JSON.parse(execFileSync('node', [cli, 'doctor', '--json'], { cwd: project, encoding: 'utf8' }));
  assert.ok(JSON.stringify(doctor).includes('stryker'));
  const client = new Client({ name: 'mutation-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command: 'node', args: [cli, 'serve', '--db', scanned.dbPath, '--no-source'], cwd: root, stderr: 'pipe' });
  let verifiedCalls = 0;
  try {
    await client.connect(transport);
    const call = async (args: Record<string, unknown> = {}) => {
      const response = await client.callTool({ name: 'mutation_results', arguments: args });
      assert.ok(!response.isError); const text = (response.content as { text: string }[])[0]!.text;
      assert.ok(!text.includes('PRIVATE_BODY_MARKER')); verifiedCalls += 1; return JSON.parse(text);
    };
    assert.equal((await call({ reportId: execution.id })).origin, 'executed');
    assert.equal((await call({ reportId: importedId! })).origin, 'imported');
    write('src/price.js', body + '// newer snapshot\n');
    await refreshRepository({ rootPath: root, scip: false });
    assert.equal((await call()).status, 'not_available');
    assert.equal((await call({ reportId: execution.id })).status, 'not_available');
  } finally { await client.close(); }
  const report = { generatedAt: new Date().toISOString(), fixture: 'Five real Git commits; actual Stryker command runner with node:test; selected first function only',
    strykerVersion: execution.version, durationMs, mutate: plan.mutate, counts: execution.counts, mutationScore: execution.mutationScore,
    verified: { planDoesNotExecute: true, explicitRunRequired: true, onlySelectedFunctionMutated: true, checkoutUnchanged: true,
      fullSourceHashChecked: true, forgedReportRejected: true, executedAndImportedProvenance: true, persisted: true,
      compiledNodeCli: true, doctor: true, mcpNoSource: true, oldSnapshotNotReused: true, verifiedCalls },
    limitations: ['This fixture executes real tests and mutants; it does not measure production test quality or generative token savings.',
      'Command runner uses coverageAnalysis off and can run the full supplied test command for each selected mutant.',
      'Imported reports verify mutated source hashes and ranges; they do not authenticate execution or dependency/test freshness.'],
    scriptHash: contentHash(readFileSync(fileURLToPath(import.meta.url))) };
  writeFileSync(join(project, 'benchmarks/mutation-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
