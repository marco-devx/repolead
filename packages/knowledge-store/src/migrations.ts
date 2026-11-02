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
  {
    version: 2,
    name: 'summary-provenance',
    sql: `
CREATE TABLE evidence_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  content_hash TEXT NOT NULL,
  parent_ids_json TEXT NOT NULL
);
CREATE TABLE summary_evidence (
  summary_id TEXT NOT NULL REFERENCES summaries(id),
  evidence_id TEXT NOT NULL REFERENCES evidence_records(id),
  PRIMARY KEY (summary_id, evidence_id)
);
CREATE INDEX idx_summary_evidence_record ON summary_evidence(evidence_id);
`,
  },
  {
    version: 3,
    name: 'snapshot-metadata',
    sql: `CREATE TABLE snapshot_metadata (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY(snapshot_id, key)
    );`,
  },
  {
    version: 4,
    name: 'file-extraction-cache',
    sql: `CREATE TABLE file_extractions (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      analyzer_version TEXT NOT NULL,
      extraction_json TEXT NOT NULL,
      PRIMARY KEY(snapshot_id, path)
    );`,
  },
  {
    version: 5,
    name: 'product-documentation',
    sql: `CREATE TABLE documents (
      id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      repository_id TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY(id, snapshot_id)
    );
    CREATE VIRTUAL TABLE documents_fts USING fts5(title, content, path, content='documents');
    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, content, path) VALUES (new.rowid, new.title, new.content, new.path);
    END;
    CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, path) VALUES ('delete', old.rowid, old.title, old.content, old.path);
    END;
    CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, path) VALUES ('delete', old.rowid, old.title, old.content, old.path);
      INSERT INTO documents_fts(rowid, title, content, path) VALUES (new.rowid, new.title, new.content, new.path);
    END;`,
  },
  {
    version: 6,
    name: 'policy-judgment-cache',
    sql: `CREATE TABLE policy_judgments (
      cache_key TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      verdicts_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
  },
  {
    version: 7,
    name: 'finding-judgment-provenance',
    sql: `CREATE TABLE finding_judgments (
      finding_id TEXT PRIMARY KEY REFERENCES findings(id),
      policy_version TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      candidate_hash TEXT NOT NULL,
      judgment_cache_key TEXT REFERENCES policy_judgments(cache_key),
      reasoning TEXT
    );`,
  },
  {
    version: 8,
    name: 'snapshot-source-and-search-projection',
    sql: `CREATE TABLE source_blobs (
      content_hash TEXT PRIMARY KEY,
      content TEXT NOT NULL
    );
    CREATE TABLE file_sources (
      snapshot_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL REFERENCES source_blobs(content_hash),
      PRIMARY KEY(snapshot_id, path),
      FOREIGN KEY(snapshot_id, path) REFERENCES files(snapshot_id, path)
    );
    CREATE TABLE knowledge_items (
      id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      repository_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      language TEXT,
      module TEXT,
      module_path TEXT,
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_complete INTEGER NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      PRIMARY KEY(id, snapshot_id)
    );
    CREATE INDEX idx_knowledge_filters ON knowledge_items(snapshot_id, entity_kind, language, module);
    CREATE VIRTUAL TABLE knowledge_fts USING fts5(title, path, text, content='knowledge_items');
    CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge_items BEGIN
      INSERT INTO knowledge_fts(rowid, title, path, text) VALUES (new.rowid, new.title, new.path, new.text);
    END;
    CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge_items BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, path, text) VALUES ('delete', old.rowid, old.title, old.path, old.text);
    END;
    CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge_items BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, path, text) VALUES ('delete', old.rowid, old.title, old.path, old.text);
      INSERT INTO knowledge_fts(rowid, title, path, text) VALUES (new.rowid, new.title, new.path, new.text);
    END;
    CREATE TABLE vector_index_leases (
      collection TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );`,
  },
  {
    version: 9,
    name: 'export-facts-exact-spans-and-routes',
    sql: `ALTER TABLE symbols ADD COLUMN span_json TEXT;
    ALTER TABLE symbols ADD COLUMN route_json TEXT;
    ALTER TABLE tests ADD COLUMN start_line INTEGER;
    ALTER TABLE tests ADD COLUMN end_line INTEGER;
    ALTER TABLE tests ADD COLUMN span_json TEXT;
    ALTER TABLE tests ADD COLUMN content_hash TEXT;
    CREATE TABLE exports (
      id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      path TEXT NOT NULL,
      exported_name TEXT NOT NULL,
      local_name TEXT,
      source_module TEXT,
      type_only INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      symbol_id TEXT,
      PRIMARY KEY(id, snapshot_id)
    );
    CREATE INDEX idx_exports_path ON exports(snapshot_id, path);`,
  },
  {
    version: 10,
    name: 'resolved-reference-occurrences',
    sql: `CREATE TABLE symbol_references (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      target_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      is_definition INTEGER NOT NULL,
      is_call INTEGER NOT NULL,
      analyzer TEXT NOT NULL,
      scip_symbol TEXT NOT NULL,
      PRIMARY KEY(snapshot_id, target_id, path, start_line, start_column, end_line, end_column, is_definition, analyzer)
    );
    CREATE INDEX idx_symbol_references_target ON symbol_references(snapshot_id, target_id, is_definition);`,
  },
  {
    version: 11,
    name: 'quality-reports-and-coverage-provenance',
    sql: `CREATE TABLE quality_issues (
      id TEXT NOT NULL, snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      analyzer TEXT NOT NULL, rule_id TEXT NOT NULL, message TEXT NOT NULL,
      locations_json TEXT NOT NULL, details_json TEXT NOT NULL,
      PRIMARY KEY(snapshot_id, id)
    );
    CREATE TABLE quality_report_cache (
      cache_key TEXT PRIMARY KEY, tool TEXT NOT NULL, version TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    ALTER TABLE coverage ADD COLUMN analyzer TEXT;
    ALTER TABLE coverage ADD COLUMN source_hash TEXT;
    ALTER TABLE coverage ADD COLUMN lines_json TEXT;
    ALTER TABLE coverage ADD COLUMN provenance_json TEXT;`,
  },
  {
    version: 12,
    name: 'symbol-member-visibility',
    sql: "ALTER TABLE symbols ADD COLUMN visibility TEXT CHECK(visibility IN ('public', 'protected', 'private'));",
  },
  {
    version: 13,
    name: 'derived-opportunity-provenance',
    sql: `ALTER TABLE opportunities ADD COLUMN priority REAL;
    ALTER TABLE opportunities ADD COLUMN subject_id TEXT;
    ALTER TABLE opportunities ADD COLUMN source_kind TEXT;
    ALTER TABLE opportunities ADD COLUMN source_id TEXT;
    ALTER TABLE opportunities ADD COLUMN details_json TEXT;
    ALTER TABLE opportunities ADD COLUMN analyzer TEXT;
    ALTER TABLE opportunities ADD COLUMN input_hash TEXT;
    CREATE INDEX idx_opportunities_snapshot_analyzer ON opportunities(snapshot_id, analyzer);`,
  },
  {
    version: 14,
    name: 'source-bound-mutation-reports',
    sql: `CREATE TABLE mutation_reports (
      id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
      origin TEXT NOT NULL CHECK(origin IN ('executed', 'imported')),
      report_hash TEXT NOT NULL, plan_json TEXT NOT NULL, result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_mutation_reports_snapshot ON mutation_reports(snapshot_id, created_at);`,
  },
  {
    version: 15,
    name: 'summary-evidence-cache-bindings',
    sql: `CREATE TABLE summary_cache_bindings (
      summary_id TEXT PRIMARY KEY REFERENCES summaries(id), evidence_ids_json TEXT NOT NULL
    );`,
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
