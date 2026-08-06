import { expect, test } from '@rstest/core';

import type { CodeSymbol } from '@repolead/domain';
import { stableSymbolId } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

import type { EmbeddingsClient } from './embeddings';
import type { QdrantHit, QdrantPoint, QdrantSearcher } from './qdrant';
import { symbolIdToPointId } from './qdrant';
import type { RerankerClient } from './reranker';
import { indexSnapshot } from './indexer';
import { hybridSearch, symbolText } from './search';

/** Embedding determinístico de juguete: bolsa de caracteres en 26 dimensiones. */
class FakeEmbeddings implements EmbeddingsClient {
  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(
      texts.map((text) => {
        const vector = new Array<number>(26).fill(0);
        for (const char of text.toLowerCase()) {
          const code = char.charCodeAt(0) - 97;
          if (code >= 0 && code < 26) {
            vector[code] = (vector[code] ?? 0) + 1;
          }
        }
        return vector;
      }),
    );
  }
}

class FakeQdrant implements QdrantSearcher {
  private points: QdrantPoint[] = [];

  ensureCollection(): Promise<void> {
    return Promise.resolve();
  }

  upsert(_name: string, points: QdrantPoint[]): Promise<void> {
    this.points.push(...points);
    return Promise.resolve();
  }

  search(_name: string, vector: number[], snapshotId: string, limit: number): Promise<QdrantHit[]> {
    const cosine = (a: number[], b: number[]): number => {
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let index = 0; index < a.length; index += 1) {
        dot += (a[index] ?? 0) * (b[index] ?? 0);
        normA += (a[index] ?? 0) ** 2;
        normB += (b[index] ?? 0) ** 2;
      }
      return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
    };
    return Promise.resolve(
      this.points
        .filter((point) => point.payload['snapshot_id'] === snapshotId)
        .map((point) => ({ id: point.id, score: cosine(vector, point.vector), payload: point.payload }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit),
    );
  }
}

const keywordReranker: RerankerClient = {
  rerank: (query, documents) =>
    Promise.resolve(
      documents.map((document) => {
        const words = query.toLowerCase().split(/\s+/);
        return words.filter((word) => document.toLowerCase().includes(word)).length;
      }),
    ),
};

async function seed() {
  const store = await openStore(':memory:');
  const repository = store.upsertRepository({ name: 'demo', rootPath: '/demo' });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'abc' });
  const make = (qualifiedName: string, kind: CodeSymbol['kind'], path: string): CodeSymbol => ({
    id: stableSymbolId({ repository: 'demo', path, kind, qualifiedName }),
    repositoryId: repository.id,
    snapshotId: snapshot.id,
    path,
    qualifiedName,
    kind,
    signature: null,
    startLine: 1,
    endLine: 10,
    contentHash: 'h',
    source: 'tree-sitter',
  });
  const payment = make('PaymentService.process', 'method', 'src/payment/service.ts');
  const audit = make('AuditLogService', 'class', 'src/audit/log.ts');
  const mapper = make('mapInvoice', 'function', 'src/invoice/mapper.ts');
  store.insertSymbols([payment, audit, mapper]);
  store.insertEdges([
    {
      snapshotId: snapshot.id,
      sourceId: audit.id,
      targetId: payment.id,
      edgeType: 'CALLS',
      confidence: 0.9,
      analyzer: 'scip',
      evidence: null,
    },
  ]);
  return { store, snapshot, payment, audit, mapper };
}

test('symbolIdToPointId produce un UUID válido y determinístico', () => {
  const pointId = symbolIdToPointId('sym_0123456789abcdef0123456789abcdef');
  expect(pointId).toBe('01234567-89ab-cdef-0123-456789abcdef');
  expect(symbolIdToPointId('sym_0123456789abcdef0123456789abcdef')).toBe(pointId);
});

test('hybridSearch fusiona FTS + vector + grafo y el reranker reordena', async () => {
  const { store, snapshot, payment } = await seed();
  const embeddings = new FakeEmbeddings();
  const qdrant = new FakeQdrant();

  const indexed = await indexSnapshot({
    store,
    snapshotId: snapshot.id,
    repositoryName: 'demo',
    collection: 'repolead',
    embeddings,
    qdrant,
  });
  expect(indexed).toBe(3);

  const hits = await hybridSearch({
    store,
    snapshotId: snapshot.id,
    collection: 'repolead',
    query: 'payment process',
    embeddings,
    qdrant,
    reranker: keywordReranker,
  });

  expect(hits[0]?.symbol.id).toBe(payment.id);
  expect(hits[0]?.sources).toContain('fts');
  expect(hits[0]?.sources).toContain('rerank');

  store.close();
});

test('hybridSearch degrada con gracia sin servicios de vectores ni reranker', async () => {
  const { store, snapshot, audit } = await seed();

  const hits = await hybridSearch({
    store,
    snapshotId: snapshot.id,
    collection: 'repolead',
    query: 'audit log',
  });

  // audit no tiene edges entrantes (su edge es saliente): solo señal FTS.
  expect(hits[0]?.symbol.id).toBe(audit.id);
  expect(hits[0]?.sources).toEqual(['fts']);

  store.close();
});

test('symbolText incluye kind, nombre y path', async () => {
  const { store, payment } = await seed();
  expect(symbolText(payment)).toContain('method PaymentService.process');
  expect(symbolText(payment)).toContain('src/payment/service.ts');
  store.close();
});
