import { basename } from 'node:path';

import { contentHash, DEFAULT_CONTEXT_TOKENS, DEFAULT_SOURCE_LINES, sliceSource } from '@repolead/domain';
import type { CodeSymbol } from '@repolead/domain';
import { owningModule, readSnapshotSource } from '@repolead/retrieval';

import { analyzeSubject } from './analyze';
import type { AnalyzeOptions, AnalyzeResult } from './analyze';
import { packetFits, packetLimits } from './bounded-synthesis';
import { buildDependencyIndex } from './dependencies';
import { planFileAnalysis } from './file-analysis';
import { dependencyUnknowns, evidenceEntry, fitHierarchyPack, listSourceFiles } from './hierarchy';

export interface ProductEntryPoint {
  kind: 'usecase' | 'page';
  name: string;
  path: string;
  symbolId?: string;
  summarySubjectId: string;
  startLine: number;
  endLine: number;
}

const AUXILIARY = /(?:^|\/)(?:tests?|__tests__|fixtures|components|hooks|utils|helpers|node_modules|vendor)(?:\/|$)|\.(?:test|spec|stories)\.[^.]+$/i;
const PAGE_AUXILIARY = /(?:Form|Tab|Modal|Dialog|Drawer|Card|Table|Toolbar|Filter|Provider|Context|Redirect)\.[jt]sx$/i;

/** Select application use-case classes and actual page files, not DTOs/helpers or every TSX file. */
export function selectProductEntryPoints(options: Pick<AnalyzeOptions, 'store' | 'snapshotId' | 'moduleFilter'>) {
  const { store, snapshotId } = options;
  const snapshot = store.getSnapshot(snapshotId); const repository = snapshot && store.getRepository(snapshot.repositoryId);
  if (!repository) { throw new Error('Unknown repository snapshot.'); }
  const files = listSourceFiles(store, snapshotId); const graph = store.loadGraph(snapshotId);
  const modules = store.listModules(snapshotId);
  const matches = modules.filter((module) => [module.name, module.path].includes(options.moduleFilter ?? ''));
  if (options.moduleFilter && matches.length !== 1) { throw new Error('Unknown or ambiguous module; use its path.'); }
  const inScope = (path: string) => !AUXILIARY.test(path) && (!options.moduleFilter || owningModule(path, modules)?.id === matches[0]!.id);
  const classes = [...graph.symbols.values()].filter((symbol) => symbol.kind === 'class'
    && /(?:^|\/)(?:use_cases|usecases|use-cases)\//i.test(symbol.path) && /UseCase$/i.test(symbol.qualifiedName)
    && !/^(?:Base)?UseCase$/i.test(symbol.qualifiedName) && inScope(symbol.path));
  const countByFile = new Map<string, number>();
  classes.forEach((symbol) => countByFile.set(symbol.path, (countByFile.get(symbol.path) ?? 0) + 1));
  const targets: ProductEntryPoint[] = classes.map((symbol) => ({ kind: 'usecase', name: symbol.qualifiedName,
    path: symbol.path, symbolId: symbol.id, startLine: symbol.startLine, endLine: symbol.endLine,
    summarySubjectId: countByFile.get(symbol.path) === 1 ? files.find((file) => file.path === symbol.path)!.id
      : `usecase://${repository.name}/${symbol.path}#${symbol.qualifiedName}` }));
  const routerFiles = files.filter((file) => /(?:^|\/)(?:router|routes)(?:\/index)?\.[jt]sx?$/i.test(file.path) && !AUXILIARY.test(file.path));
  const routerNames = new Set<string>();
  for (const file of routerFiles) {
    const source = readSnapshotSource(store, snapshotId, repository.rootPath, file.path);
    for (const name of source.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? []) { routerNames.add(name); }
  }
  const exports = store.listExports(snapshotId);
  for (const file of files.filter((file) => /(?:^|\/)pages\/.+\.[jt]sx$/i.test(file.path) && inScope(file.path))) {
    const name = basename(file.path).replace(/\.[jt]sx$/i, '');
    if (PAGE_AUXILIARY.test(file.path) || name.startsWith('_')) { continue; }
    const source = readSnapshotSource(store, snapshotId, repository.rootPath, file.path);
    if (!/<[A-Za-z]|\bcreateElement\s*\(/.test(source)) { continue; } // Barrel exports are not pages.
    const names = [...graph.symbols.values()].filter((symbol) => symbol.path === file.path
      && ['function', 'class', 'variable'].includes(symbol.kind)).map((symbol) => symbol.qualifiedName);
    const routerReferenced = routerNames.has(name) || names.some((value) => routerNames.has(value))
      || exports.some((entry) => entry.path === file.path && routerNames.has(entry.exportedName));
    if (routerFiles.length && !routerReferenced && !/(?:Page|Screen)$/.test(name)) { continue; }
    targets.push({ kind: 'page', name, path: file.path, summarySubjectId: file.id,
      startLine: 1, endLine: file.lineCount ?? source.split('\n').length });
  }
  return { repository, files, graph, modules, targets: targets.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name)), countByFile };
}

