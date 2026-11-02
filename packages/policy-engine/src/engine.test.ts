import { expect, test } from '@rstest/core';

import type { CodeSymbol, Edge } from '@repolead/domain';
import { fileUri, moduleUri, stableSymbolId } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import type { TechLeadModel } from '@repolead/lead-analyzer';
import { countTokens } from '@repolead/retrieval';

import { DETECTORS } from './detectors';
import { runPolicies } from './engine';
import { parsePolicy } from './policy';

const REPO = 'demo';

/** Juez fake: confirma ciclos, rechaza lo demás (falsos positivos plantados). */
class FakeJudge implements TechLeadModel {
  readonly name = 'fake-judge';
  calls = 0;
  prompts: string[] = [];

  complete(request: { prompt: string }): ReturnType<TechLeadModel['complete']> {
    this.calls += 1;
    this.prompts.push(request.prompt);
    const candidates = (
      JSON.parse(request.prompt.slice(request.prompt.indexOf('[{'), request.prompt.lastIndexOf('}]') + 2)) as {
        index: number;
        claim: string;
      }[]
    );
    return Promise.resolve({
      json: {
        verdicts: candidates.map((candidate) => ({
          index: candidate.index,
          confirmed: candidate.claim.includes('Ciclo'),
          confidence: 0.9,
          reasoning: 'fake',
        })),
      },
      inputTokens: 10,
      outputTokens: 10,
    });
  }
}

async function seed() {
  const store = await openStore(':memory:');
  const repository = store.upsertRepository({ name: REPO, rootPath: '/demo' });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'abc' });

  const moduleA = moduleUri(REPO, 'src/orders');
  const moduleB = moduleUri(REPO, 'src/billing');
  store.insertModules([
    { id: moduleA, repositoryId: repository.id, snapshotId: snapshot.id, name: 'orders', path: 'src/orders' },
    { id: moduleB, repositoryId: repository.id, snapshotId: snapshot.id, name: 'billing', path: 'src/billing' },
  ]);

  const fileA = fileUri(REPO, 'src/orders/service.ts');
  const fileB = fileUri(REPO, 'src/billing/invoice.ts');

  const symbols: CodeSymbol[] = [];
  for (let index = 0; index < 6; index += 1) {
    symbols.push({
      id: stableSymbolId({ repository: REPO, path: 'src/orders/service.ts', kind: 'function', qualifiedName: `fn${index}` }),
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      path: 'src/orders/service.ts',
      qualifiedName: `fn${index}`,
      kind: 'function',
      signature: null,
      startLine: index * 5 + 1,
      endLine: index * 5 + 4,
      contentHash: `h${index}`,
      source: 'tree-sitter',
    });
  }
  store.insertSymbols(symbols);

  const edges: Edge[] = [
    // Ciclo entre módulos: violación real.
    {
      snapshotId: snapshot.id,
      sourceId: fileA,
      targetId: fileB,
      edgeType: 'IMPORTS',
      confidence: 1,
      analyzer: 'tree-sitter',
      evidence: { path: 'src/orders/service.ts', line: 1, specifier: '../billing/invoice' },
    },
    {
      snapshotId: snapshot.id,
      sourceId: fileB,
      targetId: fileA,
      edgeType: 'IMPORTS',
      confidence: 1,
      analyzer: 'tree-sitter',
      evidence: { path: 'src/billing/invoice.ts', line: 2, specifier: '../orders/service' },
    },
    // Pertenencia archivo→módulo.
    {
      snapshotId: snapshot.id,
      sourceId: moduleA,
      targetId: fileA,
      edgeType: 'CONTAINS',
      confidence: 1,
      analyzer: 'module-detection',
      evidence: null,
    },
    {
      snapshotId: snapshot.id,
      sourceId: moduleB,
      targetId: fileB,
      edgeType: 'CONTAINS',
      confidence: 1,
      analyzer: 'module-detection',
      evidence: null,
    },
  ];
  store.insertEdges(edges);
  return { store, snapshot };
}

const CYCLE_POLICY = parsePolicy(
  `id: ARCH-CYCLE-001
name: cycles
severity: high
candidate_detectors:
  - module_cycle
llm_judgment:
  question: real cycle?
`,
  'test.yaml',
);

