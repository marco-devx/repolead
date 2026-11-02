import type { CodeSymbol, EvidenceRecord, SourceFile, SummaryDoc, SummaryLevel } from '@repolead/domain';
import { contentHash, sliceSource, DEFAULT_SOURCE_LINES } from '@repolead/domain';
import type { CodeGraph, KnowledgeStore } from '@repolead/knowledge-store';
import { countTokens, readSnapshotSource, validateTokenBudget } from '@repolead/retrieval';

import { buildDependencyIndex } from './dependencies';
import type { DependencyIndex } from './dependencies';

export interface EvidenceEntry {
  record: EvidenceRecord;
  facts: unknown;
}

export interface SummaryCacheBinding { fingerprint: string; evidenceIds: string[] }

export interface HierarchicalPack {
  subject: { id: string; name: string; level: SummaryLevel; path?: string };
  fingerprint: string;
  evidence: { id: string; kind: string; path: string; startLine: number | null; endLine: number | null; facts: unknown }[];
  truncation: { omittedEvidence: number; omittedSourceLines: number };
  unknowns: string[];
}

export function evidenceEntry(
  kind: EvidenceRecord['kind'], path: string, facts: unknown,
  location: { startLine?: number; endLine?: number; parentIds?: string[] } = {},
): EvidenceEntry {
  const hash = contentHash(JSON.stringify({ kind, path, facts, ...location }));
  return { record: { id: `ev_${hash}`, kind, path, startLine: location.startLine ?? null,
    endLine: location.endLine ?? null, contentHash: hash, parentIds: location.parentIds ?? [] }, facts };
}

export function summaryEntry(summary: SummaryDoc, path: string): EvidenceEntry {
  const content = JSON.parse(summary.contentJson) as unknown;
  const refs = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') { return; }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'evidenceIds' && Array.isArray(item)) {
        item.filter((id): id is string => typeof id === 'string').forEach((id) => refs.add(id));
      } else if (Array.isArray(item)) { item.forEach(visit); }
      else { visit(item); }
    }
  };
  visit(content);
  return evidenceEntry(summary.level, path, { subjectId: summary.subjectId, content, fingerprint: summary.contentHash },
    { parentIds: [...refs].sort() });
}

/** Interleave child sections so a large first dossier cannot hide every later child. */
export function summaryEntries(children: { summary: SummaryDoc; path: string }[]): EvidenceEntry[] {
  const withoutCitations = (value: unknown, refs: Set<string>): unknown => {
    if (typeof value === 'string') { return value.replace(/ev_[a-f0-9]{64}/g, (id) => refs.has(id) ? '[child evidence]' : id); }
    if (Array.isArray(value)) { return value.map((entry) => withoutCitations(entry, refs)); }
    if (!value || typeof value !== 'object') { return value; }
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'evidenceIds').map(([key, item]) => [key, withoutCitations(item, refs)]));
  };
  const groups = children.map(({ summary, path }) => {
    const parent = summaryEntry(summary, path);
    const content = JSON.parse(summary.contentJson) as Record<string, unknown>;
    return Object.entries(content).filter(([section]) => section !== 'evidenceIds').flatMap(([section, value]) => {
      const pieces = Array.isArray(value) && value.length ? value : [value];
      return pieces.map((piece, index) => evidenceEntry(summary.level, path, {
        subjectId: summary.subjectId, section, index, value: withoutCitations(piece, new Set(parent.record.parentIds)), fingerprint: summary.contentHash,
      }, { parentIds: piece && typeof piece === 'object' && 'evidenceIds' in piece && Array.isArray(piece.evidenceIds)
        ? piece.evidenceIds.filter((id: unknown): id is string => typeof id === 'string') : parent.record.parentIds }));
    });
  });
  const result: EvidenceEntry[] = [];
  for (let index = 0; groups.some((group) => index < group.length); index += 1) {
    for (const group of groups) { if (group[index]) { result.push(group[index]!); } }
  }
  return result;
}

export function listSourceFiles(store: KnowledgeStore, snapshotId: string): SourceFile[] {
  const rows = store.db.prepare('SELECT * FROM files WHERE snapshot_id = ? ORDER BY path')
    .all(snapshotId) as { id: string; repository_id: string; snapshot_id: string; path: string; language: string | null;
      content_hash: string; line_count: number | null; last_author: string | null; last_commit_at: string | null }[];
  return rows.map((row) => ({ id: row.id, repositoryId: row.repository_id, snapshotId: row.snapshot_id,
    path: row.path, language: row.language, contentHash: row.content_hash, lineCount: row.line_count,
    lastAuthor: row.last_author, lastCommitAt: row.last_commit_at }));
}

