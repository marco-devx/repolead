import { randomUUID } from 'node:crypto';

import { contentHash } from '@repolead/domain';
import type { KnowledgeItem } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';

import type { EmbeddingsClient } from './embeddings';
import { EmbeddingInputError } from './embeddings';
import type { QdrantPoint, QdrantSearcher } from './qdrant';
import { QdrantRequestError, symbolIdToPointId } from './qdrant';

export interface IndexProgress {
  embedded: number;
  reused: number;
  metadataUpdated: number;
  incompleteSources: number;
  omitted: { itemId: string; reason: string }[];
}

export interface IndexSnapshotOptions {
  store: KnowledgeStore;
  snapshotId: string;
  repositoryName: string;
  collection: string;
  embeddings: EmbeddingsClient;
  qdrant: QdrantSearcher;
  /** Compatibility hint: hashes remain authoritative, including non-symbol knowledge. */
  symbolIds?: Set<string>;
  onProgress?: (counts: IndexProgress) => void;
}

function payloadFor(item: KnowledgeItem, repository: string, model: string | null, generation: string): Record<string, unknown> {
  return { item_id: item.id, subject_id: item.subjectId, symbol_id: item.entityKind === 'symbol' ? item.subjectId : null,
    snapshot_id: item.snapshotId, repository, repository_id: item.repositoryId, path: item.path,
    entity_kind: item.entityKind, kind: item.kind, language: item.language, module: item.module, module_path: item.modulePath,
    qualified_name: item.title, embedding_hash: item.contentHash, embedding_model: model,
    source_complete: item.sourceComplete, index_generation: generation };
}

