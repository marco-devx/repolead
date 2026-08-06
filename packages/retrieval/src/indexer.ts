import type { KnowledgeStore } from '@repolead/knowledge-store';

import type { EmbeddingsClient } from './embeddings';
import type { QdrantSearcher } from './qdrant';
import { symbolIdToPointId } from './qdrant';
import { symbolText } from './search';

export interface IndexSnapshotOptions {
  store: KnowledgeStore;
  snapshotId: string;
  repositoryName: string;
  collection: string;
  embeddings: EmbeddingsClient;
  qdrant: QdrantSearcher;
  /** Reindex selectivo: solo estos símbolos (refresh incremental). */
  symbolIds?: Set<string>;
}

/**
 * Vectoriza los símbolos de un snapshot en Qdrant. Qdrant nunca es fuente
 * de verdad: este índice se reconstruye completo desde SQLite cuando haga falta.
 */
export async function indexSnapshot(options: IndexSnapshotOptions): Promise<number> {
  const symbols = options.store
    .listSymbols(options.snapshotId)
    .filter((symbol) => !options.symbolIds || options.symbolIds.has(symbol.id));
  if (symbols.length === 0) {
    return 0;
  }

  const vectors = await options.embeddings.embed(symbols.map(symbolText));
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
    },
  }));

  const BATCH = 128;
  for (let index = 0; index < points.length; index += BATCH) {
    await options.qdrant.upsert(options.collection, points.slice(index, index + BATCH));
  }
  return points.length;
}
