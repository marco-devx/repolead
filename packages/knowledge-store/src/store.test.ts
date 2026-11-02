import { expect, test } from '@rstest/core';

import type { CodeSymbol, Edge } from '@repolead/domain';
import { contentHash, fileUri, stableSymbolId } from '@repolead/domain';

import { applyMigrations, MIGRATIONS } from './migrations';
import { openDatabase } from './driver';
import { KnowledgeStore, openStore } from './store';

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

test('migration preserves v1 summaries and adds atomic, reusable provenance links', async () => {
  const db = await openDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(MIGRATIONS[0]!.sql);
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (1, 'initial-schema', 'initial');");
  const store = new KnowledgeStore(db);
  try {
    const repo = store.upsertRepository({ name: 'legacy', rootPath: '/legacy' });
    const snapshot = store.createSnapshot({ repositoryId: repo.id, commitSha: 'old' });
    const base = { id: 'legacy-summary', snapshotId: snapshot.id, subjectId: 'repo://legacy', level: 'repository' as const,
      contentJson: '{"objective":"old knowledge"}', model: 'old-model', promptVersion: '2', contentHash: 'old', createdAt: '2020-01-01' };
    // A v1 database has no provenance tables; use its original write shape.
    db.prepare('INSERT INTO summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(base.id, base.snapshotId, base.subjectId, base.level, base.contentJson, base.model, base.promptVersion, base.contentHash, base.createdAt);
    db.prepare('INSERT INTO coverage (snapshot_id, path, line_rate, branch_rate) VALUES (?, ?, ?, ?)').run(snapshot.id, 'legacy.ts', 0.5, null);
    applyMigrations(db);
    expect(store.listCoverage(snapshot.id)[0]).toMatchObject({ path: 'legacy.ts', lineRate: 0.5, branchRate: null,
      analyzer: 'legacy-unverified', sourceHash: '', lines: [], provenance: { sourceBinding: 'unknown' } });
    expect(store.getSummary(snapshot.id, base.subjectId, 'repository')!.contentJson).toBe(base.contentJson);
    expect(store.getSummaryEvidence(base.id)).toEqual([]);
    const evidence = { id: 'ev_1', kind: 'source' as const, path: 'src/a.ts', startLine: 1, endLine: 2, contentHash: 'content', parentIds: [] };
    store.insertSummary({ ...base, id: 'new-summary', createdAt: '2026-01-01' }, [evidence]);
    expect(store.getSummaryEvidence('new-summary')).toEqual([evidence]);
    // Duplicate links fail the whole write, including the summary row.
    expect(() => store.insertSummary({ ...base, id: 'rollback' }, [evidence, evidence])).toThrow();
    expect(db.prepare('SELECT id FROM summaries WHERE id = ?').get('rollback')).toBeUndefined();
    expect(store.listSummaries(snapshot.id)).toHaveLength(1);
    expect(store.listSummaries(snapshot.id)[0]!.id).toBe('new-summary');
    store.rebuildSearchIndex(snapshot.id);
    expect(store.searchKnowledge(snapshot.id, 'old knowledge')[0]?.item.entityKind).toBe('summary');
    db.prepare('UPDATE summaries SET content_json = ? WHERE id = ?').run('{"objective":"replacement marker"}', 'new-summary');
    store.rebuildSearchIndex(snapshot.id);
    expect(store.searchKnowledge(snapshot.id, 'old')).toEqual([]);
    expect(store.searchKnowledge(snapshot.id, 'replacement')[0]?.item.entityKind).toBe('summary');
  } finally { store.close(); }
});

test('quality metrics/issues/coverage round-trip and non-finite metrics roll back atomically', async () => {
  const { store, snapshot } = await seedSnapshot();
  try {
    const metric = { snapshotId: snapshot.id, subjectId: 'subject', name: 'cyclomatic_complexity', value: 5, analyzer: 'quality:radon' };
    store.insertMetrics([metric]);
    expect(store.listMetrics(snapshot.id, 'subject')).toEqual([metric]);
    expect(() => store.insertMetrics([{ ...metric, value: 10 }, { ...metric, name: 'invalid', value: Infinity }])).toThrow();
    expect(store.listMetrics(snapshot.id, 'subject')).toEqual([metric]);
    const issue = { id: 'issue', snapshotId: snapshot.id, analyzer: 'quality:ruff', ruleId: 'F821', message: 'undefined name',
      locations: [{ path: 'code.py', startLine: 2, endLine: 2 }], details: { column: 4 } };
    store.insertQualityIssues([issue, issue]);
    expect(store.listQualityIssues(snapshot.id, 'code.py')).toEqual([issue]);
    expect(store.listQualityIssues(snapshot.id, 'another.py')).toEqual([]);
    const coverage = { snapshotId: snapshot.id, path: 'code.py', lineRate: 0.5, branchRate: null, analyzer: 'lcov', sourceHash: 'hash',
      lines: [{ line: 2, hits: 1 }, { line: 3, hits: 0 }], provenance: { sourceBinding: 'unverified' } };
    store.insertCoverage([coverage]);
    expect(store.listCoverage(snapshot.id)).toEqual([coverage]);
  } finally { store.close(); }
});
