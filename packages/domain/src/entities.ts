export const SYMBOL_KINDS = [
  'class',
  'method',
  'function',
  'interface',
  'endpoint',
  'type',
  'enum',
  'variable',
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export const EDGE_TYPES = [
  'CONTAINS',
  'IMPORTS',
  'CALLS',
  'IMPLEMENTS',
  'EXTENDS',
  'READS_FROM',
  'WRITES_TO',
  'EMITS',
  'CONSUMES',
  'TESTED_BY',
  'DEPENDS_ON',
  'VIOLATES',
  'SUPERSEDES',
  'DOCUMENTED_BY',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** Outgoing implementation dependencies; ownership and documentation are not calls. */
export const DEPENDENCY_EDGE_TYPES: ReadonlySet<EdgeType> = new Set([
  'IMPORTS', 'CALLS', 'IMPLEMENTS', 'EXTENDS', 'READS_FROM', 'WRITES_TO',
  'EMITS', 'CONSUMES', 'DEPENDS_ON', 'TESTED_BY',
]);

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SUMMARY_LEVELS = ['symbol', 'file', 'module', 'repository', 'document', 'product'] as const;
export type SummaryLevel = (typeof SUMMARY_LEVELS)[number];

export const FINDING_STATUSES = ['candidate', 'confirmed', 'rejected', 'superseded'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export interface Repository {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
}

export interface Snapshot {
  id: string;
  repositoryId: string;
  commitSha: string;
  createdAt: string;
}

export interface SourceFile {
  id: string;
  repositoryId: string;
  snapshotId: string;
  path: string;
  language: string | null;
  contentHash: string;
  lineCount: number | null;
  lastAuthor: string | null;
  lastCommitAt: string | null;
}

export interface Module {
  id: string;
  repositoryId: string;
  snapshotId: string;
  name: string;
  path: string;
}

export interface TestCase {
  id: string;
  snapshotId: string;
  path: string;
  name: string;
  startLine?: number;
  endLine?: number;
  span?: SourceSpan;
  contentHash?: string;
}

/** UTF-16 offsets/columns, as exposed by web-tree-sitter; end is exclusive. */
export interface SourceSpan { startOffset: number; endOffset: number; startColumn: number; endColumn: number }

export interface CallSite { startLine: number; startColumn: number; endLine: number; endColumn: number }
export interface InheritanceSite extends CallSite { source: string; relation: 'EXTENDS' | 'IMPLEMENTS' }

export interface SymbolReference extends CallSite {
  snapshotId: string;
  targetId: string;
  sourceId: string;
  path: string;
  isDefinition: boolean;
  isCall: boolean;
  analyzer: string;
  scipSymbol: string;
}

export interface HttpRoute {
  framework: 'express' | 'nest' | 'fastapi';
  method: string;
  path: string;
  handler: string | null;
  /** Exact named handler argument, when it can be resolved by the compiler. */
  handlerLocation?: CallSite;
  /** Nested registrations require compiler binding to avoid same-name shadowing. */
  handlerScope?: 'module' | 'nested';
  /** Declared router/controller path; deployment/global prefixes are not inferred. */
  scope: 'declared';
}

export interface ExportBinding {
  id: string;
  snapshotId: string;
  path: string;
  exportedName: string;
  localName: string | null;
  sourceModule: string | null;
  typeOnly: boolean;
  startLine: number;
  symbolId: string | null;
}

export interface Metric {
  snapshotId: string;
  subjectId: string;
  name: string;
  value: number;
  analyzer: string;
}

export interface QualityIssue {
  id: string;
  snapshotId: string;
  analyzer: string;
  ruleId: string;
  message: string;
  locations: { path: string; startLine: number; endLine: number }[];
  details: Record<string, unknown>;
}

export interface CoverageRecord {
  snapshotId: string;
  path: string;
  lineRate: number | null;
  branchRate: number | null;
  analyzer: string;
  sourceHash: string;
  lines: { line: number; hits: number }[];
  provenance: Record<string, unknown>;
}

export interface CodeSymbol {
  id: string;
  repositoryId: string;
  snapshotId: string;
  path: string;
  qualifiedName: string;
  kind: SymbolKind;
  signature: string | null;
  /** Explicit language member accessibility; absent when not extracted. */
  visibility?: 'public' | 'protected' | 'private';
  startLine: number;
  endLine: number;
  span?: SourceSpan;
  route?: HttpRoute;
  contentHash: string;
  /** Analizador que lo extrajo: tree-sitter, scip, joern, … */
  source: string;
}

export interface Edge {
  snapshotId: string;
  sourceId: string;
  targetId: string;
  edgeType: EdgeType;
  confidence: number;
  analyzer: string;
  evidence: unknown;
}

export interface Finding {
  id: string;
  snapshotId: string;
  repositoryId: string;
  ruleId: string;
  severity: Severity;
  confidence: number;
  claim: string;
  recommendation: string | null;
  module: string | null;
  status: FindingStatus;
  supersededBy: string | null;
  createdAt: string;
}

export interface Evidence {
  id: string;
  ownerId: string;
  ownerKind: 'finding' | 'summary' | 'opportunity';
  path: string;
  startLine: number | null;
  endLine: number | null;
  excerpt: string | null;
}

/** Deterministic, snapshot-bound suggestions; effort and business impact are not inferred. */
export interface ImprovementOpportunity {
  id: string;
  snapshotId: string;
  module: string | null;
  title: string;
  description: string;
  priority: number;
  subjectId: string | null;
  sourceKind: 'finding' | 'hotspot';
  sourceId: string;
  details: Record<string, unknown>;
  analyzer: string;
  inputHash: string;
  createdAt: string;
}

export interface SummaryDoc {
  id: string;
  snapshotId: string;
  subjectId: string;
  level: SummaryLevel;
  contentJson: string;
  model: string;
  promptVersion: string;
  contentHash: string;
  createdAt: string;
}

export interface KnowledgeDocument {
  id: string;
  snapshotId: string;
  repositoryId: string;
  path: string;
  title: string;
  content: string;
  contentHash: string;
}

export const KNOWLEDGE_KINDS = ['symbol', 'summary', 'finding', 'document', 'test'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/** Search projection derived only from one SQLite snapshot; vector payloads never supply its text. */
export interface KnowledgeItem {
  id: string;
  snapshotId: string;
  repositoryId: string;
  subjectId: string;
  entityKind: KnowledgeKind;
  kind: string;
  title: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
  language: string | null;
  module: string | null;
  modulePath: string | null;
  text: string;
  contentHash: string;
  sourceComplete: boolean;
  evidenceIds: string[];
}

/** Immutable, content-addressed provenance shared by cached summaries. */
export interface EvidenceRecord {
  id: string;
  kind: 'source' | 'symbol' | 'file' | 'module' | 'repository' | 'document' | 'product';
  path: string;
  startLine: number | null;
  endLine: number | null;
  contentHash: string;
  /** Evidence records supporting this derived record. Empty for indexed source. */
  parentIds: string[];
}
