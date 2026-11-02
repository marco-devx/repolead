import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { collectQuality, refreshRepository, scanRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';
import { analyzeSnapshot } from '@repolead/lead-analyzer';
import { DETECTORS, loadPolicies, runPolicies } from '@repolead/policy-engine';
import type { TechLeadModel } from '@repolead/lead-analyzer';

import { qualityFixture } from '../packages/code-graph/test-support/quality-fixture';
import { ContractModel } from '../packages/lead-analyzer/test-support/contract-model';

const projectRoot = resolve(import.meta.dir, '..');
const { root, write } = qualityFixture(true);
const cli = join(projectRoot, 'apps/cli/dist/index.cjs');
try {
  const scanned = await scanRepository({ rootPath: root, scip: false });
  const store = await openStore(scanned.dbPath);
  let report: Record<string, unknown>;
  let pythonId: string;
  try {
    const status = JSON.parse(store.getSnapshotMetadata(scanned.snapshotId, 'metrics_status')!);
    for (const tool of ['jscpd', 'ruff', 'radon']) { assert.equal(status.external[tool].status, 'complete', JSON.stringify(status)); }
    const symbols = store.listSymbols(scanned.snapshotId);
    pythonId = symbols.find((symbol) => symbol.path === 'calc.py' && symbol.qualifiedName === 'compute')!.id;
    const metrics = store.listMetrics(scanned.snapshotId);
    const issues = store.listQualityIssues(scanned.snapshotId);
    assert.equal(metrics.find((metric) => metric.subjectId === pythonId && metric.analyzer === 'quality:radon' && metric.name === 'cyclomatic_complexity')?.value, 3);
    assert.ok(issues.some((issue) => issue.analyzer === 'quality:ruff' && issue.ruleId === 'F821'));
    assert.ok(issues.some((issue) => issue.analyzer === 'quality:jscpd' && issue.locations.some((location) => location.path === 'src/one.ts')));
    assert.equal(store.listCoverage(scanned.snapshotId)[0]!.lineRate, 2 / 3);
    assert.equal(store.listCoverage(scanned.snapshotId)[0]!.branchRate, 0.5);
    const repeated = await collectQuality({ store, snapshotId: scanned.snapshotId, tools: ['jscpd', 'ruff', 'radon'], coveragePath: 'coverage/lcov.info' });
    for (const tool of Object.values(repeated.tools)) { assert.equal(tool.cached, true); }
    const model = new ContractModel();
    await analyzeSnapshot({ store, snapshotId: scanned.snapshotId, model });
    const calls = model.packs.length;
    assert.ok(JSON.stringify(model.packs).includes('quality:radon'));
    assert.ok(JSON.stringify(model.packs).includes('line_coverage'));
    await collectQuality({ store, snapshotId: scanned.snapshotId, tools: ['jscpd', 'ruff', 'radon'], coveragePath: 'coverage/lcov.info' });
    await analyzeSnapshot({ store, snapshotId: scanned.snapshotId, model });
    assert.equal(model.packs.length, calls, 'Cached tools must not invalidate otherwise identical analysis');
    const policies = loadPolicies(join(projectRoot, 'policies'));
    const candidateCounts = Object.fromEntries(policies.map((policy) => [policy.id, policy.detectors.reduce((count, detector) =>
      count + DETECTORS[detector.name]!(store, scanned.snapshotId, detector.params ?? {}).length, 0)]));
    for (const id of ['QUALITY-COMPLEXITY-001', 'QUALITY-ERRORS-001', 'QUALITY-DUPLICATION-001', 'QUALITY-PYTHON-001', 'ARCH-PERSISTENCE-001']) {
      assert.ok(candidateCounts[id]! > 0, `${id} must consume actual measurements`);
    }
    let judgeCalls = 0;
    const judge: TechLeadModel = { name: 'quality-contract-judge', complete: async ({ prompt }) => {
      judgeCalls += 1;
      const candidates = JSON.parse(prompt.slice(prompt.indexOf('[{'), prompt.lastIndexOf('}]') + 2)) as { index: number; claim: string }[];
      return { json: { verdicts: candidates.map((candidate) => ({ index: candidate.index,
        confirmed: !candidate.claim.includes('componentes de dependencias'), confidence: 0.8,
        reasoning: 'Contract fixture decision; not real model quality evaluation.' })) }, inputTokens: 0, outputTokens: 0 };
    } };
    const firstAudit = await runPolicies({ store, snapshotId: scanned.snapshotId, policies, model: judge });
    const firstJudgeCalls = judgeCalls;
    const secondAudit = await runPolicies({ store, snapshotId: scanned.snapshotId, policies, model: judge });
    assert.ok(firstJudgeCalls > 0); assert.equal(judgeCalls, firstJudgeCalls);
    assert.equal(firstAudit.missingEvidence, 0);
    assert.equal(firstAudit.omittedCandidates, 0);
    assert.equal(secondAudit.confirmed.length, firstAudit.confirmed.length);
    report = { generatedAt: new Date().toISOString(), runtime: process.version,
      tools: status.external, metricCount: metrics.length, issueCount: issues.length,
      pythonComplexity: 3, coverage: { lineRate: 2 / 3, branchRate: 0.5, sourceBinding: 'unverified', fixture: 'synthetic LCOV with prescribed execution counts' },
      repeat: { externalCacheHits: Object.keys(repeated.tools).length, newAnalysisCalls: model.packs.length - calls, newJudgeCalls: judgeCalls - firstJudgeCalls },
      policies: { count: policies.length, candidates: candidateCounts, confirmedContractFindings: firstAudit.confirmed.length },
      limits: ['Generative interpretation/false-positive quality and provider billing are not evaluated by the contract model.',
        'Builtin cognitive complexity is an estimate; graph fan counts are observed references, not dynamic reachability.',
        'Coverage has no whole-build binding; checksums, when supplied, verify reported lines only.'] };
  } finally { store.close(); }
  const cliReport = JSON.parse(execFileSync(process.execPath, [cli, 'metrics', '--db', scanned.dbPath, '--tools', 'jscpd,ruff,radon', '--coverage', 'coverage/lcov.info', '--json'],
    { cwd: root, encoding: 'utf8' }));
  assert.equal(cliReport.execution.tools.radon.cached, true);
  assert.equal(cliReport.coverage[0].lineRate, 2 / 3);
  const client = new Client({ name: 'quality-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--db', scanned.dbPath, '--no-source'], cwd: root, stderr: 'pipe' });
  const errors: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => errors.push(chunk.toString()));
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: 'symbol_context', arguments: { symbol: pythonId! } });
    const payload = JSON.parse((response.content as { text: string }[])[0]!.text);
    assert.ok(payload.quality.metrics.some((metric: { analyzer: string; value: number }) => metric.analyzer === 'quality:radon' && metric.value === 3));
    const overview = await client.callTool({ name: 'repo_overview', arguments: { audience: 'technical' } });
    assert.equal(JSON.parse((overview.content as { text: string }[])[0]!.text).metricsStatus.external.ruff.status, 'complete');
    report!['delivery'] = { compiledCli: true, realMcpStdio: true, noSource: true };
  } catch (error) { throw new Error(`${String(error)}\n${errors.join('')}`, { cause: error }); }
  finally { await client.close(); }
  // Coverage output is ignored by Git; importing it must not require a source change.
  write('coverage/lcov.info', 'SF:src/one.ts\nDA:2,1\nDA:3,1\nDA:4,1\nend_of_record\n');
  const refreshed = await refreshRepository({ rootPath: root, scip: false });
  assert.equal(refreshed.upToDate, true);
  const updated = await openStore(scanned.dbPath);
  try { assert.equal(updated.listCoverage(scanned.snapshotId)[0]!.lineRate, 1); }
  finally { updated.close(); }
  report!['coverageOnlyRefresh'] = true;
  writeFileSync(join(projectRoot, 'benchmarks/quality-acceptance.json'), JSON.stringify(report!, null, 2) + '\n');
  console.log(JSON.stringify(report!, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
