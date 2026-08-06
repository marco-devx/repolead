import { expect, test } from '@rstest/core';

import type { CodeSymbol } from '@repolead/domain';
import { fileUri, moduleUri, stableSymbolId } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

import { analyzeSnapshot } from './analyze';
import { buildModuleEvidencePack } from './evidence';
import type { TechLeadModel } from './model';

class FakeModel implements TechLeadModel {
  readonly name = 'fake-model';
  calls = 0;

  complete(request: { schema: object }): ReturnType<TechLeadModel['complete']> {
    this.calls += 1;
    const isBrief = JSON.stringify(request.schema).includes('boundedContexts');
    const json = isBrief
      ? {
          objective: 'demo',
          architecture: 'layered',
          entryPoints: [],
          boundedContexts: [],
          criticalFlows: [],
          persistence: 'sqlite',
          testing: 'rstest',
          hotspots: [],
          technicalDebt: [],
          conventions: [],
        }
      : {
          responsibility: 'payments',
          publicApi: ['PaymentService.process'],
          dependencies: { incoming: [], outgoing: [] },
          mainFlows: [],
          strengths: [],
          risks: [{ claim: 'no tests', severity: 'high', evidence: ['src/payment/service.ts'] }],
          opportunities: [],
          testStrategy: 'none',
        };
    return Promise.resolve({ json, inputTokens: 100, outputTokens: 50 });
  }
}

const REPO = 'demo';

async function seed(symbolCount = 3) {
  const store = await openStore(':memory:');
  const repository = store.upsertRepository({ name: REPO, rootPath: '/demo' });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'abc' });

  store.insertModules([
    {
      id: moduleUri(REPO, 'src/payment'),
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      name: 'payment',
      path: 'src/payment',
    },
  ]);

  const symbols: CodeSymbol[] = [];
  for (let index = 0; index < symbolCount; index += 1) {
    const qualifiedName = index === 0 ? 'PaymentService.process' : `helper${index}`;
    symbols.push({
      id: stableSymbolId({ repository: REPO, path: 'src/payment/service.ts', kind: 'function', qualifiedName }),
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      path: 'src/payment/service.ts',
      qualifiedName,
      kind: 'function',
      signature: null,
      startLine: index * 10 + 1,
      endLine: index * 10 + 5,
      contentHash: `hash-${qualifiedName}`,
      source: 'tree-sitter',
    });
  }
  store.insertSymbols(symbols);
  store.insertFiles([
    {
      id: fileUri(REPO, 'src/payment/service.ts'),
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      path: 'src/payment/service.ts',
      language: 'typescript',
      contentHash: 'file-hash',
      lineCount: 100,
      lastAuthor: null,
      lastCommitAt: null,
    },
  ]);
  if (symbols.length >= 2) {
    store.insertEdges([
      {
        snapshotId: snapshot.id,
        sourceId: symbols[1]!.id,
        targetId: symbols[0]!.id,
        edgeType: 'CALLS',
        confidence: 0.9,
        analyzer: 'scip',
        evidence: null,
      },
    ]);
  }
  return { store, repository, snapshot, symbols };
}

test('analiza módulos y brief, y el segundo run idéntico no llama al modelo', async () => {
  const { store, repository, snapshot } = await seed();
  const model = new FakeModel();

  const first = await analyzeSnapshot({ store, snapshotId: snapshot.id, model });
  expect(first.modulesAnalyzed).toBe(1);
  expect(first.briefGenerated).toBe(true);
  expect(model.calls).toBe(2);
  expect(first.inputTokens).toBe(200);

  // Nuevo snapshot con el mismo contenido → todo sale de caché, 0 llamadas.
  const secondSnapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'abc' });
  store.db
    .prepare(
      `INSERT INTO modules SELECT id, repository_id, ?, name, path FROM modules WHERE snapshot_id = ?`,
    )
    .run(secondSnapshot.id, snapshot.id);
  store.db
    .prepare(
      `INSERT INTO symbols SELECT id, repository_id, ?, path, qualified_name, kind, signature,
         start_line, end_line, content_hash, source FROM symbols WHERE snapshot_id = ?`,
    )
    .run(secondSnapshot.id, snapshot.id);
  store.db
    .prepare(
      `INSERT INTO files SELECT id, repository_id, ?, path, language, content_hash, line_count,
         last_author, last_commit_at FROM files WHERE snapshot_id = ?`,
    )
    .run(secondSnapshot.id, snapshot.id);
  store.db
    .prepare(
      `INSERT INTO edges SELECT ?, source_id, target_id, edge_type, confidence, analyzer,
         evidence_json FROM edges WHERE snapshot_id = ?`,
    )
    .run(secondSnapshot.id, snapshot.id);

  const second = await analyzeSnapshot({ store, snapshotId: secondSnapshot.id, model });
  expect(second.modulesAnalyzed).toBe(0);
  expect(second.modulesCached).toBe(1);
  expect(second.briefCached).toBe(true);
  expect(model.calls).toBe(2);

  // El summary cacheado quedó copiado al snapshot nuevo (consultable por MCP).
  const rows = store.db
    .prepare("SELECT COUNT(*) AS n FROM summaries WHERE snapshot_id = ? AND level = 'module'")
    .get(secondSnapshot.id) as { n: number };
  expect(rows.n).toBe(1);

  store.close();
});

test('un cambio en el módulo invalida solo su caché', async () => {
  const { store, snapshot, symbols } = await seed();
  const model = new FakeModel();
  await analyzeSnapshot({ store, snapshotId: snapshot.id, model });
  expect(model.calls).toBe(2);

  // Cambia el contenido de un símbolo → el pack cambia → re-análisis.
  store.db
    .prepare('UPDATE symbols SET signature = ? WHERE id = ? AND snapshot_id = ?')
    .run('(x: number): void', symbols[0]!.id, snapshot.id);

  const result = await analyzeSnapshot({ store, snapshotId: snapshot.id, model });
  expect(result.modulesAnalyzed).toBe(1);
  // El módulo se re-analiza, pero el dossier resultante es idéntico (fake),
  // así que el brief no se ve afectado y sale de caché: la cascada del plan.
  expect(model.calls).toBe(3);
  expect(result.briefCached).toBe(true);

  store.close();
});

test('el presupuesto recorta símbolos por fan-in y lo deja explícito', async () => {
  const { store, snapshot } = await seed(10);
  const [module] = store.listModules(snapshot.id);

  const pack = buildModuleEvidencePack(store, snapshot.id, module!, {
    maxSymbolsPerPack: 4,
    maxEdgesPerPack: 200,
  });

  expect(pack.symbols.length).toBe(4);
  expect(pack.truncation.droppedSymbols).toBe(6);
  // El símbolo con fan-in (PaymentService.process) sobrevive al recorte.
  expect(pack.symbols[0]?.qualifiedName).toBe('PaymentService.process');

  store.close();
});
