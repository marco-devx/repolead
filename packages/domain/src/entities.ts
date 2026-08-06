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

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SUMMARY_LEVELS = ['symbol', 'file', 'module', 'repository'] as const;
export type SummaryLevel = (typeof SUMMARY_LEVELS)[number];

export const FINDING_STATUSES = ['candidate', 'confirmed', 'rejected'] as const;
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
}

export interface Metric {
  snapshotId: string;
  subjectId: string;
  name: string;
  value: number;
  analyzer: string;
}

export interface CodeSymbol {
  id: string;
  repositoryId: string;
  snapshotId: string;
  path: string;
  qualifiedName: string;
  kind: SymbolKind;
  signature: string | null;
  startLine: number;
  endLine: number;
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
