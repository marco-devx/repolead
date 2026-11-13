/** The remote database owns published read models, vectors, ACL and durable work queues. */
export const CLOUD_SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS repolead_publications (
  id text PRIMARY KEY, repository text NOT NULL, snapshot_id text NOT NULL,
  indexed_at timestamptz NOT NULL, model_key text NOT NULL, dimensions integer NOT NULL,
  metadata jsonb NOT NULL, state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS repolead_repositories (
  name text PRIMARY KEY, active_publication text NOT NULL REFERENCES repolead_publications(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS repolead_blobs (hash text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS repolead_rows (
  publication_id text NOT NULL REFERENCES repolead_publications(id) ON DELETE CASCADE,
  table_name text NOT NULL, ordinal integer NOT NULL, blob_hash text NOT NULL REFERENCES repolead_blobs(hash),
  PRIMARY KEY(publication_id,table_name,ordinal)
);
CREATE TABLE IF NOT EXISTS repolead_vectors (
  model_key text NOT NULL, content_hash text NOT NULL, dimensions integer NOT NULL,
  embedding vector NOT NULL, PRIMARY KEY(model_key,content_hash),
  CHECK(vector_dims(embedding)=dimensions)
);
CREATE TABLE IF NOT EXISTS repolead_items (
  publication_id text NOT NULL REFERENCES repolead_publications(id) ON DELETE CASCADE,
  id text NOT NULL, subject_id text NOT NULL, entity_kind text NOT NULL,
  content_hash text NOT NULL, blob_hash text NOT NULL REFERENCES repolead_blobs(hash),
  PRIMARY KEY(publication_id,id)
);
CREATE TABLE IF NOT EXISTS repolead_products (
  publication_id text NOT NULL REFERENCES repolead_publications(id) ON DELETE CASCADE,
  ref text NOT NULL, content_hash text, record jsonb NOT NULL,
  search_document tsvector NOT NULL,
  PRIMARY KEY(publication_id,ref)
);
CREATE INDEX IF NOT EXISTS repolead_product_fts ON repolead_products USING gin(search_document);
CREATE TABLE IF NOT EXISTS repolead_readers (
  issuer text NOT NULL, email text NOT NULL, subject text,
  enabled boolean NOT NULL DEFAULT true, repositories text[] NOT NULL,
  PRIMARY KEY(issuer,email)
);
CREATE TABLE IF NOT EXISTS repolead_jobs (
  id text PRIMARY KEY, publication_id text NOT NULL REFERENCES repolead_publications(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('embedding','research')),
  requested_by text NOT NULL, input jsonb NOT NULL, result jsonb, error text,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','complete','failed')),
  lease_owner text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS repolead_job_queue ON repolead_jobs(kind,state,created_at);
CREATE TABLE IF NOT EXISTS repolead_query_vectors (
  model_key text NOT NULL, query_hash text NOT NULL, embedding vector NOT NULL,
  PRIMARY KEY(model_key,query_hash)
);
DO $roles$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='repolead_app') THEN
    GRANT SELECT ON repolead_publications,repolead_repositories,repolead_products,
      repolead_vectors,repolead_query_vectors,repolead_readers TO repolead_app;
    GRANT SELECT,INSERT,UPDATE ON repolead_jobs TO repolead_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='repolead_worker') THEN
    GRANT SELECT ON repolead_publications,repolead_repositories,repolead_rows,repolead_blobs,
      repolead_items,repolead_vectors,repolead_query_vectors,repolead_jobs TO repolead_worker;
    GRANT UPDATE ON repolead_jobs TO repolead_worker;
    GRANT INSERT ON repolead_query_vectors TO repolead_worker;
  END IF;
END $roles$;
`;

/** Only tables needed for portable source corroboration, not the local runtime's caches/secrets. */
export const MIRROR_TABLES = ['repositories', 'snapshots', 'files', 'modules', 'symbols', 'edges', 'exports',
  'summaries', 'summary_evidence', 'evidence_records', 'file_sources', 'source_blobs', 'snapshot_metadata'] as const;
