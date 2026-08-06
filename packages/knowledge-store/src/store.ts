import { randomUUID } from 'node:crypto';

import type {
  CodeSymbol,
  Edge,
  EdgeType,
  Evidence,
  Finding,
  FindingStatus,
  Metric,
  Module,
  Repository,
  Severity,
  Snapshot,
  SourceFile,
  SummaryDoc,
  SummaryLevel,
  SymbolKind,
  TestCase,
} from '@repolead/domain';
import { stableRepositoryId } from '@repolead/domain';

import type { SqlDatabase } from './driver';
import { openDatabase } from './driver';
import { applyMigrations } from './migrations';

interface SymbolRow {
  id: string;
  repository_id: string;
  snapshot_id: string;
  path: string;
  qualified_name: string;
  kind: string;
  signature: string | null;
  start_line: number;
  end_line: number;
  content_hash: string;
  source: string;
}

interface EdgeRow {
  snapshot_id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  confidence: number;
  analyzer: string;
  evidence_json: string;
}

interface EvidenceRow {
  id: string;
  owner_id: string;
  owner_kind: string;
  path: string;
  start_line: number | null;
  end_line: number | null;
  excerpt: string | null;
}

interface FindingRow {
  id: string;
  snapshot_id: string;
  repository_id: string;
  rule_id: string;
  severity: string;
  confidence: number;
  claim: string;
  recommendation: string | null;
  module: string | null;
  status: string;
  superseded_by: string | null;
  created_at: string;
}

export interface SymbolSearchHit {
  symbol: CodeSymbol;
  rank: number;
}

export interface CodeGraph {
  symbols: Map<string, CodeSymbol>;
  outgoing: Map<string, Edge[]>;
  incoming: Map<string, Edge[]>;
}

function toSymbol(row: SymbolRow): CodeSymbol {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    snapshotId: row.snapshot_id,
    path: row.path,
    qualifiedName: row.qualified_name,
    kind: row.kind as SymbolKind,
    signature: row.signature,
    startLine: row.start_line,
    endLine: row.end_line,
    contentHash: row.content_hash,
    source: row.source,
  };
}

function toEdge(row: EdgeRow): Edge {
  return {
    snapshotId: row.snapshot_id,
    sourceId: row.source_id,
    targetId: row.target_id,
    edgeType: row.edge_type as EdgeType,
    confidence: row.confidence,
    analyzer: row.analyzer,
    evidence: JSON.parse(row.evidence_json) as unknown,
  };
}

function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    snapshotId: row.snapshot_id,
    repositoryId: row.repository_id,
    ruleId: row.rule_id,
    severity: row.severity as Severity,
    confidence: row.confidence,
    claim: row.claim,
    recommendation: row.recommendation,
    module: row.module,
    status: row.status as FindingStatus,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
  };
}

/** Convierte texto libre en una consulta FTS5 de términos con prefijo. */
function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(' ');
}

export async function openStore(path = ':memory:'): Promise<KnowledgeStore> {
  const db = await openDatabase(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);
  applyMigrations(db);
  return new KnowledgeStore(db);
}

export class KnowledgeStore {
  constructor(readonly db: SqlDatabase) {}

  close(): void {
    this.db.close();
  }

  upsertRepository(input: { name: string; rootPath: string }): Repository {
    const repository: Repository = {
      id: stableRepositoryId(input.name),
      name: input.name,
      rootPath: input.rootPath,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO repositories (id, name, root_path, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET root_path = excluded.root_path`,
      )
      .run(repository.id, repository.name, repository.rootPath, repository.createdAt);
    return repository;
  }

  createSnapshot(input: { repositoryId: string; commitSha: string }): Snapshot {
    const snapshot: Snapshot = {
      id: `snap_${randomUUID()}`,
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO snapshots (id, repository_id, commit_sha, created_at) VALUES (?, ?, ?, ?)')
      .run(snapshot.id, snapshot.repositoryId, snapshot.commitSha, snapshot.createdAt);
    return snapshot;
  }

  insertFiles(files: SourceFile[]): void {
    const insert = this.db.prepare(
      `INSERT INTO files (id, repository_id, snapshot_id, path, language, content_hash, line_count,
                          last_author, last_commit_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const file of files) {
        insert.run(
          file.id,
          file.repositoryId,
          file.snapshotId,
          file.path,
          file.language,
          file.contentHash,
          file.lineCount,
          file.lastAuthor,
          file.lastCommitAt,
        );
      }
    })();
  }

