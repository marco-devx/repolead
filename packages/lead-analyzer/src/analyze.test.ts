import { expect, test } from '@rstest/core';

import type { CodeSymbol } from '@repolead/domain';
import { fileUri, moduleUri, stableSymbolId } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { countTokens } from '@repolead/retrieval';

import { analyzeSnapshot } from './analyze';
import { buildModuleEvidencePack, buildRepositoryEvidencePack } from './evidence';
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

test('invalida la caché si cambia el cuerpo de un símbolo omitido por presupuesto', async () => {
  const { store, snapshot, symbols } = await seed(30);
  const model = new FakeModel();
  const budget = { maxTokens: 1000, maxSymbolsPerPack: 2 };
  await analyzeSnapshot({ store, snapshotId: snapshot.id, model, budget });
  store.db.prepare('UPDATE symbols SET content_hash = ? WHERE id = ? AND snapshot_id = ?')
    .run('new-body-identical-signature', symbols[29]!.id, snapshot.id);
  const result = await analyzeSnapshot({ store, snapshotId: snapshot.id, model, budget });
  expect(result.modulesAnalyzed).toBe(1);
  const unchanged = await analyzeSnapshot({ store, snapshotId: snapshot.id, model, budget });
  expect(unchanged.modulesCached).toBe(1);
  expect(unchanged.inputTokens).toBe(0);
  store.close();
});

test('respeta tokens y cuenta relaciones perdidas al omitir símbolos', async () => {
  const { store, snapshot } = await seed(40);
  const module = store.listModules(snapshot.id)[0]!;
  const pack = buildModuleEvidencePack(store, snapshot.id, module, { maxTokens: 600, maxSymbolsPerPack: 1 });
  expect(countTokens(JSON.stringify(pack))).toBeLessThanOrEqual(600);
  expect(pack.truncation.droppedSymbols).toBe(39);
  expect(pack.truncation.droppedEdges).toBe(1);
  store.close();
});

test('el módulo raíz no vuelve a analizar símbolos de los submódulos', async () => {
  const { store, repository, snapshot } = await seed();
  const root = { id: moduleUri(REPO, 'root'), repositoryId: repository.id, snapshotId: snapshot.id, name: 'root', path: '.' };
  store.insertModules([root]);
  const pack = buildModuleEvidencePack(store, snapshot.id, root);
  expect(pack.symbols).toEqual([]);
  expect(pack.files).toEqual([]);
  store.close();
});

test('el resumen global limita tokens y reparte el presupuesto entre módulos', () => {
  const dossiers = Array.from({ length: 10 }, (_, index) => ({
    module: 'module-' + index,
    dossier: { responsibility: 'small purpose', publicApi: Array.from({ length: 1000 }, (_, n) => 'function' + n) },
  }));
  const pack = buildRepositoryEvidencePack('demo', { modules: 10 }, dossiers, 1000);
  expect(countTokens(JSON.stringify(pack))).toBeLessThanOrEqual(1000);
  expect(pack.modules).toHaveLength(10);
  expect(pack.modules.every((module) => module.dossier['responsibility'] === 'small purpose')).toBe(true);
  expect(pack.truncation.omittedSections).toBe(10);
});
