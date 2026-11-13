import type { KnowledgeStore } from '@repolead/knowledge-store';
import { TeiEmbeddingsClient } from './embeddings';
import type { EmbeddingsClient } from './embeddings';
import { QdrantRestClient } from './qdrant';
import { TeiRerankerClient } from './reranker';
import { createPgPool, PgVectorStore } from './postgres';
import type { QdrantSearcher } from './qdrant';

const pgStores = new Map<string, PgVectorStore>();
export async function vectorBackend(options: { backend?: string; required?: boolean; migrate?: boolean } = {}): Promise<QdrantSearcher | null> {
  const backend = options.backend ?? process.env['REPOLEAD_VECTOR_BACKEND'] ?? 'qdrant';
  if (!['qdrant', 'pgvector'].includes(backend)) { throw new Error('REPOLEAD_VECTOR_BACKEND must be qdrant or pgvector.'); }
  try {
    if (backend === 'pgvector') {
      const url = process.env['REPOLEAD_PG_LOCAL_URL'];
      if (!url) { throw new Error('Missing local PostgreSQL URL'); }
      let store = pgStores.get(url);
      if (!store) {
        const tls = process.env['REPOLEAD_LOCAL_PG_TLS'];
        if (tls && !['disable', 'verify-full'].includes(tls)) { throw new Error('Invalid local PostgreSQL TLS policy'); }
        store = new PgVectorStore(createPgPool(url, { max: 4, tls: tls as 'disable' | 'verify-full' | undefined })); pgStores.set(url, store);
      }
      await store.pool.query('SELECT 1');
      if (options.migrate) { await store.migrate(); }
      return store;
    }
    const url = process.env['REPOLEAD_QDRANT_URL'] ?? 'http://localhost:6333';
    if (!(await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1500) })).ok) { throw new Error('Qdrant unavailable'); }
    return new QdrantRestClient(url);
  } catch {
    if (options.required) { throw new Error(`Vector backend ${backend} unavailable; check its connection and schema configuration.`); }
    return null;
  }
}

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
  const tei = process.env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8082';
  const reranker = process.env['REPOLEAD_RERANKER_URL'] ?? 'http://localhost:8081';
  const reachable = async (url: string) => {
    try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  };
  const [teiUp, vectors, rerankerUp] = await Promise.all([reachable(`${tei}/health`), vectorBackend(), reachable(`${reranker}/health`)]);
  return { embeddings: teiUp ? new TeiEmbeddingsClient(tei) : null, qdrant: vectors,
    reranker: rerankerUp ? new TeiRerankerClient(reranker) : null };
}
