import { contentHash, DEFAULT_CONTEXT_TOKENS, DEFAULT_SOURCE_LINES } from '@repolead/domain';
import type { SummaryDoc } from '@repolead/domain';
import { owningModule, readSnapshotSource } from '@repolead/retrieval';

import { analyzeSubject } from './analyze';
import type { AnalyzeOptions, AnalyzeResult } from './analyze';
import { packetFits, packetLimits, synthesizeComplete, synthesisEntries } from './bounded-synthesis';
import type { PackedAnalysis } from './bounded-synthesis';
import { buildDependencyIndex, validateReanalysisDepth } from './dependencies';
import { dependencyUnknowns, evidenceEntry, fitHierarchyPack, listSourceFiles, technicalFiles } from './hierarchy';

/** Full source coverage without one model generation per symbol. */
export function planFileAnalysis(options: Pick<AnalyzeOptions, 'store' | 'snapshotId' | 'budget' | 'moduleFilter'>) {
  const { store, snapshotId } = options;
  const snapshot = store.getSnapshot(snapshotId);
  const repository = snapshot && store.getRepository(snapshot.repositoryId);
  if (!repository) { throw new Error('Unknown repository snapshot.'); }
  const limits = packetLimits(options.budget?.maxTokens ?? DEFAULT_CONTEXT_TOKENS, options.budget?.filePackBytes);
  const maxLines = options.budget?.maxSourceLinesPerPack ?? DEFAULT_SOURCE_LINES;
  if (!Number.isInteger(maxLines) || maxLines < 1) { throw new Error('maxSourceLinesPerPack must be positive.'); }
  const maxDepth = validateReanalysisDepth(options.budget?.maxReanalysisDepth);
  const allModules = store.listModules(snapshotId);
  const modules = allModules.filter((module) => !options.moduleFilter || [module.name, module.path].includes(options.moduleFilter));
  if (options.moduleFilter && modules.length !== 1) { throw new Error('Unknown or ambiguous module; use its path.'); }
  const moduleIds = new Set(modules.map((module) => module.id));
  const graph = store.loadGraph(snapshotId);
  const allFiles = listSourceFiles(store, snapshotId);
  const files = technicalFiles(store, snapshotId, allFiles).filter((file) => moduleIds.has(owningModule(file.path, allModules)?.id ?? ''));
  const dependencies = buildDependencyIndex(store, snapshotId, graph, allFiles);
  const byPath = new Map<string, string[]>();
  for (const symbol of graph.symbols.values()) {
    const ids = byPath.get(symbol.path) ?? []; ids.push(symbol.id); byPath.set(symbol.path, ids);
  }
  let sourceLines = 0;
  const plans = files.map((file) => {
    // A missing source is a failure, never a successful structural-only dossier.
    const source = readSnapshotSource(store, snapshotId, repository.rootPath, file.path);
    const lines = source.split('\n'); sourceLines += lines.length;
    const scope = dependencies.forSubjects([file.id, ...(byPath.get(file.path) ?? [])], maxDepth);
    const quality = store.qualityFacts(snapshotId, file.id, file.path);
    const fingerprint = { source: contentHash(source), dependencies: scope.fingerprint, quality, mode: 'complete-files-v1' };
    const notes = dependencyUnknowns(scope);
    const facts = evidenceEntry('file', file.path, { path: file.path, language: file.language,
      lineCount: lines.length, symbolCount: byPath.get(file.path)?.length ?? 0, quality,
      dependencyScope: { maxDepth: scope.maxDepth, resolution: scope.resolution,
        unresolvedTargets: scope.unresolvedTargets, beyondDepth: scope.beyondDepth } });
    const subject = { id: file.id, name: file.path, path: file.path, level: 'file' as const };
    const packs: PackedAnalysis[] = [];
    let start = 0;
    while (start < lines.length) {
      const packFor = (end: number) => fitHierarchyPack({ ...subject,
        id: `${file.id}#lines:${start + 1}-${end}`, name: `${file.path}:${start + 1}-${end}`,
      }, [facts, evidenceEntry('source', file.path, { completeSection: true,
        source: lines.slice(start, end).map((line, index) => `${start + index + 1}\t${line}`).join('\n') },
      { startLine: start + 1, endLine: end })], limits.maxTokens, { fingerprint, unknowns: notes });
      let low = start + 1; let high = Math.min(lines.length, start + maxLines);
      let best: { end: number; packed: PackedAnalysis } | null = null;
      while (low <= high) {
        const end = Math.floor((low + high) / 2); const packed = packFor(end);
        if (packetFits(packed, limits)) { best = { end, packed }; low = end + 1; } else { high = end - 1; }
      }
      if (!best) { throw new Error(`Source line ${file.path}:${start + 1} cannot fit a complete packet; increase file_pack_bytes/max_tokens or split the long line. No source was dropped.`); }
      packs.push(best.packed); start = best.end;
    }
    if (packs.length === 1) { packs[0]!.pack.subject = subject; }
    return { file, packs, fingerprint, notes };
  });
  return { repository, allModules, modules, allFiles, files, graph, plans, limits, sourceLines,
    symbolsCovered: [...graph.symbols.values()].filter((symbol) => moduleIds.has(owningModule(symbol.path, allModules)?.id ?? '')).length };
}

