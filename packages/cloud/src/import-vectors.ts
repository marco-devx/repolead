import type { KnowledgeStore } from '@repolead/knowledge-store';
import type { QdrantSearcher } from '@repolead/retrieval';
import { symbolIdToPointId } from '@repolead/retrieval';
import { publicationInfo } from './publish';

/** One-time transfer of existing embeddings. Never calls an embedding or generative model. */
export async function importExistingVectors(name: string, store: KnowledgeStore, source: QdrantSearcher, target: QdrantSearcher) {
  if (!source.retrieve) { throw new Error('The source backend must support vector retrieval'); }
  const info = publicationInfo(name, store);
  const repository = store.getRepository(store.getSnapshot(info.snapshotId)!.repositoryId)!.name;
  const collection = String(info.metadata['collection']);
  const items = store.db.prepare('SELECT id,content_hash FROM knowledge_items WHERE snapshot_id=? ORDER BY id')
    .all(info.snapshotId) as { id: string; content_hash: string }[];
  let dimension = 0; let copied = 0;
  for (let offset = 0; offset < items.length; offset += 64) {
    const batch = items.slice(offset, offset + 64);
    const points = await source.retrieve(collection, batch.map((item) => symbolIdToPointId(item.id)));
    const byId = new Map(points.map((point) => [point.id, point]));
    for (const item of batch) {
      const point = byId.get(symbolIdToPointId(item.id));
      if (!point || point.payload['repository'] !== repository || point.payload['snapshot_id'] !== info.snapshotId
        || point.payload['embedding_hash'] !== item.content_hash || point.payload['embedding_model'] !== info.modelKey
        || point.payload['index_generation'] !== info.generation) { throw new Error(`${name}: vector provenance mismatch; the existing source index must be complete.`); }
      if (!dimension) { dimension = point.vector.length; await target.ensureCollection(collection, dimension); }
      if (point.vector.length !== dimension) { throw new Error('Vector dimensions changed during migration'); }
    }
    await target.upsert(collection, points); copied += points.length;
  }
  await target.prune?.(collection, repository, info.generation);
  return { repository: name, copied, dimensions: dimension, collection, modelKey: info.modelKey, modelCalls: 0 };
}
