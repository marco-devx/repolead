import { randomUUID } from 'node:crypto';

import type {
  CodeSymbol,
  CoverageRecord,
  Edge,
  EdgeType,
  Evidence,
  EvidenceRecord,
  ExportBinding,
  Finding,
  FindingStatus,
  ImprovementOpportunity,
  KnowledgeDocument,
  KnowledgeItem,
  KnowledgeKind,
  Metric,
  Module,
  Repository,
  QualityIssue,
  Severity,
  Snapshot,
  SourceFile,
  SummaryDoc,
  SummaryLevel,
  SymbolKind,
  SymbolReference,
  TestCase,
} from '@repolead/domain';
import { contentHash, stableRepositoryId } from '@repolead/domain';

import type { SqlDatabase } from './driver';
import { openDatabase } from './driver';
import { applyMigrations } from './migrations';
import { buildKnowledgeItems } from './search-index';

const KNOWLEDGE_COLUMNS = `id, snapshot_id AS snapshotId, repository_id AS repositoryId, subject_id AS subjectId,
  entity_kind AS entityKind, kind, title, path, start_line AS startLine, end_line AS endLine, language,
  module, module_path AS modulePath, text, content_hash AS contentHash, source_complete AS sourceComplete, evidence_ids_json AS evidenceIds`;
type KnowledgeRow = Omit<KnowledgeItem, 'sourceComplete' | 'evidenceIds'> & { sourceComplete: number; evidenceIds: string };
const toKnowledge = (row: KnowledgeRow): KnowledgeItem => ({ ...row, sourceComplete: Boolean(row.sourceComplete), evidenceIds: JSON.parse(row.evidenceIds) as string[] });

export interface KnowledgeFilters { entityKinds?: KnowledgeKind[]; language?: string; module?: string; kind?: string; repository?: string; excludeTests?: boolean }
const TEST_PATH_GLOBS = ['*.test.*', '*.spec.*', 'test_*.py', '*/test_*.py',
  ...['test', 'tests', 'spec', 'specs', '__tests__'].flatMap((name) => [`${name}/*`, `*/${name}/*`])];