/** Documentation has its own complete document cards; binary/unknown formats remain indexed facts. */
export function technicalFiles(store: KnowledgeStore, snapshotId: string, files = listSourceFiles(store, snapshotId)): SourceFile[] {
  const documents = new Set(store.listDocuments(snapshotId).map((document) => document.path));
  return files.filter((file) => file.language !== null && !documents.has(file.path));
}

export function dependencyUnknowns(scope: ReturnType<DependencyIndex['forSubjects']>): string[] {
  return [
    ...(scope.beyondDepth ? [`${scope.beyondDepth} dependency targets lie beyond max_reanalysis_depth=${scope.maxDepth}; changes beyond this boundary are not tracked for this subject.`] : []),
    ...(scope.unresolvedTargets ? [`${scope.unresolvedTargets} indexed dependency targets have no captured content.`] : []),
    ...(scope.resolution === 'file-import-fallback' && (scope.dependencies.length || scope.beyondDepth)
      ? ['Compiler references are unavailable for this symbol; file imports conservatively determine dependency invalidation.'] : []),
  ];
}

export function fitHierarchyPack(
  subject: HierarchicalPack['subject'], entries: EvidenceEntry[], maxTokens: number,
  options: { fingerprint?: unknown; omittedSourceLines?: number; unknowns?: string[] } = {},
): { pack: HierarchicalPack; evidence: EvidenceRecord[]; cacheBinding?: SummaryCacheBinding } {
  validateTokenBudget(maxTokens);
  const pack: HierarchicalPack = {
    subject, fingerprint: contentHash(JSON.stringify({ evidence: entries.map((entry) => entry.record.id), extra: options.fingerprint })),
    evidence: [], truncation: { omittedEvidence: entries.length, omittedSourceLines: options.omittedSourceLines ?? 0 },
    unknowns: options.unknowns ?? [],
  };
  const evidence: EvidenceRecord[] = [];
  const fits = (): boolean => countTokens(JSON.stringify(pack)) <= maxTokens;
  if (!fits()) { throw new Error(`Insufficient token budget for ${subject.name} metadata.`); }
  for (const entry of entries) {
    const { record, facts } = entry;
    pack.evidence.push({ id: record.id, kind: record.kind, path: record.path,
      startLine: record.startLine, endLine: record.endLine, facts });
    pack.truncation.omittedEvidence -= 1;
    if (!fits()) {
      pack.evidence.pop();
      pack.truncation.omittedEvidence += 1;
    } else { evidence.push(record); }
  }
  return { pack, evidence };
}