/** SQLite rebuilds all searchable knowledge; only changed inputs generate/upload vectors. */
export async function indexSnapshot(options: IndexSnapshotOptions): Promise<number> {
  const { store, snapshotId, collection, qdrant, embeddings } = options;
  const snapshot = store.getSnapshot(snapshotId);
  const repository = snapshot ? store.getRepository(snapshot.repositoryId) : null;
  if (!repository || repository.name !== options.repositoryName) { throw new Error('Vector repository scope does not match the SQLite snapshot.'); }
  if (store.getLatestSnapshot()?.id !== snapshotId) { throw new Error('Only the latest snapshot can replace a repository vector index.'); }
  const owner = `index_${randomUUID()}`;
  const ttl = 300000;
  let projection: string | null = null;
  store.db.transaction(() => {
    const lease = store.db.prepare('SELECT owner, expires_at FROM vector_index_leases WHERE collection = ?').get(collection) as { owner: string; expires_at: number } | undefined;
    if (lease && lease.expires_at > Date.now()) { throw new Error('Another vector indexing process holds this database/collection lease.'); }
    store.db.prepare('INSERT OR REPLACE INTO vector_index_leases (collection, owner, expires_at) VALUES (?, ?, ?)').run(collection, owner, Date.now() + ttl);
  })();
  const renew = () => {
    const lease = store.db.prepare('SELECT owner FROM vector_index_leases WHERE collection = ?').get(collection) as { owner: string } | undefined;
    if (lease?.owner !== owner) { throw new Error('Vector indexing lease expired or changed; no further writes are allowed.'); }
    if (store.getLatestSnapshot()?.id !== snapshotId) { throw new Error('A newer snapshot appeared during indexing; reindex the latest snapshot.'); }
    if (projection !== null && store.getSnapshotMetadata(snapshotId, 'knowledge_projection') !== projection) {
      throw new Error('Search knowledge changed during embedding; retry reindex after analysis finishes.');
    }
    store.db.prepare('UPDATE vector_index_leases SET expires_at = ? WHERE collection = ? AND owner = ?').run(Date.now() + ttl, collection, owner);
  };
  try {
    const items = store.rebuildSearchIndex(snapshotId);
    projection = store.getSnapshotMetadata(snapshotId, 'knowledge_projection');
    const modelKey = items.length ? await embeddings.cacheKey?.() ?? null : null;
    const generation = contentHash(JSON.stringify({ snapshotId, model: modelKey,
      items: items.map((item) => [item.id, item.subjectId, item.contentHash, item.language, item.module, item.modulePath]) }));
    const result: IndexProgress = { embedded: 0, reused: 0, metadataUpdated: 0,
      incompleteSources: items.filter((item) => item.entityKind === 'symbol' && !item.sourceComplete).length, omitted: [] };
    const cached = new Map<string, QdrantPoint>();
    if (items.length && modelKey && qdrant.retrieve) {
      try {
        for (let index = 0; index < items.length; index += 128) {
          renew();
          for (const point of await qdrant.retrieve(collection, items.slice(index, index + 128).map((item) => symbolIdToPointId(item.id)))) {
            cached.set(point.id, point);
          }
        }
      } catch (error) {
        if (!(error instanceof QdrantRequestError) || error.status !== 404) { throw error; }
        cached.clear();
      }
    }
    const vectors = new Map<string, number[]>();
    const reusedIds = new Set<string>();
    const missing: KnowledgeItem[] = [];
    for (const item of items) {
      const old = cached.get(symbolIdToPointId(item.id));
      if (modelKey && old?.payload['embedding_model'] === modelKey && old.payload['embedding_hash'] === item.contentHash
        && old.vector.length && old.vector.every(Number.isFinite)) {
        vectors.set(item.id, old.vector);
        reusedIds.add(item.id);
        result.reused += 1;
      } else { missing.push(item); }
    }
    const embed = async (batch: KnowledgeItem[]): Promise<void> => {
      renew();
      const generated = await embeddings.embed(batch.map((item) => item.text));
      if (generated.length !== batch.length || generated.some((vector) => !vector.length || !vector.every(Number.isFinite))) {
        throw new Error('Embedding service returned invalid vectors.');
      }
      batch.forEach((item, index) => vectors.set(item.id, generated[index]!));
      result.embedded += batch.length;
    };
    for (let index = 0; index < missing.length; index += 32) {
      const batch = missing.slice(index, index + 32);
      try { await embed(batch); }
      catch (error) {
        if (!(error instanceof EmbeddingInputError)) { throw error; }
        // Isolate rejected inputs without shortening code or discarding the rest of a batch.
        for (const item of batch) {
          try { await embed([item]); }
          catch (individual) {
            if (!(individual instanceof EmbeddingInputError)) { throw individual; }
            result.omitted.push({ itemId: item.id, reason: individual.message });
          }
        }
      }
    }
    renew();
    const dimension = [...vectors.values()][0]?.length;
    if (dimension !== undefined) {
      if ([...vectors.values()].some((vector) => vector.length !== dimension)) { throw new Error('Embedding dimensions changed during indexing.'); }
      await qdrant.ensureCollection(collection, dimension);
      const changed: QdrantPoint[] = [];
      const updates = new Map<string, { ids: string[]; payload: Record<string, unknown> }>();
      for (const item of items) {
        const vector = vectors.get(item.id);
        if (!vector) { continue; }
        const id = symbolIdToPointId(item.id);
        const payload = payloadFor(item, repository.name, modelKey, generation);
        const old = cached.get(id);
        if (reusedIds.has(item.id) && old && qdrant.updatePayloads) {
          const delta = Object.fromEntries(Object.entries(payload).filter(([key, value]) => JSON.stringify(old.payload[key]) !== JSON.stringify(value)));
          if (Object.keys(delta).length) {
            const key = JSON.stringify(delta);
            const group = updates.get(key) ?? { ids: [], payload: delta };
            group.ids.push(id);
            updates.set(key, group);
            result.metadataUpdated += 1;
          }
        } else { changed.push({ id, vector, payload }); }
      }
      for (let index = 0; index < changed.length; index += 128) { renew(); await qdrant.upsert(collection, changed.slice(index, index + 128)); }
      const groups = [...updates.values()].flatMap((entry) => {
        const batches: typeof entry[] = [];
        for (let index = 0; index < entry.ids.length; index += 128) { batches.push({ ids: entry.ids.slice(index, index + 128), payload: entry.payload }); }
        return batches;
      });
      for (let index = 0; index < groups.length; index += 128) { renew(); await qdrant.updatePayloads!(collection, groups.slice(index, index + 128)); }
    }
    renew();
    if (qdrant.prune) { await qdrant.prune(collection, repository.name, generation); }
    store.setSnapshotMetadata(snapshotId, 'vector_index', JSON.stringify({ collection, generation, modelKey, indexed: vectors.size, ...result }));
    store.setSnapshotMetadata(snapshotId, 'vector_refresh_pending', result.omitted.length ? 'true' : 'false');
    options.onProgress?.(result);
    return vectors.size;
  } finally {
    store.db.prepare('DELETE FROM vector_index_leases WHERE collection = ? AND owner = ?').run(collection, owner);
  }
}
