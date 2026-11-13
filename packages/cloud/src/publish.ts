import type pg from 'pg';
import { contentHash } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import { productView } from '@repolead/mcp-server';
import { QdrantRestClient, symbolIdToPointId } from '@repolead/retrieval';
import type { QdrantSearcher } from '@repolead/retrieval';
import { pgVector } from './database';
import { MIRROR_TABLES } from './schema';

export interface PublicationInfo {
  id: string; repository: string; snapshotId: string; indexedAt: string;
  modelKey: string; generation: string; metadata: Record<string, unknown>;
}
export function publicationInfo(name: string, store: KnowledgeStore): PublicationInfo {
  const view = productView({ name, store });
  if (!view || view.snapshot.id !== store.getLatestSnapshot()?.id) { throw new Error(`${name}: finish the current analysis before publishing.`); }
  const index = JSON.parse(store.getSnapshotMetadata(view.snapshot.id, 'vector_index') ?? '{}') as {
    modelKey?: string; generation?: string; indexed?: number; omitted?: unknown[]; collection?: string;
  };
  if (!index.modelKey || !index.generation || index.omitted?.length
    || store.getSnapshotMetadata(view.snapshot.id, 'vector_refresh_pending') !== 'false') {
    throw new Error(`${name}: finish vector indexing before publishing. Existing analyses do not need regeneration.`);
  }
  const projection = store.getSnapshotMetadata(view.snapshot.id, 'knowledge_projection');
  return { id: `pub_${contentHash(JSON.stringify(['cloud-v1', name, view.snapshot.id, projection, index.generation]))}`,
    repository: name, snapshotId: view.snapshot.id, indexedAt: view.snapshot.createdAt, modelKey: index.modelKey,
    generation: index.generation, metadata: { analysis: JSON.parse(store.getSnapshotMetadata(view.snapshot.id, 'technical_analysis') ?? '{}'),
      collection: index.collection, vectorRepository: store.getRepository(view.snapshot.repositoryId)!.name,
      expectedItems: index.indexed, products: view.records.length, projection } };
}

