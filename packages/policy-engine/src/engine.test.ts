import { expect, test } from '@rstest/core';

import type { CodeSymbol, Edge } from '@repolead/domain';
import { fileUri, moduleUri, stableSymbolId } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import type { TechLeadModel } from '@repolead/lead-analyzer';

import { DETECTORS } from './detectors';
import { runPolicies } from './engine';
import { parsePolicy } from './policy';

const REPO = 'demo';

/** Juez fake: confirma ciclos, rechaza lo demás (falsos positivos plantados). */
class FakeJudge implements TechLeadModel {
  readonly name = 'fake-judge';
  calls = 0;

  complete(request: { prompt: string }): ReturnType<TechLeadModel['complete']> {
    this.calls += 1;
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