export async function analyzeFiles(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { store, snapshotId, model } = options;
  const plan = planFileAnalysis(options);
  const result: AnalyzeResult = { symbolsSkipped: plan.symbolsCovered, localInputTokens: 0, localOutputTokens: 0,
    symbolsAnalyzed: 0, symbolsCached: 0, filesAnalyzed: 0, filesCached: 0, modulesAnalyzed: 0, modulesCached: 0,
    briefGenerated: false, briefCached: false, inputTokens: 0, outputTokens: 0 };
  const minimumTasks = plan.plans.reduce((n, p) => n + p.packs.length + (p.packs.length > 1 ? 1 : 0), 0)
    + plan.modules.length + (options.moduleFilter ? 0 : 1);
  let index = 0;
  const run = async (input: PackedAnalysis): Promise<SummaryDoc> => {
    const started = Date.now(); const outcome = await analyzeSubject(options, input.pack, input.evidence);
    const level = input.pack.subject.level;
    if (level === 'repository') { result.briefCached = outcome.cached; result.briefGenerated = !outcome.cached; }
    else if (level === 'file') { result[outcome.cached ? 'filesCached' : 'filesAnalyzed'] += 1; }
    else { result[outcome.cached ? 'modulesCached' : 'modulesAnalyzed'] += 1; }
    result.inputTokens += outcome.inputTokens; result.outputTokens += outcome.outputTokens;
    if (model.locality === 'local') { result.localInputTokens += outcome.inputTokens; result.localOutputTokens += outcome.outputTokens; }
    options.onProgress?.({ subject: input.pack.subject.name, level, outcome: outcome.cached ? 'cached' : 'analyzed',
      durationMs: Date.now() - started, index: ++index, total: Math.max(minimumTasks, index) });
    return outcome.summary;
  };
  const dossiers: { summary: SummaryDoc; path: string }[] = [];
  for (const { file, packs, fingerprint, notes } of plan.plans) {
    const children: SummaryDoc[] = [];
    for (const pack of packs) { children.push(await run(pack)); }
    const summary = children.length === 1 ? children[0]! : await synthesizeComplete(
      { id: file.id, name: file.path, path: file.path, level: 'file' },
      synthesisEntries(children.map((summary) => ({ summary, path: file.path })), plan.limits), plan.limits, run,
      { fingerprint, unknowns: notes });
    dossiers.push({ summary, path: file.path });
  }
  const moduleCards: { summary: SummaryDoc; path: string }[] = [];
  for (const module of plan.modules) {
    const children = dossiers.filter((entry) => owningModule(entry.path, plan.allModules)?.id === module.id);
    const facts = evidenceEntry('module', module.path, { name: module.name, filesAnalyzed: children.length,
      symbolsIndexed: [...plan.graph.symbols.values()].filter((symbol) => owningModule(symbol.path, plan.allModules)?.id === module.id).length });
    moduleCards.push({ path: module.path, summary: await synthesizeComplete(
      { id: module.id, name: module.name, path: module.path, level: 'module' },
      [facts, ...synthesisEntries(children, plan.limits)], plan.limits, run) });
  }
  if (!options.moduleFilter) {
    const unknowns = plan.allFiles.some((file) => file.language === null)
      ? ['Some files have no recognized text format and no technical dossier; indexed counts are not proof of behavior.'] : [];
    await synthesizeComplete({ id: `repo://${plan.repository.name}`, name: 'Repository Brief', level: 'repository' },
      [...synthesisEntries(moduleCards, plan.limits), evidenceEntry('repository', '.', { repository: plan.repository.name, counts: store.getCounts(snapshotId) })],
      plan.limits, run, { unknowns });
  }
  store.setSnapshotMetadata(snapshotId, 'technical_analysis', JSON.stringify({ analysisMode: 'files',
    maxReanalysisDepth: options.budget?.maxReanalysisDepth ?? 3,
    files: plan.files.length, symbols: plan.symbolsCovered, symbolsCoveredByFiles: true, sourceLines: plan.sourceLines,
    sourceSections: plan.plans.reduce((n, entry) => n + entry.packs.length, 0), filePackBytes: plan.limits.maxBytes,
    model: model.name, completeSourceCoverage: true }));
  store.rebuildSearchIndex(snapshotId);
  return result;
}