  insertModules(modules: Module[]): void {
    const insert = this.db.prepare(
      'INSERT INTO modules (id, repository_id, snapshot_id, name, path) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const module of modules) {
        insert.run(module.id, module.repositoryId, module.snapshotId, module.name, module.path);
      }
    })();
  }

  insertTests(tests: TestCase[]): void {
    const insert = this.db.prepare('INSERT INTO tests (id, snapshot_id, path, name) VALUES (?, ?, ?, ?)');
    this.db.transaction(() => {
      for (const testCase of tests) {
        insert.run(testCase.id, testCase.snapshotId, testCase.path, testCase.name);
      }
    })();
  }

  insertMetrics(metrics: Metric[]): void {
    const insert = this.db.prepare(
      `INSERT INTO metrics (snapshot_id, subject_id, name, value, analyzer) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id, subject_id, name, analyzer) DO UPDATE SET value = excluded.value`,
    );
    this.db.transaction(() => {
      for (const metric of metrics) {
        insert.run(metric.snapshotId, metric.subjectId, metric.name, metric.value, metric.analyzer);
      }
    })();
  }

  getCounts(snapshotId: string): {
    files: number;
    symbols: number;
    edges: number;
    modules: number;
    tests: number;
    metrics: number;
  } {
    const count = (table: string): number => {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE snapshot_id = ?`)
        .get(snapshotId) as { n: number };
      return row.n;
    };
    return {
      files: count('files'),
      symbols: count('symbols'),
      edges: count('edges'),
      modules: count('modules'),
      tests: count('tests'),
      metrics: count('metrics'),
    };
  }

  insertSymbols(symbols: CodeSymbol[]): void {
    const insert = this.db.prepare(
      `INSERT INTO symbols (id, repository_id, snapshot_id, path, qualified_name, kind, signature,
                            start_line, end_line, content_hash, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const symbol of symbols) {
        insert.run(
          symbol.id,
          symbol.repositoryId,
          symbol.snapshotId,
          symbol.path,
          symbol.qualifiedName,
          symbol.kind,
          symbol.signature,
          symbol.startLine,
          symbol.endLine,
          symbol.contentHash,
          symbol.source,
        );
      }
    })();
  }

  insertEdges(edges: Edge[]): void {
    const insert = this.db.prepare(
      `INSERT INTO edges (snapshot_id, source_id, target_id, edge_type, confidence, analyzer, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const edge of edges) {
        insert.run(
          edge.snapshotId,
          edge.sourceId,
          edge.targetId,
          edge.edgeType,
          edge.confidence,
          edge.analyzer,
          JSON.stringify(edge.evidence ?? null),
        );
      }
    })();
  }

  insertFinding(finding: Finding, evidence: Evidence[] = []): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO findings (id, snapshot_id, repository_id, rule_id, severity, confidence, claim,
                                 recommendation, module, status, superseded_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          finding.id,
          finding.snapshotId,
          finding.repositoryId,
          finding.ruleId,
          finding.severity,
          finding.confidence,
          finding.claim,
          finding.recommendation,
          finding.module,
          finding.status,
          finding.supersededBy,
          finding.createdAt,
        );
      const insertEvidence = this.db.prepare(
        `INSERT INTO evidence (id, owner_id, owner_kind, path, start_line, end_line, excerpt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of evidence) {
        insertEvidence.run(
          item.id,
          item.ownerId,
          item.ownerKind,
          item.path,
          item.startLine,
          item.endLine,
          item.excerpt,
        );
      }
    })();
  }

  insertSummary(summary: SummaryDoc): void {
    this.db
      .prepare(
        `INSERT INTO summaries (id, snapshot_id, subject_id, level, content_json, model, prompt_version,
                                content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        summary.id,
        summary.snapshotId,
        summary.subjectId,
        summary.level,
        summary.contentJson,
        summary.model,
        summary.promptVersion,
        summary.contentHash,
        summary.createdAt,
      );
  }

  listModules(snapshotId: string): Module[] {
    const rows = this.db
      .prepare('SELECT * FROM modules WHERE snapshot_id = ? ORDER BY path')
      .all(snapshotId) as {
      id: string;
      repository_id: string;
      snapshot_id: string;
      name: string;
      path: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      repositoryId: row.repository_id,
      snapshotId: row.snapshot_id,
      name: row.name,
      path: row.path,
    }));
  }

  /**
   * Caché de análisis: busca un summary previo del mismo subject cuyo evidence
   * pack (content_hash) + prompt + modelo no cambiaron, en cualquier snapshot.
   * Si existe, el análisis no se repite (regla 2 del plan: caché por contenido).
   */
  findCachedSummary(
    subjectId: string,
    level: SummaryLevel,
    contentHash: string,
    promptVersion: string,
    model: string,
  ): SummaryDoc | null {
    const row = this.db
      .prepare(
        `SELECT * FROM summaries
         WHERE subject_id = ? AND level = ? AND content_hash = ? AND prompt_version = ? AND model = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(subjectId, level, contentHash, promptVersion, model) as
      | {
          id: string;
          snapshot_id: string;
          subject_id: string;
          level: string;
          content_json: string;
          model: string;
          prompt_version: string;
          content_hash: string;
          created_at: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          snapshotId: row.snapshot_id,
          subjectId: row.subject_id,
          level: row.level as SummaryLevel,
          contentJson: row.content_json,
          model: row.model,
          promptVersion: row.prompt_version,
          contentHash: row.content_hash,
          createdAt: row.created_at,
        }
      : null;
  }

  getSymbol(snapshotId: string, symbolId: string): CodeSymbol | null {
    const row = this.db
      .prepare('SELECT * FROM symbols WHERE snapshot_id = ? AND id = ?')
      .get(snapshotId, symbolId) as SymbolRow | undefined;
    return row ? toSymbol(row) : null;
  }

  getLatestSnapshot(): Snapshot | null {
    const row = this.db
      .prepare('SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 1')
      .get() as { id: string; repository_id: string; commit_sha: string; created_at: string } | undefined;
    return row
      ? { id: row.id, repositoryId: row.repository_id, commitSha: row.commit_sha, createdAt: row.created_at }
      : null;
  }

  getRepository(repositoryId: string): Repository | null {
    const row = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(repositoryId) as
      | { id: string; name: string; root_path: string; created_at: string }
      | undefined;
    return row ? { id: row.id, name: row.name, rootPath: row.root_path, createdAt: row.created_at } : null;
  }

  listSymbols(snapshotId: string, path?: string): CodeSymbol[] {
    const rows = path
      ? (this.db
          .prepare('SELECT * FROM symbols WHERE snapshot_id = ? AND path = ? ORDER BY start_line')
          .all(snapshotId, path) as SymbolRow[])
      : (this.db
          .prepare('SELECT * FROM symbols WHERE snapshot_id = ? ORDER BY path, start_line')
          .all(snapshotId) as SymbolRow[]);
    return rows.map(toSymbol);
  }

  /**
   * Búsqueda BM25 con pesos por columna: qualified_name pesa más que path,
   * y path más que signature.
   */
  searchSymbols(snapshotId: string, query: string, limit = 20): SymbolSearchHit[] {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery.length === 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT s.*, bm25(symbols_fts, 5.0, 2.0, 1.0) AS rank
         FROM symbols_fts
         JOIN symbols s ON s.rowid = symbols_fts.rowid
         WHERE symbols_fts MATCH ? AND s.snapshot_id = ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, snapshotId, limit) as (SymbolRow & { rank: number })[];
    return rows.map((row) => ({ symbol: toSymbol(row), rank: row.rank }));
  }

  getFindings(snapshotId: string, status?: FindingStatus): Finding[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM findings WHERE snapshot_id = ? AND status = ? ORDER BY created_at')
          .all(snapshotId, status) as FindingRow[])
      : (this.db
          .prepare('SELECT * FROM findings WHERE snapshot_id = ? ORDER BY created_at')
          .all(snapshotId) as FindingRow[]);
    return rows.map(toFinding);
  }

  getEvidence(ownerId: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE owner_id = ?')
      .all(ownerId) as EvidenceRow[];
    return rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      ownerKind: row.owner_kind as Evidence['ownerKind'],
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      excerpt: row.excerpt,
    }));
  }

  /** Reconstruye el grafo de un snapshot en memoria: símbolos + adyacencia. */
  loadGraph(snapshotId: string): CodeGraph {
    const symbols = new Map<string, CodeSymbol>();
    for (const symbol of this.listSymbols(snapshotId)) {
      symbols.set(symbol.id, symbol);
    }

    const outgoing = new Map<string, Edge[]>();
    const incoming = new Map<string, Edge[]>();
    const rows = this.db
      .prepare('SELECT * FROM edges WHERE snapshot_id = ?')
      .all(snapshotId) as EdgeRow[];
    for (const row of rows) {
      const edge = toEdge(row);
      const out = outgoing.get(edge.sourceId) ?? [];
      out.push(edge);
      outgoing.set(edge.sourceId, out);
      const incoming_ = incoming.get(edge.targetId) ?? [];
      incoming_.push(edge);
      incoming.set(edge.targetId, incoming_);
    }

    return { symbols, outgoing, incoming };
  }
}
