import { contentHash } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';

import type { EmbeddingsClient } from './embeddings';
import type { QdrantPoint, QdrantSearcher } from './qdrant';
import { symbolIdToPointId } from './qdrant';
import { symbolText } from './search';

export interface IndexSnapshotOptions {
  store: KnowledgeStore;
  snapshotId: string;
  repositoryName: string;
  collection: string;
  embeddings: EmbeddingsClient;
  qdrant: QdrantSearcher;
  /** Compatibility hint. All live points receive the new snapshot; embeddings are cached by input. */
  symbolIds?: Set<string>;
  onProgress?: (counts: { embedded: number; reused: number }) => void;
}

/**
 * Vectoriza los símbolos de un snapshot en Qdrant. Qdrant nunca es fuente
 * de verdad: este índice se reconstruye completo desde SQLite cuando haga falta.
 */
export async function indexSnapshot(options: IndexSnapshotOptions): Promise<number> {
  const symbols = options.store.listSymbols(options.snapshotId);
  if (symbols.length === 0) {
    return 0;
  }

  const modelKey = await options.embeddings.cacheKey?.() ?? null;
  const texts = symbols.map(symbolText);
  const hashes = texts.map(contentHash);
  const cached = new Map<string, QdrantPoint>();
  if (modelKey && options.qdrant.retrieve) {
    try {
      for (let index = 0; index < symbols.length; index += 128) {
        const points = await options.qdrant.retrieve(options.collection, symbols.slice(index, index + 128).map((symbol) => symbolIdToPointId(symbol.id)));
        for (const point of points) {
          cached.set(point.id, point);
        }
      }
    } catch {
      // Missing collection, interrupted previous index, or unavailable cache: rebuild from SQLite.
      cached.clear();
    }
  }
  const vectors: number[][] = [];
  const missing: number[] = [];
  symbols.forEach((symbol, index) => {
    const old = cached.get(symbolIdToPointId(symbol.id));
    if (modelKey && old?.payload['embedding_model'] === modelKey && old.payload['embedding_hash'] === hashes[index]) {
      vectors[index] = old.vector;
    } else {
      missing.push(index);
    }
  });
  if (missing.length > 0) {
    const generated = await options.embeddings.embed(missing.map((index) => texts[index]!));
    if (generated.length !== missing.length || generated.some((vector) => vector.length === 0)) {
      throw new Error('El servicio devolvió un número incorrecto de embeddings.');
    }
    missing.forEach((index, offset) => { vectors[index] = generated[offset]!; });
  }
  const dimension = vectors[0]?.length ?? 0;
  if (dimension === 0) {
    return 0;
  }

  await options.qdrant.ensureCollection(options.collection, dimension);
  const points = symbols.map((symbol, index) => ({
    id: symbolIdToPointId(symbol.id),
    vector: vectors[index] ?? [],
    payload: {
      symbol_id: symbol.id,
      snapshot_id: symbol.snapshotId,
      repository: options.repositoryName,
      path: symbol.path,
      kind: symbol.kind,
      qualified_name: symbol.qualifiedName,
      embedding_hash: hashes[index],
      embedding_model: modelKey,
    },
  }));

  const BATCH = 128;
  for (let index = 0; index < points.length; index += BATCH) {
    await options.qdrant.upsert(options.collection, points.slice(index, index + BATCH));
  }
  options.onProgress?.({ embedded: missing.length, reused: symbols.length - missing.length });
  return points.length;
}
