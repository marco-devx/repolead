import { expect, test } from '@rstest/core';

import type { CodeSymbol, Edge } from '@repolead/domain';
import { contentHash, fileUri, stableSymbolId } from '@repolead/domain';

import { applyMigrations } from './migrations';
import { openStore } from './store';

const REPO = 'payments-api';

async function seedSnapshot() {
  const store = await openStore(':memory:');
  const repository = store.upsertRepository({ name: REPO, rootPath: '/tmp/payments-api' });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'abc123' });

  const servicePath = 'src/payment/service.ts';
  const repoPath = 'src/payment/repository.ts';

  store.insertFiles(
    [servicePath, repoPath].map((path) => ({
      id: fileUri(REPO, path),
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      path,
      language: 'typescript',
      contentHash: contentHash(path),
      lineCount: 100,
      lastAuthor: null,
      lastCommitAt: null,
    })),
  );

  const service: CodeSymbol = {
    id: stableSymbolId({ repository: REPO, path: servicePath, kind: 'class', qualifiedName: 'PaymentService' }),
    repositoryId: repository.id,
    snapshotId: snapshot.id,
    path: servicePath,
    qualifiedName: 'PaymentService',
    kind: 'class',
    signature: null,
    startLine: 10,
    endLine: 90,
    contentHash: contentHash('class PaymentService {}'),
    source: 'tree-sitter',
  };
  const process_: CodeSymbol = {
    ...service,
    id: stableSymbolId({
      repository: REPO,
      path: servicePath,
      kind: 'method',
      qualifiedName: 'PaymentService.process',
      signature: '(command: CreatePaymentCommand): Payment',
    }),
    qualifiedName: 'PaymentService.process',
    kind: 'method',
    signature: '(command: CreatePaymentCommand): Payment',
    startLine: 24,
    endLine: 87,
  };
  const save: CodeSymbol = {
    ...service,
    id: stableSymbolId({ repository: REPO, path: repoPath, kind: 'method', qualifiedName: 'PaymentRepository.save' }),
    path: repoPath,
    qualifiedName: 'PaymentRepository.save',
    kind: 'method',
    startLine: 5,
    endLine: 20,
  };
  store.insertSymbols([service, process_, save]);

  const edges: Edge[] = [
    {
      snapshotId: snapshot.id,
      sourceId: service.id,
      targetId: process_.id,
      edgeType: 'CONTAINS',
      confidence: 1,
      analyzer: 'tree-sitter',
      evidence: { path: servicePath },
    },
    {
      snapshotId: snapshot.id,
      sourceId: process_.id,
      targetId: save.id,
      edgeType: 'CALLS',
      confidence: 0.95,
      analyzer: 'scip',
      evidence: { path: servicePath, line: 42 },
    },
  ];
  store.insertEdges(edges);

  return { store, repository, snapshot, service, process_, save };
}

test('round-trip: snapshot completo → FTS5 → grafo en memoria', async () => {
  const { store, snapshot, process_, save, service } = await seedSnapshot();

  const hits = store.searchSymbols(snapshot.id, 'payment process');
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]?.symbol.qualifiedName).toBe('PaymentService.process');

  const graph = store.loadGraph(snapshot.id);
  expect(graph.symbols.size).toBe(3);
  expect(graph.outgoing.get(process_.id)?.map((edge) => edge.edgeType)).toEqual(['CALLS']);
  expect(graph.incoming.get(save.id)?.[0]?.sourceId).toBe(process_.id);
  expect(graph.outgoing.get(service.id)?.[0]?.edgeType).toBe('CONTAINS');
  expect(graph.incoming.get(save.id)?.[0]?.evidence).toEqual({ path: 'src/payment/service.ts', line: 42 });

  store.close();
});

test('la búsqueda FTS respeta el snapshot y rankea por qualified_name', async () => {
  const { store, repository, snapshot } = await seedSnapshot();

  const otherSnapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'def456' });
  expect(store.searchSymbols(otherSnapshot.id, 'payment')).toEqual([]);
  expect(store.searchSymbols(snapshot.id, 'zzz-inexistente')).toEqual([]);
  expect(store.searchSymbols(snapshot.id, '')).toEqual([]);

  store.close();
});

test('findings con evidencia hacen round-trip', async () => {
  const { store, repository, snapshot } = await seedSnapshot();

  store.insertFinding(
    {
      id: 'finding-1',
      snapshotId: snapshot.id,
      repositoryId: repository.id,
      ruleId: 'ARCH-DEPENDENCY-001',
      severity: 'high',
      confidence: 0.93,
      claim: 'Domain module depends directly on Prisma',
      recommendation: 'Introduce a repository port owned by the domain',
      module: 'payments',
      status: 'confirmed',
      supersededBy: null,
      createdAt: new Date().toISOString(),
    },
    [
      {
        id: 'evidence-1',
        ownerId: 'finding-1',
        ownerKind: 'finding',
        path: 'src/payment/service.ts',
        startLine: 24,
        endLine: 87,
        excerpt: "import { PrismaClient } from '@prisma/client'",
      },
    ],
  );

  const findings = store.getFindings(snapshot.id, 'confirmed');
  expect(findings.length).toBe(1);
  expect(findings[0]?.ruleId).toBe('ARCH-DEPENDENCY-001');

  const evidence = store.getEvidence('finding-1');
  expect(evidence.length).toBe(1);
  expect(evidence[0]?.startLine).toBe(24);
  expect(evidence[0]?.ownerKind).toBe('finding');

  store.close();
});

test('upsertRepository es idempotente y las migraciones también', async () => {
  const { store, repository } = await seedSnapshot();

  const again = store.upsertRepository({ name: REPO, rootPath: '/otro/lugar' });
  expect(again.id).toBe(repository.id);
  expect(() => {
    applyMigrations(store.db);
  }).not.toThrow();

  store.close();
});