/** Exactly one analysis task per use case/page; no file hierarchy, synthesis groups or global brief. */
export function planEntryPointAnalysis(options: Pick<AnalyzeOptions, 'store' | 'snapshotId' | 'budget' | 'moduleFilter'>) {
  const selected = selectProductEntryPoints(options);
  const singleFiles = new Set(selected.targets.filter((target) => target.kind === 'page' || selected.countByFile.get(target.path) === 1).map((target) => target.path));
  // Small whole-file packs remain byte-for-byte compatible with previous file-mode cache entries.
  const plan = planFileAnalysis(options, { paths: singleFiles, maxBytes: 100000, singlePacket: true });
  const byPath = new Map(plan.plans.map((entry) => [entry.file.path, entry.packs[0]!]));
  const dependencies = buildDependencyIndex(options.store, options.snapshotId, selected.graph, selected.files);
  const plans = selected.targets.map((target) => {
    const existing = byPath.get(target.path);
    if (existing) { return { target, input: existing }; }
    const symbol = selected.graph.symbols.get(target.symbolId!) as CodeSymbol;
    const source = readSnapshotSource(options.store, options.snapshotId, selected.repository.rootPath, target.path);
    const body = sliceSource(source, symbol);
    if (contentHash(body) !== symbol.contentHash) { throw new Error(`Entry point source mismatch: ${target.name}`); }
    const firstClass = Math.min(...selected.targets.filter((entry) => entry.path === target.path).map((entry) => entry.startLine));
    const prefix = source.split('\n').slice(0, firstClass - 1).join('\n');
    if (body.split('\n').length + prefix.split('\n').length > (options.budget?.maxSourceLinesPerPack ?? DEFAULT_SOURCE_LINES)) {
      throw new Error(`Entry point ${target.name} exceeds the complete source line budget; no partial analysis was generated.`);
    }
    const ids = [...selected.graph.symbols.values()].filter((entry) => entry.path === target.path
      && entry.startLine >= symbol.startLine && entry.endLine <= symbol.endLine).map((entry) => entry.id);
    const scope = dependencies.forSubjects(ids, options.budget?.maxReanalysisDepth);
    const entries = [evidenceEntry('source', target.path, { name: target.name, complete: true, source: body },
      { startLine: symbol.startLine, endLine: symbol.endLine }),
    ...(prefix.trim() ? [evidenceEntry('source', target.path, { declarationsBeforeUseCases: prefix }, { startLine: 1, endLine: firstClass - 1 })] : [])];
    const input = fitHierarchyPack({ id: target.summarySubjectId, name: `${target.path}#${target.name}`, path: target.path, level: 'file' },
      entries, options.budget?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
      { fingerprint: { mode: 'usecase-class-v1', body: contentHash(body), declarations: contentHash(prefix), dependencies: scope.fingerprint },
        unknowns: [...dependencyUnknowns(scope), 'Only this use case and supplied declarations were analyzed; verify downstream behavior through indexed code evidence.'] });
    if (!packetFits(input, packetLimits(options.budget?.maxTokens ?? DEFAULT_CONTEXT_TOKENS, 100000))) {
      throw new Error(`Entry point ${target.name} exceeds the single-analysis evidence budget; no partial analysis was generated.`);
    }
    return { target, input };
  });
  return { ...selected, plans };
}

export async function analyzeEntryPoints(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const { store, snapshotId, model } = options;
  const plan = planEntryPointAnalysis(options);
  store.setSnapshotMetadata(snapshotId, 'synthesis_mode', 'entrypoints');
  store.setSnapshotMetadata(snapshotId, 'entrypoint_catalog', JSON.stringify(plan.targets));
  store.setSnapshotMetadata(snapshotId, 'technical_analysis', JSON.stringify({ analysisMode: 'entrypoints', synthesisMode: 'entrypoints', status: 'running' }));
  const result: AnalyzeResult = { symbolsSkipped: plan.graph.symbols.size, localInputTokens: 0, localOutputTokens: 0,
    symbolsAnalyzed: 0, symbolsCached: 0, filesAnalyzed: 0, filesCached: 0, modulesAnalyzed: 0, modulesCached: 0,
    briefGenerated: false, briefCached: false, inputTokens: 0, outputTokens: 0 };
  for (const [index, { target, input }] of plan.plans.entries()) {
    const started = Date.now(); const outcome = await analyzeSubject(options, input.pack, input.evidence);
    result[outcome.cached ? 'filesCached' : 'filesAnalyzed'] += 1;
    result.inputTokens += outcome.inputTokens; result.outputTokens += outcome.outputTokens;
    if (model.locality === 'local') { result.localInputTokens += outcome.inputTokens; result.localOutputTokens += outcome.outputTokens; }
    options.onProgress?.({ subject: `${target.kind}: ${target.name} · ${target.path}`, level: 'file',
      outcome: outcome.cached ? 'cached' : 'analyzed', durationMs: Date.now() - started, index: index + 1, total: plan.plans.length });
  }
  store.setSnapshotMetadata(snapshotId, 'technical_analysis', JSON.stringify({ analysisMode: 'entrypoints', synthesisMode: 'entrypoints', status: 'complete',
    selectionComplete: true, completeSourceCoverage: false, globalSummariesSkipped: true, scope: options.moduleFilter ?? null,
    files: new Set(plan.targets.map((target) => target.path)).size, indexedFiles: plan.files.length, entrypoints: plan.targets.length,
    usecases: plan.targets.filter((target) => target.kind === 'usecase').length, pages: plan.targets.filter((target) => target.kind === 'page').length,
    maxReanalysisDepth: options.budget?.maxReanalysisDepth ?? 3,
    selectionNotes: ['Only detected UseCase classes and page entries receive generated analyses. Other code and documents remain indexed for retrieval; this does not prove complete product coverage.'], model: model.name }));
  store.rebuildSearchIndex(snapshotId);
  return result;
}
