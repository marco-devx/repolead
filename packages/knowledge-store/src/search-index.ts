import { contentHash, sliceSource } from '@repolead/domain';
import type { KnowledgeItem, Module } from '@repolead/domain';

import type { KnowledgeStore } from './store';

/** Human content only: hashes/IDs make embeddings expensive without adding conceptual meaning. */
export function meaningfulText(value: unknown): string {
  if (typeof value === 'string') { return value; }
  if (Array.isArray(value)) { return value.map(meaningfulText).filter(Boolean).join('\n'); }
  if (value && typeof value === 'object') {
    return Object.entries(value).filter(([key]) => !['evidenceIds', 'symbolIds', 'fingerprint', 'contentHash'].includes(key))
      .map(([key, child]) => `${key}: ${meaningfulText(child)}`).join('\n');
  }
  return value === null || value === undefined ? '' : String(value);
}

function evidenceIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') { return; }
    for (const [key, child] of Object.entries(entry)) {
      if (key === 'evidenceIds' && Array.isArray(child)) { child.filter((id): id is string => typeof id === 'string').forEach((id) => ids.add(id)); }
      else if (Array.isArray(child)) { child.forEach(visit); }
      else { visit(child); }
    }
  };
  visit(value);
  return [...ids];
}

export function buildKnowledgeItems(store: KnowledgeStore, snapshotId: string): KnowledgeItem[] {
  const snapshot = store.getSnapshot(snapshotId);
  if (!snapshot) { throw new Error('Unknown search snapshot.'); }
  const repository = store.getRepository(snapshot.repositoryId)!;
  const files = store.db.prepare('SELECT id, path, language FROM files WHERE snapshot_id = ?').all(snapshotId) as { id: string; path: string; language: string | null }[];
  const byFile = new Map(files.map((file) => [file.path, file]));
  const byFileId = new Map(files.map((file) => [file.id, file]));
  const sourceFiles = new Map<string, string | null>();
  const sourceFor = (path: string) => {
    if (!sourceFiles.has(path)) { sourceFiles.set(path, store.getSnapshotSource(snapshotId, path)); }
    return sourceFiles.get(path);
  };
  const modules = store.listModules(snapshotId).sort((a, b) => b.path.length - a.path.length);
  const owner = (path: string): Module | undefined => modules.find((module) => module.path === '.' || path === module.path || path.startsWith(`${module.path}/`));
  const symbols = store.listSymbols(snapshotId);
  const bySymbol = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const items: KnowledgeItem[] = [];
  const add = (input: Pick<KnowledgeItem, 'subjectId' | 'entityKind' | 'kind' | 'title' | 'path' | 'text'> & Partial<KnowledgeItem>) => {
    const module = owner(input.path);
    const text = input.text;
    items.push({ snapshotId, repositoryId: repository.id, startLine: null, endLine: null,
      language: byFile.get(input.path)?.language ?? null, module: module?.name ?? null, modulePath: module?.path ?? null,
      sourceComplete: false, evidenceIds: [], ...input,
      id: input.id ?? `ki_${contentHash(`${repository.id}\n${input.entityKind}\n${input.kind}\n${input.subjectId}`).slice(0, 32)}`,
      contentHash: contentHash(text),
    });
  };
  for (const symbol of symbols) {
    const fileSource = sourceFor(symbol.path);
    const body = fileSource === null || fileSource === undefined ? undefined : sliceSource(fileSource, symbol);
    // Legacy metadata-only snapshots remain searchable and explicitly incomplete until refreshed.
    const complete = body !== undefined && contentHash(body) === symbol.contentHash;
    add({ id: symbol.id, subjectId: symbol.id, entityKind: 'symbol', kind: symbol.kind, title: symbol.qualifiedName,
      path: symbol.path, startLine: symbol.startLine, endLine: symbol.endLine, sourceComplete: complete,
      text: `${symbol.kind} ${symbol.qualifiedName} ${symbol.signature ?? ''} — ${symbol.path}\n${complete ? body : '[Indexed symbol body unavailable; refresh this snapshot.]'}` });
  }
  for (const summary of store.listSummaries(snapshotId)) {
    const content = JSON.parse(summary.contentJson) as unknown;
    const symbol = bySymbol.get(summary.subjectId);
    const file = byFileId.get(summary.subjectId);
    const module = modules.find((entry) => entry.id === summary.subjectId);
    const evidence = store.getSummaryEvidence(summary.id);
    add({ subjectId: summary.subjectId, entityKind: 'summary', kind: summary.level,
      title: `${summary.level}: ${symbol?.qualifiedName ?? file?.path ?? module?.name ?? summary.subjectId}`,
      path: symbol?.path ?? file?.path ?? module?.path ?? evidence[0]?.path ?? '.',
      text: `${summary.level} knowledge\n${meaningfulText(content)}`, sourceComplete: true, evidenceIds: evidenceIds(content) });
  }
  for (const finding of store.getFindings(snapshotId, 'confirmed')) {
    const evidence = store.getEvidence(finding.id);
    const logicalIdentity = contentHash(JSON.stringify({ rule: finding.ruleId, claim: finding.claim,
      evidence: evidence.map((entry) => [entry.path, entry.startLine, entry.endLine, entry.excerpt]) }));
    add({ id: `ki_${contentHash(`${repository.id}\nfinding\n${logicalIdentity}`).slice(0, 32)}`,
      subjectId: finding.id, entityKind: 'finding', kind: finding.ruleId, title: finding.claim,
      path: evidence[0]?.path ?? '.', startLine: evidence[0]?.startLine ?? null, endLine: evidence[0]?.endLine ?? null,
      text: `${finding.ruleId} ${finding.severity}: ${finding.claim}\n${finding.recommendation ?? ''}\n${evidence.map((entry) => entry.excerpt ?? '').join('\n')}`,
      sourceComplete: true, evidenceIds: evidence.map((entry) => entry.id) });
  }
  for (const document of store.listDocuments(snapshotId)) {
    // Semantic sections retain the complete text without slicing a code symbol into token windows.
    const lines = document.content.split('\n');
    const boundaries = [0, ...lines.flatMap((line, index) => index > 0 && /^#{1,6}\s/.test(line) ? [index] : []), lines.length];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index]!;
      const end = boundaries[index + 1]!;
      add({ subjectId: document.id, id: `ki_${contentHash(`${document.id}\nsection\n${start}`).slice(0, 32)}`,
        entityKind: 'document', kind: 'documentation', title: `${document.title}: ${lines[start]!.replace(/^#+\s*/, '')}`,
        path: document.path, startLine: start + 1, endLine: end,
        text: `${document.title}\n${lines.slice(start, end).join('\n')}`, sourceComplete: true });
    }
  }
  const tests = store.listTests(snapshotId);
  for (const test of tests) {
    const source = sourceFor(test.path);
    const body = source && test.startLine && test.endLine ? sliceSource(source, { startLine: test.startLine, endLine: test.endLine, span: test.span }) : null;
    const complete = body !== null && contentHash(body) === test.contentHash;
    add({ subjectId: test.id, entityKind: 'test', kind: 'test', title: test.name, path: test.path,
      startLine: test.startLine ?? null, endLine: test.endLine ?? null,
      text: `test ${test.name}\n${test.path}${complete ? `\n${body}` : ''}`, sourceComplete: complete });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}