const UNTESTED_POLICY = parsePolicy(
  `id: TEST-COVERAGE-001
name: untested
severity: medium
candidate_detectors:
  - name: untested_module
    params:
      minSymbols: 5
`,
  'test.yaml',
);

test('los detectores generan candidatos con evidencia', async () => {
  const { store, snapshot } = await seed();

  const cycles = DETECTORS['module_cycle']!(store, snapshot.id, {});
  expect(cycles.length).toBe(1);
  expect(cycles[0]?.claim).toContain('orders');
  expect(cycles[0]?.evidence.length).toBe(2);

  const untested = DETECTORS['untested_module']!(store, snapshot.id, { minSymbols: 5 });
  expect(untested.length).toBe(1);
  expect(untested[0]?.claim).toContain('orders');

  store.close();
});

test('el juez confirma violaciones reales y descarta falsos positivos', async () => {
  const { store, snapshot } = await seed();
  const judge = new FakeJudge();

  const result = await runPolicies({
    store,
    snapshotId: snapshot.id,
    policies: [CYCLE_POLICY, UNTESTED_POLICY],
    model: judge,
  });

  expect(result.candidates).toBe(2);
  expect(result.confirmed.length).toBe(1);
  expect(result.confirmed[0]?.ruleId).toBe('ARCH-CYCLE-001');
  expect(result.rejected).toBe(1);

  // El finding confirmado quedó persistido con su evidencia.
  const findings = store.getFindings(snapshot.id, 'confirmed');
  expect(findings.length).toBe(1);
  const evidence = store.getEvidence(findings[0]!.id);
  expect(evidence.length).toBe(2);
  expect(evidence[0]?.path).toContain('src/');

  store.close();
});

test('sin juez, los candidatos se guardan como status candidate', async () => {
  const { store, snapshot } = await seed();

  const result = await runPolicies({
    store,
    snapshotId: snapshot.id,
    policies: [CYCLE_POLICY],
    model: null,
  });

  expect(result.judged).toBe(false);
  expect(store.getFindings(snapshot.id, 'candidate').length).toBe(1);

  store.close();
});

test('repeated audits reuse positive and negative verdicts without duplicating findings or evidence', async () => {
  const { store, snapshot } = await seed();
  try {
    const judge = new FakeJudge();
    const options = { store, snapshotId: snapshot.id, policies: [CYCLE_POLICY, UNTESTED_POLICY], model: judge };
    const first = await runPolicies(options);
    const repeated = await runPolicies(options);
    expect(judge.calls).toBe(2);
    expect(repeated.cachedJudgments).toBe(2);
    expect(repeated.inputTokens).toBe(0);
    expect(repeated.rejected).toBe(1);
    expect(repeated.confirmed[0]?.id).toBe(first.confirmed[0]?.id);
    expect(store.getFindings(snapshot.id, 'confirmed')).toHaveLength(1);
    expect(store.getEvidence(first.confirmed[0]!.id)).toHaveLength(2);
    await runPolicies({ ...options, policies: [{ ...CYCLE_POLICY, version: '2' }] });
    expect(judge.calls).toBe(3);
    expect(store.getFindings(snapshot.id, 'confirmed')).toHaveLength(1);
    store.db.prepare("DELETE FROM edges WHERE snapshot_id = ? AND edge_type = 'IMPORTS'").run(snapshot.id);
    await runPolicies(options);
    expect(store.getFindings(snapshot.id, 'confirmed')).toHaveLength(0);
    expect(store.getFindings(snapshot.id, 'superseded')).toHaveLength(1);
  } finally { store.close(); }
});

test('enforces required evidence, deduplicates detector output and reports omitted candidates', async () => {
  const { store, snapshot } = await seed();
  try {
    const judge = new FakeJudge();
    const missing = await runPolicies({ store, snapshotId: snapshot.id, model: judge,
      policies: [{ ...CYCLE_POLICY, requiredEvidence: ['source_symbol'] }] });
    expect(missing.missingEvidence).toBe(1);
    expect(judge.calls).toBe(0);
    const duplicated = { ...CYCLE_POLICY, detectors: [...CYCLE_POLICY.detectors, ...CYCLE_POLICY.detectors] };
    const result = await runPolicies({ store, snapshotId: snapshot.id, model: judge, policies: [duplicated] });
    expect(result.candidates).toBe(1);
    expect(result.confirmed).toHaveLength(1);
    const bounded = await runPolicies({ store, snapshotId: snapshot.id, model: judge, policies: [duplicated], maxEvidencePerFinding: 1 });
    expect(bounded.candidates).toBe(0);
    expect(bounded.omittedCandidates).toBe(1);
    expect(bounded.omittedEvidence).toBe(1);
    expect(judge.calls).toBe(1);
    expect(store.getFindings(snapshot.id, 'confirmed')).toHaveLength(0);
  } finally { store.close(); }
});

