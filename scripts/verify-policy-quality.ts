import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { scanRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';
import { AgentSdkTechLeadModel } from '@repolead/lead-analyzer';
import type { ModelCompletion, TechLeadModel } from '@repolead/lead-analyzer';
import { DETECTORS, loadPolicies, runPolicies } from '@repolead/policy-engine';

import { policyFixture } from '../packages/code-graph/test-support/policy-fixture';

if (!process.argv.includes('--real')) { throw new Error('This acceptance makes real Claude Code calls; pass --real explicitly.'); }
const projectRoot = resolve(import.meta.dir, '..');
const expected = [
  ['ARCH-CYCLE-001', 'cycles/sales/index.ts', true], ['ARCH-CYCLE-001', 'types/left/index.ts', false],
  ['ARCH-DEPENDENCY-001', 'domain/invoice.ts', true], ['ARCH-DEPENDENCY-001', 'domain/database.test.ts', false],
  ['ARCH-PERSISTENCE-001', 'domain/invoice.ts', true], ['ARCH-PERSISTENCE-001', 'domain/database.test.ts', false],
  ['ARCH-FRAMEWORK-TYPES-001', 'domain/checkout.ts', true], ['ARCH-FRAMEWORK-TYPES-001', 'domain/request.test.ts', false],
  ['QUALITY-COMPLEXITY-001', 'src/complex.ts', true], ['QUALITY-COMPLEXITY-001', 'src/dispatch.ts', false],
  ['QUALITY-ERRORS-001', 'src/payment.ts', true], ['QUALITY-ERRORS-001', 'src/cleanup.ts', false],
  ['QUALITY-DUPLICATION-001', 'src/order-pricing.ts', true], ['QUALITY-DUPLICATION-001', 'fixtures/compat-v1.ts', false],
  ['QUALITY-PYTHON-001', 'src/order-total.py', true], ['QUALITY-PYTHON-001', 'src/clean.py', false],
] as const;
const { root } = policyFixture();
const completions: { policy: string; inputTokens: number; outputTokens: number; telemetry?: ModelCompletion['telemetry']; verdicts: unknown }[] = [];
try {
  const scan = await scanRepository({ rootPath: root, scip: false });
  const store = await openStore(scan.dbPath);
  try {
    const toolStatus = JSON.parse(store.getSnapshotMetadata(scan.snapshotId, 'metrics_status')!);
    assert.equal(toolStatus.external.jscpd.status, 'complete'); assert.equal(toolStatus.external.ruff.status, 'complete');
    const ids = new Set(expected.map(([id]) => id));
    const policies = loadPolicies(join(projectRoot, 'policies')).filter((policy) => ids.has(policy.id as typeof expected[number][0]));
    assert.equal(policies.length, 8);
    const candidates = policies.flatMap((policy) => policy.detectors.flatMap((detector) => DETECTORS[detector.name]!(store, scan.snapshotId, detector.params ?? {})
      .map((candidate) => ({ policy: policy.id, candidate }))));
    const actual = new AgentSdkTechLeadModel();
    const measured: TechLeadModel = { name: actual.name, complete: async (request) => {
      if (completions.length >= 20) { throw new Error('Acceptance call ceiling reached.'); }
      const policy = request.prompt.split('\n')[0]!;
      console.log(`Judging ${policy}`);
      const result = await actual.complete(request);
      completions.push({ policy, inputTokens: result.inputTokens, outputTokens: result.outputTokens, telemetry: result.telemetry, verdicts: result.json });
      return result;
    } };
    const first = await runPolicies({ store, snapshotId: scan.snapshotId, policies, model: measured, maxTokens: 6000 });
    const calls = completions.length;
    const repeat = await runPolicies({ store, snapshotId: scan.snapshotId, policies, model: measured, maxTokens: 6000 });
    assert.equal(completions.length, calls);
    assert.equal(first.omittedCandidates, 0); assert.equal(first.missingEvidence, 0);
    assert.equal(repeat.confirmed.length, first.confirmed.length);
    const cases = expected.map(([policy, path, confirmed]) => {
      const detected = candidates.filter((entry) => entry.policy === policy && entry.candidate.evidence.some((evidence) => evidence.path === path)).length;
      const findings = first.confirmed.filter((finding) => finding.ruleId === policy && store.getEvidence(finding.id).some((evidence) => evidence.path === path));
      const observed = findings.length > 0;
      return { policy, path, expectedConfirmed: confirmed, detectedCandidates: detected, observedConfirmed: observed,
        pass: observed === confirmed && (!confirmed || detected > 0), findings: findings.map((finding) => ({ claim: finding.claim, confidence: finding.confidence })) };
    });
    const report = { generatedAt: new Date().toISOString(), backend: measured.name, fixture: 'Authored positives and legitimate counterexamples, TypeScript/Python',
      rulesEvaluated: policies.length, cases, passed: cases.filter((entry) => entry.pass).length, total: cases.length,
      inputTokens: first.inputTokens, outputTokens: first.outputTokens,
      estimatedCostUsd: completions.reduce((sum, completion) => sum + (completion.telemetry?.estimatedCostUsd ?? 0), 0),
      newCallsOnRepeat: completions.length - calls, cachedJudgments: repeat.cachedJudgments, completions,
      limits: ['Single authored fixture run; does not establish population-wide false-positive/negative rates.',
        'Tokens are real SDK query-pipeline counts including cached input; estimated cost is not a subscription invoice.',
        'This evaluates audit decisions, not whole-repository summary quality or end-to-end token savings.'] };
    writeFileSync(join(projectRoot, 'benchmarks/policy-quality-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, total: report.total, inputTokens: report.inputTokens, outputTokens: report.outputTokens,
      estimatedCostUsd: report.estimatedCostUsd, newCallsOnRepeat: report.newCallsOnRepeat, failures: cases.filter((entry) => !entry.pass) }, null, 2));
    assert.equal(report.passed, report.total, 'Review mismatched decisions and evidence; do not relabel fixtures to force a pass.');
  } finally { store.close(); }
} finally { rmSync(root, { recursive: true, force: true }); }
