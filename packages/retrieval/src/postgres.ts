import pg from 'pg';
import { readFileSync } from 'node:fs';
import type { QdrantPoint, QdrantSearcher, VectorFilters } from './qdrant';

export function createPgPool(connectionString: string, options: { max?: number; tls?: 'disable' | 'verify-full'; caFile?: string } = {}): pg.Pool {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) { throw new Error('Expected a PostgreSQL URL.'); }
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) { url.searchParams.delete(key); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return new pg.Pool({ connectionString: url.toString(), max: options.max ?? 5,
    allowExitOnIdle: true,
    connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 60000,
    ssl: (options.tls ?? (local ? 'disable' : 'verify-full')) === 'disable' ? false
      : { rejectUnauthorized: true, ...(options.caFile ? { ca: readFileSync(options.caFile, 'utf8') } : {}) } });
}

export function vectorLiteral(vector: number[]): string {
  if (!vector.length || vector.length > 16000 || vector.some((value) => !Number.isFinite(value))) { throw new Error('Invalid embedding vector.'); }
  return `[${vector.join(',')}]`;
}

export const PG_VECTOR_SCHEMA = `CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS repolead_vectors (
  model_key text NOT NULL, content_hash text NOT NULL, dimensions integer NOT NULL,
  embedding vector NOT NULL, PRIMARY KEY(model_key,content_hash), CHECK(vector_dims(embedding)=dimensions)
);
CREATE TABLE IF NOT EXISTS repolead_vector_collections(name text PRIMARY KEY,dimensions integer NOT NULL);
CREATE TABLE IF NOT EXISTS repolead_vector_points (
  collection text NOT NULL REFERENCES repolead_vector_collections(name), id text NOT NULL,
  model_key text NOT NULL, content_hash text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(collection,id), FOREIGN KEY(model_key,content_hash) REFERENCES repolead_vectors(model_key,content_hash)
);
CREATE INDEX IF NOT EXISTS repolead_point_scope ON repolead_vector_points(collection,(payload->>'repository'),(payload->>'snapshot_id'));
`;

/** Drop-in vector backend for the local indexer/retriever, using native pgvector rather than Qdrant. */
export class PgVectorStore implements QdrantSearcher {
  constructor(readonly pool: pg.Pool) {}
  async migrate() { await this.pool.query(PG_VECTOR_SCHEMA); }
  async ensureCollection(name: string, dimension: number) {
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > 16000) { throw new Error('Invalid vector dimensions'); }
    await this.pool.query('INSERT INTO repolead_vector_collections(name,dimensions) VALUES($1,$2) ON CONFLICT DO NOTHING', [name, dimension]);
    const existing = await this.pool.query('SELECT dimensions FROM repolead_vector_collections WHERE name=$1', [name]);
    if (existing.rows[0]?.dimensions !== dimension) { throw new Error('Embedding dimensions differ from the PostgreSQL collection'); }
  }
  async upsert(name: string, points: QdrantPoint[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const collection = (await client.query('SELECT dimensions FROM repolead_vector_collections WHERE name=$1', [name])).rows[0];
      if (!collection) { throw new Error('Create the vector collection first'); }
      for (const point of points) {
        const model = point.payload['embedding_model']; const hash = point.payload['embedding_hash'];
        if (typeof model !== 'string' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(model)
          || !/^[a-f0-9]{64}$/.test(hash) || point.vector.length !== collection.dimensions) { throw new Error('Vector provenance or dimensions invalid'); }
        await client.query('INSERT INTO repolead_vectors(model_key,content_hash,dimensions,embedding) VALUES($1,$2,$3,$4::vector) ON CONFLICT DO NOTHING', [model, hash, collection.dimensions, vectorLiteral(point.vector)]);
        await client.query(`INSERT INTO repolead_vector_points(collection,id,model_key,content_hash,payload) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(collection,id) DO UPDATE SET model_key=excluded.model_key,content_hash=excluded.content_hash,payload=excluded.payload`, [name, point.id, model, hash, point.payload]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async retrieve(name: string, ids: string[]): Promise<QdrantPoint[]> {
    const rows = await this.pool.query(`SELECT p.id,p.payload,v.embedding::text AS embedding FROM repolead_vector_points p JOIN repolead_vectors v
      ON v.model_key=p.model_key AND v.content_hash=p.content_hash WHERE p.collection=$1 AND p.id=ANY($2::text[])`, [name, ids]);
    return rows.rows.map((row) => ({ id: row.id as string, payload: row.payload as Record<string, unknown>, vector: JSON.parse(row.embedding as string) as number[] }));
  }
  async updatePayloads(name: string, updates: { ids: string[]; payload: Record<string, unknown> }[]) {
    for (const update of updates) {
      if ('embedding_model' in update.payload || 'embedding_hash' in update.payload) { throw new Error('Metadata updates cannot replace vector identity'); }
      await this.pool.query('UPDATE repolead_vector_points SET payload=payload || $3::jsonb WHERE collection=$1 AND id=ANY($2::text[])', [name, update.ids, JSON.stringify(update.payload)]);
    }
  }
  async prune(name: string, repository: string, generation: string) {
    await this.pool.query("DELETE FROM repolead_vector_points WHERE collection=$1 AND payload->>'repository'=$2 AND payload->>'index_generation' IS DISTINCT FROM $3", [name, repository, generation]);
  }
  async search(name: string, vector: number[], snapshotId: string, limit: number, filters: VectorFilters = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) { throw new Error('Invalid search limit'); }
    const parameters: unknown[] = [name, snapshotId, vectorLiteral(vector), limit];
    const conditions = ['p.collection=$1', "p.payload->>'snapshot_id'=$2", 'v.dimensions=vector_dims($3::vector)'];
    for (const [key, value] of Object.entries({ repository: filters.repository, language: filters.language, kind: filters.kind, embedding_model: filters.embeddingModel })) {
      if (value) { parameters.push(value); conditions.push(`p.payload->>'${key}'=$${parameters.length}`); }
    }
    if (filters.entityKinds?.length) { parameters.push(filters.entityKinds); conditions.push(`p.payload->>'entity_kind'=ANY($${parameters.length}::text[])`); }
    if (filters.module) { parameters.push(filters.module); conditions.push(`(p.payload->>'module'=$${parameters.length} OR p.payload->>'module_path'=$${parameters.length})`); }
    const rows = await this.pool.query(`SELECT p.id,p.payload,1-(v.embedding <=> $3::vector) AS score
      FROM repolead_vector_points p JOIN repolead_vectors v ON v.model_key=p.model_key AND v.content_hash=p.content_hash
      WHERE ${conditions.join(' AND ')} ORDER BY v.embedding <=> $3::vector LIMIT $4`, parameters);
    return rows.rows.map((row) => ({ id: row.id as string, score: Number(row.score), payload: row.payload as Record<string, unknown> }));
  }
}
