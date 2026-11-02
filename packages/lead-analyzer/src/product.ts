import type { KnowledgeDocument, SummaryDoc } from '@repolead/domain';
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_SOURCE_LINES } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import { validateTokenBudget } from '@repolead/retrieval';

import { analyzeSubject } from './analyze';
import type { AnalyzeOptions } from './analyze';
import { evidenceEntry, fitHierarchyPack, summaryEntries } from './hierarchy';
import type { EvidenceEntry } from './hierarchy';
import { analysisBatchSize, BatchedTechLeadModel, forAnalysisBatches } from './batched-model';
import { packetFits, packetLimits, synthesizeComplete } from './bounded-synthesis';

type Packed = ReturnType<typeof fitHierarchyPack>;

/** Cover the complete document with bounded, whole-line packs. No silent tail loss. */
export function buildDocumentPacks(document: KnowledgeDocument, maxTokens: number, maxLines = DEFAULT_SOURCE_LINES, maxBytes?: number): Packed[] {
  validateTokenBudget(maxTokens);
  if (!Number.isInteger(maxLines) || maxLines < 1) { throw new Error('Document maxLines must be a positive integer.'); }
  const lines = document.content.split('\n');
  const packs: Packed[] = [];
  let start = 0;
  while (start < lines.length) {
    const packFor = (end: number): Packed => {
      const source = evidenceEntry('document', document.path, { title: document.title,
        content: lines.slice(start, end).map((line, offset) => `${start + offset + 1}\t${line}`).join('\n') },
      { startLine: start + 1, endLine: end });
      return fitHierarchyPack({ id: `${document.id}#lines:${start + 1}-${end}`, name: `${document.path}:${start + 1}-${end}`,
        level: 'document', path: document.path }, [source], maxTokens);
    };
    let lower = start + 1;
    let upper = Math.min(lines.length, start + maxLines);
    let best: { end: number; packed: Packed } | null = null;
    while (lower <= upper) {
      const end = Math.floor((lower + upper) / 2);
      const packed = packFor(end);
      if (packed.evidence.length && (maxBytes === undefined || packetFits(packed, packetLimits(maxTokens, maxBytes)))) { best = { end, packed }; lower = end + 1; }
      else { upper = end - 1; }
    }
    if (!best) { throw new Error(`Documentation line ${document.path}:${start + 1} cannot fit the analysis budget. Increase max_tokens or split this long line.`); }
    // Prefer a section boundary if it retains at least half the available span.
    for (let boundary = best.end - 1; boundary > start + (best.end - start) / 2; boundary -= 1) {
      if (/^#{1,6}\s/.test(lines[boundary]!)) { best = { end: boundary, packed: packFor(boundary) }; break; }
    }
    packs.push(best.packed);
    start = best.end;
  }
  if (packs.length === 1) {
    packs[0]!.pack.subject.id = document.id;
    packs[0]!.pack.subject.name = document.path;
  }
  return packs;
}

function linkedTechnicalEvidence(store: KnowledgeStore, snapshotId: string, document: KnowledgeDocument): EvidenceEntry[] {
  const graph = store.loadGraph(snapshotId);
  const links = (graph.incoming.get(document.id) ?? []).filter((edge) => edge.edgeType === 'DOCUMENTED_BY');
  const entries: EvidenceEntry[] = [];
  for (const edge of links) {
    const symbol = graph.symbols.get(edge.sourceId);
    const summary = store.getSummary(snapshotId, edge.sourceId, symbol ? 'symbol' : 'file');
    const filePath = (edge.evidence as { targetPath?: string })?.targetPath ?? document.path;
    if (summary) { entries.push(...summaryEntries([{ summary, path: symbol?.path ?? filePath }])); }
    entries.push(evidenceEntry('document', document.path, { explicitLink: edge.evidence,
      linkedSymbols: symbol ? [{ id: symbol.id, name: symbol.qualifiedName, path: symbol.path }] : [],
      implementedBehaviorVerified: false }));
  }
  return entries;
}

export interface ProductAnalysisResult {
  documentsAnalyzed: number;
  documentsCached: number;
  productCached: boolean;
  inputTokens: number;
  outputTokens: number;
}

export async function analyzeProductContext(options: AnalyzeOptions): Promise<ProductAnalysisResult> {
  if (options.moduleFilter) { throw new Error('Product context is repository-wide; omit the module filter.'); }
  const { store, snapshotId } = options;
  const snapshot = store.getSnapshot(snapshotId);
  const repository = snapshot ? store.getRepository(snapshot.repositoryId) : null;
  if (!repository) { throw new Error('Unknown repository snapshot.'); }
  const maxTokens = validateTokenBudget(options.budget?.maxTokens ?? DEFAULT_CONTEXT_TOKENS);
  const limits = options.analysisMode === 'files' ? packetLimits(maxTokens, options.budget?.filePackBytes) : null;
  const batchSize = analysisBatchSize(options.budget?.batchSize);
  const model = batchSize > 1 ? new BatchedTechLeadModel(options.model, batchSize) : options.model;
  const documents = store.listDocuments(snapshotId);
  const prepared = documents.map((document) => {
    const packs = buildDocumentPacks(document, maxTokens, options.budget?.maxSourceLinesPerPack ?? DEFAULT_SOURCE_LINES, limits?.maxBytes);
    const links = linkedTechnicalEvidence(store, snapshotId, document);
    if (packs.length === 1 && links.length > 0) {
      packs[0]!.pack.subject.id = `${document.id}#lines:1-${document.content.split('\n').length}`;
    }
    return { document, packs, links };
  });
  const total = prepared.reduce((count, entry) => count + entry.packs.length + (entry.packs.length > 1 || entry.links.length ? 1 : 0), 1);
  const result: ProductAnalysisResult = { documentsAnalyzed: 0, documentsCached: 0, productCached: false, inputTokens: 0, outputTokens: 0 };
  let index = 0;
  const run = async (input: Packed): Promise<SummaryDoc> => {
    const start = Date.now();
    const outcome = await analyzeSubject({ ...options, model, policyVersion: options.policyVersion ?? 'product-provenance-v1' }, input.pack, input.evidence);
    if (input.pack.subject.level === 'product') { result.productCached = outcome.cached; }
    else { result[outcome.cached ? 'documentsCached' : 'documentsAnalyzed'] += 1; }
    result.inputTokens += outcome.inputTokens;
    result.outputTokens += outcome.outputTokens;
    options.onProgress?.({ subject: input.pack.subject.name, level: input.pack.subject.level,
      outcome: outcome.cached ? 'cached' : 'analyzed', durationMs: Date.now() - start, index: ++index, total: Math.max(total, index) });
    return outcome.summary;
  };
  const sections = new Map<string, SummaryDoc>();
  await forAnalysisBatches(prepared.flatMap((entry) => entry.packs), batchSize, async (input) => {
    sections.set(input.pack.subject.id, await run(input));
  });
  const documentsById = new Map<string, SummaryDoc>();
  await forAnalysisBatches(prepared, batchSize, async ({ document, packs, links }) => {
    const children = packs.map((pack) => sections.get(pack.pack.subject.id)!);
    let summary = children[0]!;
    if (packs.length > 1 || links.length > 0) {
      const entries = [...summaryEntries(children.map((child) => ({ summary: child, path: document.path }))), ...links];
      const subject = { id: document.id, name: document.path, path: document.path, level: 'document' as const };
      const notes = { fingerprint: document.contentHash, unknowns: uncertainty(children) };
      summary = limits ? await synthesizeComplete(subject, entries, limits, run, notes)
        : await run(fitHierarchyPack(subject, entries, maxTokens, notes));
    }
    documentsById.set(document.id, summary);
  });
  const cards = prepared.map(({ document }) => ({ summary: documentsById.get(document.id)!, path: document.path }));
  const technical = store.listSummaries(snapshotId, 'repository').filter((summary) => !summary.subjectId.includes('#synthesis:'));
  const metadata = evidenceEntry('repository', '.', { repository: repository.name, documentPaths: documents.map((document) => document.path),
    technicalBriefAvailable: technical.length > 0 });
  const unknowns = [
    ...(!documents.length ? ['No product documentation was indexed. Product intent, roles and requirements remain unknown unless supported by supplied evidence.'] : []),
    ...(!technical.length ? ['No technical brief exists for this snapshot. Documentation is not proof of implemented behavior.'] : []),
    ...uncertainty([...cards.map((entry) => entry.summary), ...technical]),
    ...(JSON.parse(store.getSnapshotMetadata(snapshotId, 'documentation_omissions') ?? '[]') as string[]).map((entry) => `Documentation not indexed: ${entry}`),
  ];
  const subject = { id: `product://${repository.name}`, name: 'Product Context', level: 'product' as const };
  const entries = [...summaryEntries(cards), ...summaryEntries(technical.map((summary) => ({ summary, path: '.' }))), metadata];
  const notes = { fingerprint: documents.map((document) => [document.id, document.contentHash]), unknowns };
  if (limits) { await synthesizeComplete(subject, entries, limits, run, notes); }
  else { await run(fitHierarchyPack(subject, entries, maxTokens, notes)); }
  store.rebuildSearchIndex(snapshotId);
  return result;
}

function uncertainty(summaries: SummaryDoc[]): string[] {
  const partial = summaries.filter((summary) => (JSON.parse(summary.contentJson) as { unknowns?: string[] }).unknowns?.length);
  return partial.length ? [`${partial.length} source dossiers contain unknowns or omitted synthesis evidence; consult their detailed records.`] : [];
}
