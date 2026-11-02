import { contentHash, sliceSource, SUMMARY_LEVELS, DEFAULT_CONTEXT_TOKENS } from '@repolead/domain';
import type { KnowledgeItem, KnowledgeKind } from '@repolead/domain';
import { meaningfulText } from '@repolead/knowledge-store';
import { hybridKnowledgeSearch } from './search';
import type { HybridSearchOptions, KnowledgeHit } from './search';
import { sourceDocument, evidenceTerms } from './source-excerpts';
import { readIndexedSource } from './source';
import { countTokens, TOKENIZER, validateTokenBudget } from './tokens';

export interface EvidenceContextOptions extends Omit<HybridSearchOptions, 'query' | 'limit'> {
  queries: string[];
  maxTokens?: number;
  includeSource?: boolean;
  includeTests?: boolean;
  types?: KnowledgeKind[];
  /** Only hashes whose complete blocks remain available in this conversation. [] enables receipts. */
  knownBlocks?: string[];
}

/** Retrieval + quoted evidence in one round trip. No generative model or persistent mutation. */
export async function buildEvidenceContext(options: EvidenceContextOptions) {
  const { store, snapshotId } = options;
  const budget = validateTokenBudget(options.maxTokens ?? DEFAULT_CONTEXT_TOKENS);
  if (options.knownBlocks !== undefined && (!Array.isArray(options.knownBlocks) || options.knownBlocks.length > 128 ||
    options.knownBlocks.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))) {
    throw new Error('knownBlocks accepts at most 128 SHA-256 receipts from complete blocks retained in this conversation.');
  }
  const knownBlocks = new Set(options.knownBlocks);
  const queries = [...new Set(options.queries.map((query) => query.trim()).filter(Boolean))];
  if (!queries.length || queries.length > 8 || queries.some((query) => query.length > 1000) || queries.join('').length > 4000) {
    throw new Error('Evidence context accepts 1–8 queries, at most 1000 characters each and 4000 combined.');
  }
  const snapshot = store.getSnapshot(snapshotId); const repository = snapshot ? store.getRepository(snapshot.repositoryId) : null;
  if (!repository) { throw new Error('Unknown repository snapshot.'); }
  const projection = store.getSnapshotMetadata(snapshotId, 'knowledge_projection');
  const kinds = options.types ?? options.filters?.entityKinds ?? (options.includeSource === false ? ['summary', 'document', 'finding'] as KnowledgeKind[] : undefined);
  const warnings = new Set<string>();
  if (!options.embeddings || !options.qdrant) { warnings.add('Vector search disabled; using lexical matches and recorded graph signals.'); }
  if (!options.reranker) { warnings.add('Reranker disabled; using fused retrieval order.'); }
  const lists: KnowledgeHit[][] = [];
  // Bound service concurrency independently of the model/client tool-call budget.
  for (let index = 0; index < queries.length; index += 2) {
    lists.push(...await Promise.all(queries.slice(index, index + 2).map((query) => hybridKnowledgeSearch({ ...options, query, limit: 4,
      candidateLimit: options.candidateLimit ?? 40, filters: { ...options.filters, entityKinds: kinds,
        excludeTests: !(options.includeTests ?? options.types?.includes('test') ?? false) },
      onWarning: (message) => { warnings.add(message); options.onWarning?.(message); } }))));
  }
  const candidates = new Map<string, { item: KnowledgeItem; queries: number[] }>();
  for (let rank = 0; rank < 4; rank += 1) {
    for (const [query, list] of lists.entries()) {
      const hit = list[rank]; if (!hit) { continue; }
      const existing = candidates.get(hit.item.id);
      if (existing) { existing.queries.push(query); } else { candidates.set(hit.item.id, { item: hit.item, queries: [query] }); }
    }
  }
  const files = new Map(store.listFiles(snapshotId).map((file) => [file.path, file]));
  const documents = new Map(store.listDocuments(snapshotId).map((doc) => [doc.id, doc]));
  const sourceFiles = new Map<string, { source: string; parsed: Awaited<ReturnType<typeof sourceDocument>> }>();
  const fileDeclarations = new Set<string>();
  const included: { id: string; queries: number[]; text: string; partial: boolean; hash: string; reused: boolean }[] = [];
  const omitted: { id: string; reason: string }[] = [];
  const sectionBudget = Math.max(256, Math.floor(budget / Math.max(4, candidates.size)));
  const locations = (ids: string[]) => {
    const queue = [...ids]; const seen = new Set<string>(); const refs = new Set<string>();
    while (queue.length && seen.size < 256) {
      const id = queue.shift()!; if (seen.has(id)) { continue; } seen.add(id);
      const record = store.getEvidenceRecord(id); if (!record) { continue; }
      if (record.startLine && record.endLine && record.startLine <= record.endLine) {
        const file = files.get(record.path);
        const document = [...documents.values()].find((doc) => doc.path === record.path);
        if ((file?.lineCount != null && record.endLine <= file.lineCount) || (document && record.endLine <= document.content.split('\n').length)) {
          refs.add(`${record.path}:${record.startLine}-${record.endLine}`);
        }
      }
      queue.push(...record.parentIds);
    }
    const values = [...refs].sort();
    return `${values.slice(0, 8).join(', ') || 'no source coordinates recorded'}${values.length > 8 || queue.length ? ' [additional provenance omitted]' : ''}`;
  };
  const memory = (item: KnowledgeItem, query: string): { text: string; partial: boolean } => {
    const level = SUMMARY_LEVELS.find((value) => value === item.kind);
    const summary = level ? store.getSummary(snapshotId, item.subjectId, level) : null;
    if (!summary) { throw new Error('Summary unavailable in the selected snapshot.'); }
    const content = JSON.parse(summary.contentJson) as Record<string, unknown>;
    if (contentHash(`${summary.level} knowledge\n${meaningfulText(content)}`) !== item.contentHash) { throw new Error('Summary search projection changed; rebuild the search index.'); }
    const allRefs = new Set(item.evidenceIds);
    const terms = evidenceTerms(query);
    const clauses = Object.entries(content).filter(([key]) => !['evidenceIds', 'symbolIds'].includes(key)).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map((part) => {
        const ids: string[] = part && typeof part === 'object' && 'evidenceIds' in part && Array.isArray(part.evidenceIds)
          ? part.evidenceIds.filter((id: unknown): id is string => typeof id === 'string') : item.evidenceIds;
        ids.forEach((id) => allRefs.add(id));
        const text = meaningfulText(part);
        return { key, text, ids, rank: ['unknowns', 'purpose', 'objective'].includes(key) ? 1000 : terms.filter((term) => text.toLowerCase().includes(term)).length };
      }));
    const compact = (value: string) => value.replace(/\bev_[a-f0-9]{64}\b/g, (id) => allRefs.has(id) ? '[recorded evidence]' : id);
    const chosen: string[] = [];
    for (const clause of clauses.sort((a, b) => b.rank - a.rank)) {
      const text = `${clause.key}: ${compact(clause.text)}\n  Recorded provenance: ${locations(clause.ids)}`;
      if (countTokens([...chosen, text].join('\n')) <= sectionBudget) { chosen.push(text); }
    }
    return { text: `MEMORY ${summary.level} ${item.title}; model ${summary.model}\nSnapshot-derived claims; provenance locations are not a fresh source read.\n${chosen.join('\n')}\nOmitted memory clauses: ${clauses.length - chosen.length}.`, partial: chosen.length !== clauses.length };
  };
  const render = () => [
    `RepoLead evidence ${repository.name} @${snapshotId}; budget ${budget} ${TOKENIZER} (proxy).`,
    `Knowledge types: ${(kinds ?? ['symbol', 'summary', 'document', 'finding', 'test']).join(',')}; tests ${(options.includeTests ?? options.types?.includes('test') ?? false) ? 'included' : 'excluded'}; raw source ${options.includeSource === false ? 'disabled' : 'enabled'}.`,
    'Quoted source and generated memory are distinct. Excerpts do not prove absence; inspect omitted code before making such claims. No generative call.',
    ...(options.knownBlocks !== undefined ? ['Block receipts: reuse ONLY the exact prior block still present in this conversation. UNCHANGED contains no evidence text; request again without its hash if unavailable. Receipt verifies the rendered block, not omitted code or runtime behavior.'] : []),
    ...queries.map((query, index) => `Q${index + 1} ${JSON.stringify(query.slice(0, 160))}: ${included.filter((entry) => entry.queries.includes(index)).length} evidence blocks (${lists[index]!.length} retrieved candidates).`),
    `Included ${included.length}/${candidates.size} candidates; partial blocks ${included.filter((entry) => entry.partial).length}; omitted/unavailable ${omitted.length}.`,
    ...included.map((entry, index) => `\nE${index + 1} [${entry.queries.map((query) => `Q${query + 1}`).join(',')}] ${entry.reused ? 'UNCHANGED ' : ''}${options.knownBlocks !== undefined ? `sha256=${entry.hash}\n` : ''}${entry.reused ? 'Use the retained block with this receipt.' : entry.text}`),
    ...(omitted.length ? [`Omissions: ${[...new Set(omitted.map((entry) => entry.reason))].join('; ').slice(0, 500)}`] : []),
    ...[...warnings].slice(0, 4).map((warning) => `Retrieval warning: ${warning.slice(0, 200)}`),
  ].join('\n');
  try {
    for (const candidate of candidates.values()) {
      const { item } = candidate; const query = candidate.queries.map((index) => queries[index]!).join(' ');
      try {
        let text: string; let partial = false; let declarationPath: string | null = null;
        if (item.entityKind === 'summary') {
          const result = memory(item, query); text = result.text; partial = result.partial;
        } else if (item.entityKind === 'symbol' || item.entityKind === 'test') {
          if (options.includeSource === false) { throw new Error('raw source disabled'); }
          const symbol = item.entityKind === 'symbol' ? store.getSymbol(snapshotId, item.subjectId) : store.listTests(snapshotId).find((test) => test.id === item.subjectId);
          if (!symbol?.startLine || !symbol.endLine || !item.sourceComplete) { throw new Error('indexed source span unavailable'); }
          let file = sourceFiles.get(item.path);
          if (!file) {
            const source = readIndexedSource(store, snapshotId, repository.rootPath, item.path);
            file = { source, parsed: await sourceDocument(item.path, source) }; sourceFiles.set(item.path, file);
          }
          const span = { startLine: symbol.startLine, endLine: symbol.endLine, span: symbol.span };
          if (contentHash(sliceSource(file.source, span)) !== symbol.contentHash) { throw new Error('symbol source hash mismatch'); }
          const excerpt = file.parsed.extract(span, query, sectionBudget);
          if (!excerpt.text) { throw new Error('no complete source statement fits; request a larger source range'); }
          partial = !excerpt.complete;
          const declarations = fileDeclarations.has(item.path) ? '' : file.parsed.declarations(query, Math.min(500, Math.floor(sectionBudget / 3)));
          declarationPath = declarations ? item.path : null;
          text = `${excerpt.complete ? 'SOURCE' : 'SOURCE EXCERPTS'} ${item.path}:${symbol.startLine}-${symbol.endLine} ${item.title}\nFile sha256 ${files.get(item.path)!.contentHash}; omitted symbol lines ${excerpt.omittedLines}.\n${excerpt.text}${declarations ? `\nRELATED FILE DECLARATIONS (partial) ${item.path}\n${declarations}` : ''}`;
        } else if (item.entityKind === 'document') {
          const document = documents.get(item.subjectId);
          if (!document || !item.startLine || !item.endLine) { throw new Error('document section unavailable'); }
          const lines = document.content.split('\n'); const selected: string[] = [];
          for (let line = item.startLine; line <= item.endLine; line += 1) {
            const next = `${line}\t${lines[line - 1] ?? ''}`;
            if (countTokens([...selected, next].join('\n')) > sectionBudget) { break; }
            selected.push(next);
          }
          if (!selected.length) { throw new Error('document line exceeds the evidence budget; request a larger document range'); }
          partial = selected.length < item.endLine - item.startLine + 1;
          text = `DOCUMENT ${document.path}:${item.startLine}-${item.startLine + selected.length - 1}; ${partial ? 'partial section' : 'complete section'}; documented intent is not proof of implementation.\n${selected.join('\n')}`;
        } else {
          const finding = store.getFindings(snapshotId, 'confirmed').find((value) => value.id === item.subjectId);
          if (!finding) { throw new Error('confirmed finding unavailable'); }
          const evidence = store.getEvidence(finding.id);
          text = `FINDING ${finding.ruleId} ${finding.severity}: ${finding.claim}\n${finding.recommendation ?? ''}\nEvidence: ${evidence.map((entry) => `${entry.path}:${entry.startLine ?? '?'}`).join(', ')}`;
        }
        // Validate source/projection first, even when the caller knows a prior receipt.
        // Bind to repository identity and exact rendered content, including coordinates and uncertainty.
        const hash = contentHash(JSON.stringify(['evidence-block-v1', repository.id, text]));
        const entry = { id: item.id, queries: candidate.queries, text, partial, hash, reused: knownBlocks.has(hash) };
        included.push(entry);
        // Reserve room for later omission metadata; final check still measures the complete output.
        if (countTokens(render()) > budget - Math.min(200, Math.floor(budget / 5))) {
          included.pop(); omitted.push({ id: item.id, reason: 'budget exceeded' });
        } else if (declarationPath) { fileDeclarations.add(declarationPath); }
      } catch (error) { omitted.push({ id: item.id, reason: error instanceof Error ? error.message : String(error) }); }
    }
    while (countTokens(render()) > budget && included.length) {
      omitted.push({ id: included.pop()!.id, reason: 'budget exceeded' });
    }
    if (store.getLatestSnapshot()?.id !== snapshotId || store.getSnapshotMetadata(snapshotId, 'knowledge_projection') !== projection) {
      throw new Error('Repository knowledge changed during retrieval; retry for the current snapshot.');
    }
    const text = render(); const tokens = countTokens(text);
    if (tokens > budget) { throw new Error('Evidence metadata exceeds maxTokens; request fewer queries or increase the budget.'); }
    return { text, tokens, budget, includedIds: included.map((entry) => entry.id), omitted,
      blocks: included.map(({ id, hash, partial, reused }) => ({ id, hash, partial, reused })),
      reusedBlocks: included.filter((entry) => entry.reused).length,
      queryCoverage: queries.map((_, index) => included.filter((entry) => entry.queries.includes(index)).length) };
  } finally { for (const file of sourceFiles.values()) { file.parsed.close(); } }
}