test('judge output must cover all indices exactly once; invalid confidence exhausts bounded retries', async () => {
  const { store, snapshot } = await seed();
  try {
    let attempts = 0;
    const model: TechLeadModel = { name: 'invalid-judge', complete: async () => {
      attempts += 1;
      return { json: { verdicts: [{ index: 0, confirmed: true, confidence: 5, reasoning: 'invalid confidence' }] }, inputTokens: 20, outputTokens: 5 };
    } };
    await expect(runPolicies({ store, snapshotId: snapshot.id, policies: [CYCLE_POLICY], model, validationRetries: 1 })).rejects.toThrow();
    expect(attempts).toBe(2);
    expect(store.getFindings(snapshot.id, 'confirmed')).toHaveLength(0);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM policy_judgments').get()).toEqual({ n: 0 });
    expect(store.db.prepare("SELECT status, input_tokens FROM analysis_runs WHERE kind = 'policy'").get())
      .toEqual({ status: 'failed', input_tokens: 40 });
    const repeated: TechLeadModel = { name: 'duplicate-judge', complete: async () => ({
      json: { verdicts: [0, 0].map((index) => ({ index, confirmed: true, confidence: 0.8, reasoning: 'duplicate' })) }, inputTokens: 10, outputTokens: 5,
    }) };
    await expect(runPolicies({ store, snapshotId: snapshot.id, policies: [CYCLE_POLICY], model: repeated, validationRetries: 0 })).rejects.toThrow('exactly one verdict');
  } finally { store.close(); }
});

test('audit uses the requested snapshot and splits candidates into token-bounded batches', async () => {
  const { store, snapshot } = await seed();
  try {
    const another = store.upsertRepository({ name: 'other', rootPath: '/other' });
    store.createSnapshot({ repositoryId: another.id, commitSha: 'newer' });
    const judge = new FakeJudge();
    const result = await runPolicies({ store, snapshotId: snapshot.id, policies: [CYCLE_POLICY], model: judge });
    expect(result.confirmed[0]?.repositoryId).toBe(snapshot.repositoryId);
    store.insertEdges(store.listSymbols(snapshot.id).map((symbol) => ({ snapshotId: snapshot.id,
      sourceId: 'caller', targetId: symbol.id, edgeType: 'CALLS' as const, analyzer: 'fixture', confidence: 1, evidence: null })));
    const fanIn = parsePolicy('id: FAN-IN\nseverity: medium\ncandidate_detectors:\n  - name: high_fan_in\n    params:\n      threshold: 1', 'fixture.yaml');
    const batchJudge = new FakeJudge();
    const batches = await runPolicies({ store, snapshotId: snapshot.id, policies: [fanIn], model: batchJudge, maxTokens: 450 });
    expect(batches.candidates).toBe(6);
    expect(batchJudge.calls).toBeGreaterThan(1);
    expect(batchJudge.prompts.every((prompt) => countTokens(prompt) <= 450)).toBe(true);
    const limited = await runPolicies({ store, snapshotId: snapshot.id, policies: [fanIn], model: batchJudge, maxFindingsPerModule: 2 });
    expect(limited.candidates).toBe(2);
    expect(limited.omittedCandidates).toBe(4);
  } finally { store.close(); }
});

test('policy schema rejects invalid severity, unsupported evidence requirements and duplicate keys', () => {
  const base = 'id: policy\nseverity: high\ncandidate_detectors: [module_cycle]\n';
  expect(() => parsePolicy(base.replace('high', 'imaginary'), 'test.yaml')).toThrow();
  expect(() => parsePolicy(base + 'required_evidence: [imaginary]\n', 'test.yaml')).toThrow();
  expect(() => parsePolicy(base + 'severity: low\n', 'test.yaml')).toThrow();
});