const TEST_PATH_PATTERNS = TEST_PATH_GLOBS.map((glob) => new RegExp(`^${glob.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));

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
  span_json: string | null;
  route_json: string | null;
  visibility: CodeSymbol['visibility'] | null;
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

interface SummaryRow {
  id: string; snapshot_id: string; subject_id: string; level: string; content_json: string;
  model: string; prompt_version: string; content_hash: string; created_at: string;
}

function toSummary(row: SummaryRow): SummaryDoc {
  return { id: row.id, snapshotId: row.snapshot_id, subjectId: row.subject_id, level: row.level as SummaryLevel,
    contentJson: row.content_json, model: row.model, promptVersion: row.prompt_version,
    contentHash: row.content_hash, createdAt: row.created_at };
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
    ...(row.span_json ? { span: JSON.parse(row.span_json) as CodeSymbol['span'] } : {}),
    ...(row.route_json ? { route: JSON.parse(row.route_json) as CodeSymbol['route'] } : {}),
    ...(row.visibility ? { visibility: row.visibility } : {}),
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

export async function openStore(path = ':memory:', options: { readonly?: boolean } = {}): Promise<KnowledgeStore> {
  const db = await openDatabase(path, options.readonly);
  if (options.readonly) {
    // No migrations, checkpoints or journal changes on databases being generated.
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
    return new KnowledgeStore(db);
  }
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

  insertSnapshotSources(snapshotId: string, sources: { path: string; contentHash: string; content: string }[]): void {
    const blob = this.db.prepare('INSERT INTO source_blobs (content_hash, content) VALUES (?, ?) ON CONFLICT(content_hash) DO NOTHING');
    const link = this.db.prepare('INSERT INTO file_sources (snapshot_id, path, content_hash) VALUES (?, ?, ?)');
    this.db.transaction(() => {
      for (const source of sources) {
        if (contentHash(source.content) !== source.contentHash) { throw new Error(`Source hash mismatch: ${source.path}`); }
        blob.run(source.contentHash, source.content);
        link.run(snapshotId, source.path, source.contentHash);
      }
    })();
  }

  getSnapshotSource(snapshotId: string, path: string): string | null {
    const row = this.db.prepare(`SELECT b.content FROM file_sources s JOIN source_blobs b ON b.content_hash = s.content_hash
      JOIN files f ON f.snapshot_id = s.snapshot_id AND f.path = s.path AND f.content_hash = s.content_hash
      WHERE s.snapshot_id = ? AND s.path = ?`).get(snapshotId, path) as { content: string } | undefined;
    return row?.content ?? null;
  }

  rebuildSearchIndex(snapshotId: string): KnowledgeItem[] {
    const items = buildKnowledgeItems(this, snapshotId);
    const insert = this.db.prepare(`INSERT INTO knowledge_items
      (id, snapshot_id, repository_id, subject_id, entity_kind, kind, title, path, start_line, end_line,
       language, module, module_path, text, content_hash, source_complete, evidence_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_items WHERE snapshot_id = ?').run(snapshotId);
      for (const item of items) { insert.run(item.id, item.snapshotId, item.repositoryId, item.subjectId,
        item.entityKind, item.kind, item.title, item.path, item.startLine, item.endLine, item.language,
        item.module, item.modulePath, item.text, item.contentHash, Number(item.sourceComplete), JSON.stringify(item.evidenceIds)); }
      this.setSnapshotMetadata(snapshotId, 'knowledge_projection', contentHash(JSON.stringify(items)));
    })();
    return items;
  }

  listKnowledgeItems(snapshotId: string, filters: KnowledgeFilters = {}): KnowledgeItem[] {
    const rows = this.db.prepare(`SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge_items WHERE snapshot_id = ? ORDER BY id`).all(snapshotId) as unknown as KnowledgeRow[];
    return rows.map(toKnowledge).filter((item) => this.matchesKnowledge(item, filters));
  }

  matchesKnowledge(item: KnowledgeItem, filters: KnowledgeFilters): boolean {
    return (item.entityKind !== 'summary' || this.isSummaryVisible(item.snapshotId, { level: item.kind, subjectId: item.subjectId }))
      && (!filters.entityKinds?.length || filters.entityKinds.includes(item.entityKind))
      && (!filters.excludeTests || (item.entityKind !== 'test' && !TEST_PATH_PATTERNS.some((pattern) => pattern.test(item.path))
        && !this.db.prepare('SELECT 1 FROM tests WHERE snapshot_id = ? AND path = ? LIMIT 1').get(item.snapshotId, item.path)))
      && (!filters.language || item.language === filters.language)
      && (!filters.module || item.module === filters.module || item.modulePath === filters.module)
      && (!filters.kind || item.kind === filters.kind)
      && (!filters.repository || this.getRepository(item.repositoryId)?.name === filters.repository);
  }

  getKnowledgeItem(snapshotId: string, id: string): KnowledgeItem | null {
    const row = this.db.prepare(`SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge_items WHERE snapshot_id = ? AND id = ?`).get(snapshotId, id) as unknown as KnowledgeRow | undefined;
    return row ? toKnowledge(row) : null;
  }

  searchKnowledge(snapshotId: string, query: string, limit = 20, filters: KnowledgeFilters = {}): { item: KnowledgeItem; rank: number }[] {
    const terms = query.split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"*`);
    if (!terms.length) { return []; }
    // Apply filters before LIMIT so unrelated languages/modules cannot exhaust the candidate set.
    const conditions = ['k.snapshot_id = ?'];
    const parameters: (string | number)[] = [terms.join(' OR '), snapshotId];
    if (this.getSnapshotMetadata(snapshotId, 'synthesis_mode') === 'entrypoints') {
      const subjects = this.entryPointSummarySubjects(snapshotId);
      conditions.push(subjects.length ? `(k.entity_kind <> 'summary' OR (k.kind = 'file' AND k.subject_id IN (${subjects.map(() => '?').join(',')})))`
        : "k.entity_kind <> 'summary'");
      parameters.push(...subjects);
    }
    if (this.getSnapshotMetadata(snapshotId, 'synthesis_mode') === 'first-round') {
      conditions.push("(k.entity_kind <> 'summary' OR (k.kind NOT IN ('repository','product') AND (k.kind <> 'module' OR k.subject_id LIKE '%#synthesis:0:%') AND (k.subject_id NOT LIKE '%#synthesis:%' OR k.subject_id LIKE '%#synthesis:0:%')))");
    }
    if (filters.entityKinds?.length) { conditions.push(`k.entity_kind IN (${filters.entityKinds.map(() => '?').join(',')})`); parameters.push(...filters.entityKinds); }
    if (filters.language) { conditions.push('k.language = ?'); parameters.push(filters.language); }
    if (filters.kind) { conditions.push('k.kind = ?'); parameters.push(filters.kind); }
    if (filters.module) { conditions.push('(k.module = ? OR k.module_path = ?)'); parameters.push(filters.module, filters.module); }
    if (filters.repository) { conditions.push('k.repository_id IN (SELECT id FROM repositories WHERE name = ?)'); parameters.push(filters.repository); }
    if (filters.excludeTests) {
      conditions.push("k.entity_kind <> 'test'", 'NOT EXISTS (SELECT 1 FROM tests t WHERE t.snapshot_id = k.snapshot_id AND t.path = k.path)', ...TEST_PATH_GLOBS.map(() => 'k.path NOT GLOB ?'));
      parameters.push(...TEST_PATH_GLOBS);
    }
    parameters.push(limit);
    const rows = this.db.prepare(`SELECT k.id, bm25(knowledge_fts, 5.0, 2.0, 1.0) AS rank FROM knowledge_fts
      JOIN knowledge_items k ON k.rowid = knowledge_fts.rowid WHERE knowledge_fts MATCH ? AND ${conditions.join(' AND ')}
      ORDER BY rank LIMIT ?`).all(...parameters) as { id: string; rank: number }[];
    return rows.map((row) => ({ item: this.getKnowledgeItem(snapshotId, row.id)!, rank: row.rank }));
  }

  insertDocuments(documents: KnowledgeDocument[]): void {
    const insert = this.db.prepare('INSERT INTO documents (id, snapshot_id, repository_id, path, title, content, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.db.transaction(() => {
      for (const document of documents) {
        insert.run(document.id, document.snapshotId, document.repositoryId, document.path, document.title, document.content, document.contentHash);
      }
    })();
  }

  listDocuments(snapshotId: string): KnowledgeDocument[] {
    const rows = this.db.prepare('SELECT id, snapshot_id AS snapshotId, repository_id AS repositoryId, path, title, content, content_hash AS contentHash FROM documents WHERE snapshot_id = ? ORDER BY path').all(snapshotId);
    return rows as unknown as KnowledgeDocument[];
  }

  searchDocuments(snapshotId: string, query: string, limit = 10): { document: KnowledgeDocument; rank: number }[] {
    const fts = toFtsQuery(query);
    if (!fts) { return []; }
    const rows = this.db.prepare(`SELECT d.id, bm25(documents_fts) AS rank FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid WHERE documents_fts MATCH ? AND d.snapshot_id = ?
      ORDER BY rank LIMIT ?`).all(fts, snapshotId, limit) as { id: string; rank: number }[];
    const documents = new Map(this.listDocuments(snapshotId).map((document) => [document.id, document]));
    return rows.map((row) => ({ document: documents.get(row.id)!, rank: row.rank }));
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

  createSnapshot(input: { repositoryId: string; commitSha: string; persist?: boolean }): Snapshot {
    const snapshot: Snapshot = {
      id: `snap_${randomUUID()}`,
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      createdAt: new Date().toISOString(),
    };
    if (input.persist !== false) { this.insertSnapshot(snapshot); }
    return snapshot;
  }

  insertSnapshot(snapshot: Snapshot): void {
    this.db
      .prepare('INSERT INTO snapshots (id, repository_id, commit_sha, created_at) VALUES (?, ?, ?, ?)')
      .run(snapshot.id, snapshot.repositoryId, snapshot.commitSha, snapshot.createdAt);
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

  listFiles(snapshotId: string): SourceFile[] {
    return this.db.prepare(`SELECT id, repository_id AS repositoryId, snapshot_id AS snapshotId, path, language,
      content_hash AS contentHash, line_count AS lineCount, last_author AS lastAuthor, last_commit_at AS lastCommitAt
      FROM files WHERE snapshot_id = ? ORDER BY path`).all(snapshotId) as SourceFile[];
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
    const insert = this.db.prepare('INSERT INTO tests (id, snapshot_id, path, name, start_line, end_line, span_json, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.db.transaction(() => {
      for (const testCase of tests) {
        insert.run(testCase.id, testCase.snapshotId, testCase.path, testCase.name, testCase.startLine ?? null, testCase.endLine ?? null,
          testCase.span ? JSON.stringify(testCase.span) : null, testCase.contentHash ?? null);
      }
    })();
  }

  listTests(snapshotId: string): TestCase[] {
    const rows = this.db.prepare('SELECT id, snapshot_id AS snapshotId, path, name, start_line AS startLine, end_line AS endLine, span_json, content_hash AS contentHash FROM tests WHERE snapshot_id = ? ORDER BY path, start_line').all(snapshotId) as { id: string; snapshotId: string; path: string; name: string; startLine: number | null; endLine: number | null; span_json: string | null; contentHash: string | null }[];
    return rows.map(({ span_json, startLine, endLine, contentHash, ...row }) => ({ ...row,
      ...(startLine !== null ? { startLine } : {}), ...(endLine !== null ? { endLine } : {}), ...(contentHash !== null ? { contentHash } : {}),
      ...(span_json ? { span: JSON.parse(span_json) as TestCase['span'] } : {}) }));
  }

  insertExports(bindings: ExportBinding[]): void {
    const insert = this.db.prepare('INSERT INTO exports (id, snapshot_id, path, exported_name, local_name, source_module, type_only, start_line, symbol_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.db.transaction(() => {
      for (const entry of bindings) { insert.run(entry.id, entry.snapshotId, entry.path, entry.exportedName, entry.localName, entry.sourceModule, Number(entry.typeOnly), entry.startLine, entry.symbolId); }
    })();
  }

  insertReferences(references: SymbolReference[]): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO symbol_references
      (snapshot_id, target_id, source_id, path, start_line, start_column, end_line, end_column, is_definition, is_call, analyzer, scip_symbol)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.transaction(() => {
      for (const entry of references) { insert.run(entry.snapshotId, entry.targetId, entry.sourceId, entry.path,
        entry.startLine, entry.startColumn, entry.endLine, entry.endColumn, Number(entry.isDefinition), Number(entry.isCall), entry.analyzer, entry.scipSymbol); }
    })();
  }

  getReferences(snapshotId: string, symbolId: string, includeDefinitions = false): SymbolReference[] {
    const rows = this.db.prepare(`SELECT snapshot_id AS snapshotId, target_id AS targetId, source_id AS sourceId, path,
      start_line AS startLine, start_column AS startColumn, end_line AS endLine, end_column AS endColumn,
      is_definition AS isDefinition, is_call AS isCall, analyzer, scip_symbol AS scipSymbol FROM symbol_references
      WHERE snapshot_id = ? AND target_id = ?${includeDefinitions ? '' : ' AND is_definition = 0'}
      ORDER BY path, start_line, start_column`).all(snapshotId, symbolId) as (Omit<SymbolReference, 'isDefinition' | 'isCall'> & { isDefinition: number; isCall: number })[];
    return rows.map((row) => ({ ...row, isDefinition: Boolean(row.isDefinition), isCall: Boolean(row.isCall) }));
  }

  listExports(snapshotId: string, path?: string): ExportBinding[] {
    const rows = this.db.prepare(`SELECT id, snapshot_id AS snapshotId, path, exported_name AS exportedName, local_name AS localName,
      source_module AS sourceModule, type_only AS typeOnly, start_line AS startLine, symbol_id AS symbolId FROM exports
      WHERE snapshot_id = ?${path ? ' AND path = ?' : ''} ORDER BY path, start_line, exported_name`).all(...(path ? [snapshotId, path] : [snapshotId])) as (Omit<ExportBinding, 'typeOnly'> & { typeOnly: number })[];
    return rows.map((row) => ({ ...row, typeOnly: Boolean(row.typeOnly) }));
  }

  insertMetrics(metrics: Metric[]): void {
    const insert = this.db.prepare(
      `INSERT INTO metrics (snapshot_id, subject_id, name, value, analyzer) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id, subject_id, name, analyzer) DO UPDATE SET value = excluded.value`,
    );
    this.db.transaction(() => {
      for (const metric of metrics) {
        if (!Number.isFinite(metric.value)) { throw new Error(`Non-finite metric: ${metric.name}`); }
        insert.run(metric.snapshotId, metric.subjectId, metric.name, metric.value, metric.analyzer);
      }
    })();
  }

  listMetrics(snapshotId: string, subjectId?: string): Metric[] {
    return this.db.prepare(`SELECT snapshot_id AS snapshotId, subject_id AS subjectId, name, value, analyzer
      FROM metrics WHERE snapshot_id = ?${subjectId ? ' AND subject_id = ?' : ''} ORDER BY subject_id, name, analyzer`)
      .all(...(subjectId ? [snapshotId, subjectId] : [snapshotId])) as Metric[];
  }

  insertQualityIssues(issues: QualityIssue[]): void {
    const insert = this.db.prepare(`INSERT INTO quality_issues (id, snapshot_id, analyzer, rule_id, message, locations_json, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(snapshot_id, id) DO UPDATE SET analyzer=excluded.analyzer,
      rule_id=excluded.rule_id, message=excluded.message, locations_json=excluded.locations_json, details_json=excluded.details_json`);
    this.db.transaction(() => { for (const issue of issues) {
      insert.run(issue.id, issue.snapshotId, issue.analyzer, issue.ruleId, issue.message, JSON.stringify(issue.locations), JSON.stringify(issue.details));
    } })();
  }

  listQualityIssues(snapshotId: string, path?: string): QualityIssue[] {
    const rows = this.db.prepare(`SELECT id, snapshot_id AS snapshotId, analyzer, rule_id AS ruleId, message,
      locations_json, details_json FROM quality_issues WHERE snapshot_id = ? ORDER BY analyzer, rule_id, id`)
      .all(snapshotId) as (Omit<QualityIssue, 'locations' | 'details'> & { locations_json: string; details_json: string })[];
    return rows.map(({ locations_json, details_json, ...row }) => ({ ...row,
      locations: JSON.parse(locations_json) as QualityIssue['locations'], details: JSON.parse(details_json) as QualityIssue['details'] }))
      .filter((issue) => !path || issue.locations.some((location) => location.path === path));
  }

  insertCoverage(records: CoverageRecord[]): void {
    const insert = this.db.prepare(`INSERT INTO coverage (snapshot_id, path, line_rate, branch_rate, analyzer, source_hash, lines_json, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(snapshot_id, path) DO UPDATE SET line_rate=excluded.line_rate,
      branch_rate=excluded.branch_rate, analyzer=excluded.analyzer, source_hash=excluded.source_hash,
      lines_json=excluded.lines_json, provenance_json=excluded.provenance_json`);
    this.db.transaction(() => { for (const entry of records) {
      insert.run(entry.snapshotId, entry.path, entry.lineRate, entry.branchRate, entry.analyzer, entry.sourceHash,
        JSON.stringify(entry.lines), JSON.stringify(entry.provenance));
    } })();
  }

  listCoverage(snapshotId: string): CoverageRecord[] {
    const rows = this.db.prepare(`SELECT snapshot_id AS snapshotId, path, line_rate AS lineRate, branch_rate AS branchRate,
      analyzer, source_hash AS sourceHash, lines_json, provenance_json FROM coverage WHERE snapshot_id = ? ORDER BY path`)
      .all(snapshotId) as (Omit<CoverageRecord, 'lines' | 'provenance'> & { lines_json: string | null; provenance_json: string | null })[];
    return rows.map(({ lines_json, provenance_json, ...row }) => ({ ...row, analyzer: row.analyzer ?? 'legacy-unverified',
      sourceHash: row.sourceHash ?? '', lines: JSON.parse(lines_json ?? '[]') as CoverageRecord['lines'],
      provenance: JSON.parse(provenance_json ?? '{"sourceBinding":"unknown"}') as Record<string, unknown> }));
  }

  /** Stable factual context; execution timings/cache-hit flags never invalidate analysis. */
  qualityFacts(snapshotId: string, subjectId: string, path?: string, range?: { startLine: number; endLine: number }) {
    const metrics = this.listMetrics(snapshotId, subjectId).filter((metric) => metric.analyzer !== 'git')
      .map(({ name, value, analyzer }) => ({ name, value, analyzer }));
    const issues = path ? this.listQualityIssues(snapshotId, path).filter((issue) => !range || issue.locations.some((location) =>
      location.path === path && location.startLine <= range.endLine && location.endLine >= range.startLine))
      .map(({ snapshotId: _snapshotId, ...issue }) => issue) : [];
    const coverage = path ? this.listCoverage(snapshotId).find((entry) => entry.path === path) : undefined;
    const status = JSON.parse(this.getSnapshotMetadata(snapshotId, 'metrics_status') ?? '{"status":"unknown"}') as Record<string, unknown>;
    return { metrics, issues, status,
      coverage: coverage ? { scope: 'file', lineRate: coverage.lineRate, branchRate: coverage.branchRate,
        analyzer: coverage.analyzer, provenance: coverage.provenance } : { status: 'unknown' } };
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
                            start_line, end_line, content_hash, source, span_json, route_json, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          symbol.span ? JSON.stringify(symbol.span) : null,
          symbol.route ? JSON.stringify(symbol.route) : null,
          symbol.visibility ?? null,
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET severity = excluded.severity, confidence = excluded.confidence,
             claim = excluded.claim, recommendation = excluded.recommendation, module = excluded.module,
             status = excluded.status, superseded_by = excluded.superseded_by`,
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
      this.db.prepare('DELETE FROM evidence WHERE owner_id = ? AND owner_kind = ?').run(finding.id, 'finding');
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

  /** Replace one producer's projection atomically; preserve legacy/user-authored opportunities. */
  replaceOpportunities(snapshotId: string, analyzer: string, items: ImprovementOpportunity[], evidence: Evidence[]): void {
    const ids = new Set(items.map((item) => item.id));
    if (ids.size !== items.length || items.some((item) => item.snapshotId !== snapshotId || item.analyzer !== analyzer
      || !Number.isFinite(item.priority) || item.priority < 0 || item.priority > 100)
      || evidence.some((entry) => entry.ownerKind !== 'opportunity' || !ids.has(entry.ownerId))) {
      throw new Error('Invalid opportunity projection or evidence owner.');
    }
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM evidence WHERE owner_kind = 'opportunity' AND owner_id IN
        (SELECT id FROM opportunities WHERE snapshot_id = ? AND analyzer = ?)`).run(snapshotId, analyzer);
      this.db.prepare('DELETE FROM opportunities WHERE snapshot_id = ? AND analyzer = ?').run(snapshotId, analyzer);
      const insert = this.db.prepare(`INSERT INTO opportunities
        (id, snapshot_id, module, title, description, priority, subject_id, source_kind, source_id, details_json, analyzer, input_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const item of items) { insert.run(item.id, item.snapshotId, item.module, item.title, item.description, item.priority,
        item.subjectId, item.sourceKind, item.sourceId, JSON.stringify(item.details), analyzer, item.inputHash, item.createdAt); }
      const insertEvidence = this.db.prepare('INSERT INTO evidence (id, owner_id, owner_kind, path, start_line, end_line, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const item of evidence) { insertEvidence.run(item.id, item.ownerId, item.ownerKind, item.path, item.startLine, item.endLine, item.excerpt); }
    })();
  }

  listOpportunities(snapshotId: string, analyzer: string): ImprovementOpportunity[] {
    const rows = this.db.prepare(`SELECT id, snapshot_id AS snapshotId, module, title, description, priority,
      subject_id AS subjectId, source_kind AS sourceKind, source_id AS sourceId, details_json, analyzer, input_hash AS inputHash, created_at AS createdAt
      FROM opportunities WHERE snapshot_id = ? AND analyzer = ? ORDER BY priority DESC, id`).all(snapshotId, analyzer) as
      (Omit<ImprovementOpportunity, 'details'> & { details_json: string })[];
    return rows.map(({ details_json, ...row }) => ({ ...row, details: JSON.parse(details_json) as Record<string, unknown> }));
  }

  insertSummary(summary: SummaryDoc, evidence: EvidenceRecord[] = []): void {
    this.db.transaction(() => {
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
      for (const item of evidence) {
        this.insertEvidenceRecord(item);
        this.db.prepare('INSERT INTO summary_evidence (summary_id, evidence_id) VALUES (?, ?)')
          .run(summary.id, item.id);
      }
    })();
  }

  insertEvidenceRecord(record: EvidenceRecord): void {
    this.db.prepare(`INSERT INTO evidence_records
      (id, kind, path, start_line, end_line, content_hash, parent_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .run(record.id, record.kind, record.path, record.startLine, record.endLine,
        record.contentHash, JSON.stringify(record.parentIds));
  }

  getEvidenceRecord(id: string): EvidenceRecord | null {
    const row = this.db.prepare('SELECT * FROM evidence_records WHERE id = ?').get(id) as {
      id: string; kind: EvidenceRecord['kind']; path: string; start_line: number | null;
      end_line: number | null; content_hash: string; parent_ids_json: string;
    } | undefined;
    return row ? { id: row.id, kind: row.kind, path: row.path, startLine: row.start_line, endLine: row.end_line,
      contentHash: row.content_hash, parentIds: JSON.parse(row.parent_ids_json) as string[] } : null;
  }

  getSummaryEvidence(summaryId: string): EvidenceRecord[] {
    const ids = this.db.prepare('SELECT evidence_id FROM summary_evidence WHERE summary_id = ? ORDER BY evidence_id')
      .all(summaryId) as { evidence_id: string }[];
    return ids.map((row) => this.getEvidenceRecord(row.evidence_id)).filter((item): item is EvidenceRecord => item !== null);
  }

  listSummaries(snapshotId: string, level?: SummaryLevel): SummaryDoc[] {
    const rows = this.db.prepare(`SELECT * FROM summaries WHERE snapshot_id = ?${level ? ' AND level = ?' : ''}
      ORDER BY created_at DESC, rowid DESC`).all(...(level ? [snapshotId, level] : [snapshotId])) as SummaryRow[];
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = `${row.level}\n${row.subject_id}`;
      if (seen.has(key)) { return false; }
      seen.add(key);
      return true;
    }).map(toSummary);
  }

  /** Archived global/later-round summaries remain cached but are not served or indexed in first-round mode. */
  listVisibleSummaries(snapshotId: string, level?: SummaryLevel): SummaryDoc[] {
    const summaries = this.listSummaries(snapshotId, level);
    const mode = this.getSnapshotMetadata(snapshotId, 'synthesis_mode');
    if (mode === 'entrypoints') {
      const subjects = new Set(this.entryPointSummarySubjects(snapshotId));
      return summaries.filter((summary) => summary.level === 'file' && subjects.has(summary.subjectId));
    }
    if (mode !== 'first-round') { return summaries; }
    return summaries.filter((summary) => this.isSummaryVisible(snapshotId, summary));
  }

  isSummaryVisible(snapshotId: string, summary: { level: string; subjectId: string }): boolean {
    if (this.getSnapshotMetadata(snapshotId, 'synthesis_mode') === 'entrypoints') {
      return summary.level === 'file' && this.entryPointSummarySubjects(snapshotId).includes(summary.subjectId);
    }
    if (this.getSnapshotMetadata(snapshotId, 'synthesis_mode') !== 'first-round') { return true; }
    if (summary.level === 'repository' || summary.level === 'product') { return false; }
    const synthesis = /#synthesis:(\d+):\d+$/.exec(summary.subjectId);
    if (synthesis && synthesis[1] !== '0') { return false; }
    return summary.level !== 'module' || synthesis?.[1] === '0';
  }

  private entryPointSummarySubjects(snapshotId: string): string[] {
    const catalog = JSON.parse(this.getSnapshotMetadata(snapshotId, 'entrypoint_catalog') ?? '[]') as { summarySubjectId: string }[];
    return [...new Set(catalog.map((entry) => entry.summarySubjectId))];
  }

  getSummary(snapshotId: string, subjectId: string, level: SummaryLevel): SummaryDoc | null {
    const row = this.db.prepare(`SELECT * FROM summaries WHERE snapshot_id = ? AND subject_id = ? AND level = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(snapshotId, subjectId, level) as SummaryRow | undefined;
    return row ? toSummary(row) : null;
  }

  getSnapshot(snapshotId: string): Snapshot | null {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId) as {
      id: string; repository_id: string; commit_sha: string; created_at: string;
    } | undefined;
    return row ? { id: row.id, repositoryId: row.repository_id, commitSha: row.commit_sha, createdAt: row.created_at } : null;
  }

  getSnapshotMetadata(snapshotId: string, key: string): string | null {
    const row = this.db.prepare('SELECT value FROM snapshot_metadata WHERE snapshot_id = ? AND key = ?')
      .get(snapshotId, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSnapshotMetadata(snapshotId: string, key: string, value: string): void {
    this.db.prepare(`INSERT INTO snapshot_metadata (snapshot_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(snapshot_id, key) DO UPDATE SET value = excluded.value`).run(snapshotId, key, value);
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
      .prepare('SELECT * FROM snapshots ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get() as { id: string; repository_id: string; commit_sha: string; created_at: string } | undefined;
    return row
      ? { id: row.id, repositoryId: row.repository_id, commitSha: row.commit_sha, createdAt: row.created_at }
      : null;
  }

  listSnapshots(): Snapshot[] {
    const rows = this.db.prepare('SELECT * FROM snapshots ORDER BY created_at DESC, rowid DESC').all() as {
      id: string; repository_id: string; commit_sha: string; created_at: string;
    }[];
    return rows.map((row) => ({ id: row.id, repositoryId: row.repository_id, commitSha: row.commit_sha, createdAt: row.created_at }));
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
