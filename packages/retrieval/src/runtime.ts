import type { KnowledgeStore } from '@repolead/knowledge-store';
import { TeiEmbeddingsClient } from './embeddings';
import type { EmbeddingsClient } from './embeddings';
import { QdrantRestClient } from './qdrant';
import { TeiRerankerClient } from './reranker';

/** A new embedding space must never overwrite vectors from different weights/dimensions. */
export async function defaultEmbeddingCollection(embeddings: EmbeddingsClient): Promise<string> {
  const identity = await embeddings.cacheKey?.();
  if (!identity) { throw new Error('Cannot identify embedding weights; specify --collection explicitly for reindex.'); }
  return `repolead-${identity.slice(0, 24)}`;
}

export function indexedCollection(store: KnowledgeStore, snapshotId: string): string {
  try {
    const value = JSON.parse(store.getSnapshotMetadata(snapshotId, 'vector_index') ?? '{}') as { collection?: unknown };
    return typeof value.collection === 'string' && value.collection.length > 0 && value.collection.length <= 256 ? value.collection : 'repolead-symbols';
  } catch { return 'repolead-symbols'; }
}

/** Optional local services: unavailable services remain explicit null fallbacks. */
export async function retrievalServices() {
  const tei = process.env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8080';
  const qdrant = process.env['REPOLEAD_QDRANT_URL'] ?? 'http://localhost:6333';
  const reranker = process.env['REPOLEAD_RERANKER_URL'] ?? 'http://localhost:8081';
  const reachable = async (url: string) => {
    try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  };
  const [teiUp, qdrantUp, rerankerUp] = await Promise.all([reachable(`${tei}/health`), reachable(`${qdrant}/healthz`), reachable(`${reranker}/health`)]);
  return { embeddings: teiUp ? new TeiEmbeddingsClient(tei) : null, qdrant: qdrantUp ? new QdrantRestClient(qdrant) : null,
    reranker: rerankerUp ? new TeiRerankerClient(reranker) : null };
}
