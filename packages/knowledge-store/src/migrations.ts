import type { SqlDatabase } from './driver';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE files (
  id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  path TEXT NOT NULL,
  language TEXT,
  content_hash TEXT NOT NULL,
  line_count INTEGER,
  last_author TEXT,
  last_commit_at TEXT,
  PRIMARY KEY (id, snapshot_id),
  UNIQUE (snapshot_id, path)
);

CREATE TABLE modules (
  id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (id, snapshot_id)
);

CREATE TABLE symbols (
  id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  path TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (id, snapshot_id)
);
CREATE INDEX idx_symbols_snapshot_path ON symbols(snapshot_id, path);
CREATE INDEX idx_symbols_qualified ON symbols(snapshot_id, qualified_name);

CREATE TABLE edges (
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  analyzer TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, source_id, target_id, edge_type, analyzer)
);
CREATE INDEX idx_edges_target ON edges(snapshot_id, target_id, edge_type);

CREATE TABLE metrics (
  snapshot_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  analyzer TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, subject_id, name, analyzer)
);

CREATE TABLE tests (
  id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (id, snapshot_id)
);

CREATE TABLE coverage (
  snapshot_id TEXT NOT NULL,
  path TEXT NOT NULL,
  line_rate REAL,
  branch_rate REAL,
  PRIMARY KEY (snapshot_id, path)
);

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence REAL NOT NULL,
  claim TEXT NOT NULL,
  recommendation TEXT,
  module TEXT,
  status TEXT NOT NULL DEFAULT 'candidate',
  superseded_by TEXT REFERENCES findings(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_findings_snapshot ON findings(snapshot_id, status, severity);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  excerpt TEXT
);
CREATE INDEX idx_evidence_owner ON evidence(owner_id);

CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  level TEXT NOT NULL,
  content_json TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_summaries_subject ON summaries(snapshot_id, subject_id);

CREATE TABLE opportunities (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  module TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  impact TEXT,
  effort TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cache_key TEXT NOT NULL UNIQUE,
  model TEXT,
  prompt_version TEXT,
  policy_version TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER
);

-- FTS5 con contenido externo: los triggers mantienen el índice sincronizado
-- con la tabla fuente (patrón tomado de engram), sin duplicar almacenamiento.
CREATE VIRTUAL TABLE symbols_fts USING fts5(
  qualified_name, path, signature,
  content='symbols'
);
CREATE TRIGGER symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, qualified_name, path, signature)
  VALUES (new.rowid, new.qualified_name, new.path, new.signature);
END;
CREATE TRIGGER symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, qualified_name, path, signature)
  VALUES ('delete', old.rowid, old.qualified_name, old.path, old.signature);
END;
CREATE TRIGGER symbols_au AFTER UPDATE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, qualified_name, path, signature)
  VALUES ('delete', old.rowid, old.qualified_name, old.path, old.signature);
  INSERT INTO symbols_fts(rowid, qualified_name, path, signature)
  VALUES (new.rowid, new.qualified_name, new.path, new.signature);
END;

CREATE VIRTUAL TABLE findings_fts USING fts5(
  claim, recommendation,
  content='findings'
);
CREATE TRIGGER findings_ai AFTER INSERT ON findings BEGIN
  INSERT INTO findings_fts(rowid, claim, recommendation)
  VALUES (new.rowid, new.claim, new.recommendation);
END;
CREATE TRIGGER findings_ad AFTER DELETE ON findings BEGIN
  INSERT INTO findings_fts(findings_fts, rowid, claim, recommendation)
  VALUES ('delete', old.rowid, old.claim, old.recommendation);
END;
CREATE TRIGGER findings_au AFTER UPDATE ON findings BEGIN
  INSERT INTO findings_fts(findings_fts, rowid, claim, recommendation)
  VALUES ('delete', old.rowid, old.claim, old.recommendation);
  INSERT INTO findings_fts(rowid, claim, recommendation)
  VALUES (new.rowid, new.claim, new.recommendation);
END;

CREATE VIRTUAL TABLE summaries_fts USING fts5(
  content_json,
  content='summaries'
);
CREATE TRIGGER summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, content_json) VALUES (new.rowid, new.content_json);
END;
CREATE TRIGGER summaries_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content_json)
  VALUES ('delete', old.rowid, old.content_json);
END;
CREATE TRIGGER summaries_au AFTER UPDATE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content_json)
  VALUES ('delete', old.rowid, old.content_json);
  INSERT INTO summaries_fts(rowid, content_json) VALUES (new.rowid, new.content_json);
END;
`,
  },
];

export function applyMigrations(db: SqlDatabase): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);`);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (row) => row.version,
    ),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    })();
  }
}