export function buildSymbolPack(store: KnowledgeStore, snapshotId: string, rootPath: string,
  symbol: CodeSymbol, maxTokens: number, maxSourceLines = DEFAULT_SOURCE_LINES, loadedGraph?: CodeGraph,
  dependencies?: DependencyIndex, maxReanalysisDepth = 3) {
  const graph = loadedGraph ?? store.loadGraph(snapshotId);
  const dependencyScope = (dependencies ?? buildDependencyIndex(store, snapshotId, graph, listSourceFiles(store, snapshotId)))
    .forSubjects([symbol.id], maxReanalysisDepth);
  const relations = [...(graph.incoming.get(symbol.id) ?? []), ...(graph.outgoing.get(symbol.id) ?? [])]
    .filter((edge) => edge.edgeType !== 'CONTAINS')
    .map((edge) => ({ from: graph.symbols.get(edge.sourceId)?.qualifiedName ?? edge.sourceId,
      to: graph.symbols.get(edge.targetId)?.qualifiedName ?? edge.targetId, type: edge.edgeType, analyzer: edge.analyzer }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const sourceLines = symbol.endLine - symbol.startLine + 1;
  const subject = { id: symbol.id, name: symbol.qualifiedName, level: 'symbol' as const, path: symbol.path };
  const quality = store.qualityFacts(snapshotId, symbol.id, symbol.path, symbol);
  const metadata = evidenceEntry('symbol', symbol.path, {
    quality,
    name: symbol.qualifiedName, kind: symbol.kind, signature: symbol.signature, contentHash: symbol.contentHash,
    ...(symbol.route ? { route: symbol.route } : {}),
    exports: store.listExports(snapshotId, symbol.path).filter((entry) => entry.symbolId === symbol.id)
      .map(({ snapshotId: _snapshotId, ...entry }) => entry),
  }, { startLine: symbol.startLine, endLine: symbol.endLine });
  const relationEntry = evidenceEntry('symbol', symbol.path, {
    outgoingDependencies: relations.filter((edge) => edge.from === symbol.qualifiedName),
    incomingConsumers: relations.filter((edge) => edge.to === symbol.qualifiedName), dependencyScope });
  const fingerprint = { body: symbol.contentHash, relations, dependencies: dependencyScope.fingerprint, quality };
  // Only explicitly understood source/metadata coordinates are removed from the
  // semantic cache identity. Quality reports and dependency facts remain exact.
  const bind = (result: ReturnType<typeof fitHierarchyPack>): ReturnType<typeof fitHierarchyPack> => {
    const semanticFacts = (entry: HierarchicalPack['evidence'][number]) => {
      const facts = entry.facts as Record<string, unknown>;
      if (entry.kind === 'source' && typeof facts['source'] === 'string') {
        return { ...facts, source: facts['source'].split('\n').map((line, index) => `${index + 1}\t${line.replace(/^\d+\t/, '')}`).join('\n') };
      }
      if (entry.kind === 'symbol' && Array.isArray(facts['exports'])) {
        return { ...facts, exports: facts['exports'].map((value: Record<string, unknown>) => {
          const { id: _id, startLine: _line, ...binding } = value;
          return binding;
        }) };
      }
      return facts;
    };
    const semanticMetadata = semanticFacts({ id: metadata.record.id, kind: 'symbol', path: symbol.path,
      startLine: symbol.startLine, endLine: symbol.endLine, facts: metadata.facts });
    return { ...result, cacheBinding: { evidenceIds: result.pack.evidence.map((entry) => entry.id),
      fingerprint: contentHash(JSON.stringify({ version: 'symbol-relocation-v1', subject, fingerprint, semanticMetadata,
        truncation: result.pack.truncation, unknowns: result.pack.unknowns,
        evidence: result.pack.evidence.map((entry) => ({ kind: entry.kind, path: entry.path,
          // Relative spans preserve distinctions between excerpts within the body.
          startLine: entry.startLine === null ? null : entry.startLine - symbol.startLine,
          endLine: entry.endLine === null ? null : entry.endLine - symbol.startLine, facts: semanticFacts(entry) })) })) } };
  };
  const unknowns = dependencyUnknowns(dependencyScope);
  let lines: string[];
  try {
    lines = sliceSource(readSnapshotSource(store, snapshotId, rootPath, symbol.path), symbol).split('\n');
  } catch {
    return fitHierarchyPack(subject, [metadata, relationEntry], maxTokens, {
      fingerprint, omittedSourceLines: sourceLines,
      unknowns: [...unknowns, 'Source unavailable or changed since indexing. This card can describe indexed structure only; refresh before analyzing behavior.'],
    });
  }
  // Whole-line prefix only; omission counts prevent presenting a partial body as complete.
  let lower = 1;
  let upper = Math.min(lines.length, maxSourceLines);
  let best = fitHierarchyPack(subject, [metadata, relationEntry], maxTokens,
    { fingerprint, omittedSourceLines: sourceLines, unknowns });
  while (lower <= upper) {
    const retained = Math.floor((lower + upper) / 2);
    const source = evidenceEntry('source', symbol.path, { name: symbol.qualifiedName,
      signature: symbol.signature, contentHash: symbol.contentHash, complete: retained === sourceLines,
      source: lines.slice(0, retained).map((line, index) => `${symbol.startLine + index}\t${line}`).join('\n') },
    { startLine: symbol.startLine, endLine: symbol.startLine + retained - 1 });
    const candidate = fitHierarchyPack(subject, [source, metadata, relationEntry], maxTokens,
      { fingerprint, omittedSourceLines: sourceLines - retained, unknowns });
    if (candidate.evidence.some((entry) => entry.id === source.record.id)) {
      best = candidate;
      lower = retained + 1;
    } else { upper = retained - 1; }
  }
  return bind(best);
}

/** Analyze file-level code and configuration without resending bodies covered by symbol cards. */
export function buildFilePack(store: KnowledgeStore, snapshotId: string, rootPath: string, file: SourceFile,
  symbols: CodeSymbol[], children: SummaryDoc[], maxTokens: number, maxSourceLines = DEFAULT_SOURCE_LINES,
  loadedGraph?: CodeGraph, dependencies?: DependencyIndex, maxReanalysisDepth = 3, unknowns: string[] = []) {
  const graph = loadedGraph ?? store.loadGraph(snapshotId);
  const scope = (dependencies ?? buildDependencyIndex(store, snapshotId, graph, listSourceFiles(store, snapshotId)))
    .forSubjects([file.id], maxReanalysisDepth);
  const quality = store.qualityFacts(snapshotId, file.id, file.path);
  const facts = evidenceEntry('file', file.path, { path: file.path, language: file.language, contentHash: file.contentHash,
    quality,
    lineCount: file.lineCount, exports: store.listExports(snapshotId, file.path).map(({ snapshotId: _snapshotId, ...entry }) => entry),
    dependencyScope: scope,
    relations: [...(graph.incoming.get(file.id) ?? []), ...(graph.outgoing.get(file.id) ?? [])]
      .filter((edge) => edge.edgeType !== 'CONTAINS')
      .map((edge) => ({ from: edge.sourceId, to: edge.targetId, type: edge.edgeType, analyzer: edge.analyzer })) });
  const childEntries = summaryEntries(children.map((summary) => ({ summary, path: file.path })));
  const subject = { id: file.id, name: file.path, path: file.path, level: 'file' as const };
  const fingerprint = { body: file.contentHash, dependencies: scope.fingerprint, quality };
  const notes = [...unknowns, ...dependencyUnknowns(scope)];
  let source: string;
  try { source = readSnapshotSource(store, snapshotId, rootPath, file.path); }
  catch {
    return fitHierarchyPack(subject, [facts, ...childEntries], maxTokens, { fingerprint, unknowns: [...notes,
      'File source unavailable or changed since indexing; top-level behavior and configuration cannot be verified.'],
      omittedSourceLines: file.lineCount ?? 0 });
  }
  const starts = [0];
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) { starts.push(at + 1); }
  const covered = new Set(children.map((child) => child.subjectId));
  const spans = symbols.filter((symbol) => covered.has(symbol.id)).map((symbol) => symbol.span
    ? [symbol.span.startOffset, symbol.span.endOffset] as const
    : [starts[symbol.startLine - 1] ?? source.length, starts[symbol.endLine] ?? source.length] as const)
    .sort((a, b) => a[0] - b[0]);
  const gaps: { start: number; line: number; lines: string[] }[] = [];
  const addGap = (start: number, end: number) => {
    const text = source.slice(start, end);
    if (!text.trim()) { return; }
    let left = 0; let right = starts.length;
    while (left < right) { const mid = (left + right) >>> 1; if (starts[mid]! <= start) { left = mid + 1; } else { right = mid; } }
    gaps.push({ start, line: left, lines: text.split('\n') });
  };
  let position = 0;
  for (const [start, end] of spans) {
    if (start > position) { addGap(position, start); }
    position = Math.max(position, end);
  }
  if (position < source.length) { addGap(position, source.length); }
  const lineCount = gaps.reduce((total, gap) => total + gap.lines.length, 0);
  const packFor = (retained: number) => {
    let remaining = retained;
    const entries: EvidenceEntry[] = [];
    for (const gap of gaps) {
      if (!remaining) { break; }
      const length = Math.min(remaining, gap.lines.length);
      const text = gap.lines.slice(0, length).join('\n');
      entries.push(evidenceEntry('source', file.path, { scope: 'outside_symbol_cards', source: text,
        startOffset: gap.start, endOffset: gap.start + text.length, complete: length === gap.lines.length },
      { startLine: gap.line, endLine: gap.line + length - 1 }));
      remaining -= length;
    }
    const packed = fitHierarchyPack(subject, [facts, ...entries, ...childEntries], maxTokens,
      { fingerprint, unknowns: notes, omittedSourceLines: lineCount - retained });
    return { packed, fits: entries.every((entry) => packed.evidence.some((kept) => kept.id === entry.record.id)) };
  };
  let best = packFor(0).packed;
  let lower = 1; let upper = Math.min(lineCount, maxSourceLines);
  while (lower <= upper) {
    const retained = Math.floor((lower + upper) / 2);
    const candidate = packFor(retained);
    if (candidate.fits) { best = candidate.packed; lower = retained + 1; }
    else { upper = retained - 1; }
  }
  return best;
}