export function mirrorRows(store: KnowledgeStore, info: PublicationInfo) {
  const snapshot = store.getSnapshot(info.snapshotId)!;
  const groups: { table: string; rows: Record<string, unknown>[] }[] = [];
  for (const table of MIRROR_TABLES) {
    let where = 'snapshot_id = ?'; let param = info.snapshotId;
    if (table === 'repositories') { where = 'id = ?'; param = snapshot.repositoryId; }
    else if (table === 'snapshots') { where = 'id = ?'; }
    else if (table === 'source_blobs') { where = 'content_hash IN (SELECT content_hash FROM file_sources WHERE snapshot_id = ?)'; }
    else if (table === 'summary_evidence') { where = 'summary_id IN (SELECT id FROM summaries WHERE snapshot_id = ?)'; }
    else if (table === 'evidence_records') { where = 'id IN (SELECT evidence_id FROM summary_evidence WHERE summary_id IN (SELECT id FROM summaries WHERE snapshot_id = ?))'; }
    // Table names are constants; no tool/user-supplied SQL identifiers.
    const rows = store.db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`).all(param) as Record<string, unknown>[];
    groups.push({ table, rows: rows.map(({ snapshot_id: _snapshotId, ...row }) => row) });
  }
  return groups;
}

/** Incremental native-PG publication: immutable content-addressed rows and reusable exact vectors. */
export async function publishRepository(pool: pg.Pool, name: string, store: KnowledgeStore, options: {
  qdrant?: QdrantSearcher; qdrantUrl?: string; onProgress?: (message: string) => void;
} = {}) {
  const info = publicationInfo(name, store);
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('repolead-publish:' || $1))", [name]); locked = true;
    const current = await client.query('SELECT active_publication FROM repolead_repositories WHERE name=$1', [name]);
    if (current.rows[0]?.active_publication === info.id) { return { repository: name, publication: info.id, unchanged: true, uploadedVectors: 0, uploadedBlobs: 0 }; }
    const qdrant = options.qdrant ?? new QdrantRestClient(options.qdrantUrl ?? process.env['REPOLEAD_QDRANT_URL'] ?? 'http://127.0.0.1:6333');
    if (!qdrant.retrieve) { throw new Error('Qdrant vector retrieval is required for migration without re-embedding.'); }
    const view = productView({ name, store })!;
    const items = store.db.prepare('SELECT * FROM knowledge_items WHERE snapshot_id=? ORDER BY id').all(info.snapshotId) as {
      id: string; subject_id: string; entity_kind: string; kind: string; content_hash: string; text: string;
    }[];
    if (!items.length || items.length !== info.metadata['expectedItems']) { throw new Error(`${name}: indexed knowledge and vector counts disagree; reindex first.`); }
    // A first matching vector also proves that the existing collection/model is available.
    const existingModel = await client.query('SELECT dimensions FROM repolead_vectors WHERE model_key=$1 LIMIT 1', [info.modelKey]);
    const initial = existingModel.rowCount ? null : (await qdrant.retrieve(String(info.metadata['collection']), [symbolIdToPointId(items[0]!.id)]))[0];
    if (!existingModel.rowCount && !initial) { throw new Error(`${name}: existing vectors are unavailable; start local Qdrant before publishing.`); }
    const dimensions = existingModel.rows[0]?.dimensions as number ?? initial!.vector.length;
    if (!dimensions || dimensions > 4000) { throw new Error('Cloud half-precision ANN indexing supports 1–4000 dimensions; no vectors were truncated.'); }
    await client.query(`INSERT INTO repolead_publications(id,repository,snapshot_id,indexed_at,model_key,dimensions,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
    [info.id, name, info.snapshotId, info.indexedAt, info.modelKey, dimensions, info.metadata]);
    let uploadedBlobs = 0; let uploadedVectors = 0;
    const putBlobs = async (payloads: Record<string, unknown>[]) => {
      const blobs = payloads.map((payload) => ({ hash: contentHash(JSON.stringify(payload)), payload }));
      if (!blobs.length) { return blobs; }
      const existing = await client.query('SELECT hash FROM repolead_blobs WHERE hash=ANY($1::text[])', [blobs.map((blob) => blob.hash)]);
      const known = new Set(existing.rows.map((row) => row.hash as string));
      const missing = blobs.filter((blob) => !known.has(blob.hash));
      if (missing.length) {
        const inserted = await client.query(`INSERT INTO repolead_blobs(hash,payload)
          SELECT hash,payload FROM jsonb_to_recordset($1::jsonb) AS x(hash text,payload jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(missing)]);
        uploadedBlobs += inserted.rowCount ?? 0;
      }
      return blobs;
    };
    for (const group of mirrorRows(store, info)) {
      for (let offset = 0; offset < group.rows.length; offset += 128) {
        const blobs = await putBlobs(group.rows.slice(offset, offset + 128));
        await client.query(`INSERT INTO repolead_rows(publication_id,table_name,ordinal,blob_hash)
          SELECT $1,$2,ordinal,hash FROM jsonb_to_recordset($3::jsonb) AS x(ordinal integer,hash text)
          ON CONFLICT(publication_id,table_name,ordinal) DO UPDATE SET blob_hash=excluded.blob_hash`,
        [info.id, group.table, JSON.stringify(blobs.map((blob, index) => ({ ordinal: offset + index, hash: blob.hash })))]);
      }
    }
    for (let offset = 0; offset < items.length; offset += 64) {
      const batch = items.slice(offset, offset + 64);
      const knownRows = await client.query('SELECT content_hash FROM repolead_vectors WHERE model_key=$1 AND content_hash=ANY($2::text[])', [info.modelKey, batch.map((item) => item.content_hash)]);
      const known = new Set(knownRows.rows.map((row) => row.content_hash as string));
      const missing = batch.filter((item) => !known.has(item.content_hash));
      const points = missing.length ? await qdrant.retrieve(String(info.metadata['collection']), missing.map((item) => symbolIdToPointId(item.id))) : [];
      const byId = new Map(points.map((point) => [point.id, point]));
      for (const item of missing) {
        const point = byId.get(symbolIdToPointId(item.id));
        if (!point || point.vector.length !== dimensions || point.payload['embedding_hash'] !== item.content_hash
          || point.payload['embedding_model'] !== info.modelKey || point.payload['snapshot_id'] !== info.snapshotId
          || point.payload['repository'] !== info.metadata['vectorRepository'] || point.payload['index_generation'] !== info.generation) {
          throw new Error(`${name}: vector provenance mismatch; finish local reindex before publishing.`);
        }
        const inserted = await client.query('INSERT INTO repolead_vectors(model_key,content_hash,dimensions,embedding) VALUES($1,$2,$3,$4::vector) ON CONFLICT DO NOTHING',
          [info.modelKey, item.content_hash, dimensions, pgVector(point.vector)]);
        uploadedVectors += inserted.rowCount ?? 0;
      }
      const blobs = await putBlobs(batch.map((item) => {
        const { snapshot_id: _snapshot, ...stable } = item as unknown as Record<string, unknown>; return stable;
      }));
      await client.query(`INSERT INTO repolead_items(publication_id,id,subject_id,entity_kind,content_hash,blob_hash)
        SELECT $1,id,subject_id,entity_kind,content_hash,blob_hash FROM jsonb_to_recordset($2::jsonb)
        AS x(id text,subject_id text,entity_kind text,content_hash text,blob_hash text) ON CONFLICT(publication_id,id) DO NOTHING`,
      [info.id, JSON.stringify(batch.map((item, index) => ({ ...item, text: undefined, blob_hash: blobs[index]!.hash })))]);
      options.onProgress?.(`${name}: ${Math.min(offset + 64, items.length)}/${items.length} vectores disponibles en PG`);
    }
    for (const record of view.records) {
      const subject = [...view.subjects].find((entry) => entry[1] === record.ref)?.[0];
      const item = items.find((entry) => entry.entity_kind === 'summary' && entry.kind === 'file' && entry.subject_id === subject);
      await client.query(`INSERT INTO repolead_products(publication_id,ref,content_hash,record,search_document)
        VALUES($1,$2,$3,$4,to_tsvector('simple',$5)) ON CONFLICT(publication_id,ref) DO NOTHING`,
      [info.id, record.ref, item?.content_hash ?? null, record, JSON.stringify(record)]);
    }
    const count = await client.query(`SELECT count(*)::int AS n FROM repolead_items i JOIN repolead_vectors v
      ON v.model_key=$2 AND v.content_hash=i.content_hash WHERE i.publication_id=$1`, [info.id, info.modelKey]);
    if (publicationInfo(name, store).id !== info.id || count.rows[0]?.n !== items.length || store.getLatestSnapshot()?.id !== info.snapshotId
      || store.getSnapshotMetadata(info.snapshotId, 'knowledge_projection') !== info.metadata['projection']) { throw new Error('Publication changed or some vectors are missing; the previous active context was retained.'); }
    // Original float32 values remain stored; the ANN index uses halfvec to support 2560 dimensions.
    if (!/^[a-f0-9]{64}$/.test(info.modelKey)) { throw new Error('Embedding identity must be a SHA-256 hash.'); }
    const indexName = `repolead_ann_${info.modelKey.slice(0, 16)}`;
    await client.query("SET statement_timeout='15min'");
    await client.query(`CREATE INDEX IF NOT EXISTS ${indexName} ON repolead_vectors USING hnsw
      ((embedding::halfvec(${dimensions})) halfvec_cosine_ops) WHERE model_key='${info.modelKey}'`);
    await client.query("SET statement_timeout='60s'");
    await client.query('BEGIN');
    await client.query("UPDATE repolead_publications SET state='ready' WHERE id=$1", [info.id]);
    await client.query(`INSERT INTO repolead_repositories(name,active_publication) VALUES($1,$2)
      ON CONFLICT(name) DO UPDATE SET active_publication=excluded.active_publication,updated_at=now()`, [name, info.id]);
    await client.query('COMMIT');
    return { repository: name, publication: info.id, unchanged: false, uploadedVectors, uploadedBlobs, dimensions, products: view.records.length };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { if (locked) { await client.query("SELECT pg_advisory_unlock(hashtext('repolead-publish:' || $1))", [name]).catch(() => {}); } client.release(); }
}
