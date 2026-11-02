import { lstatSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { gitHead, listTrackedFiles } from '@repolead/adapter-git';
import { loadConfig } from '@repolead/config';
import { refreshOpportunities } from '@repolead/change-analysis';
import { contentHash, DEPENDENCY_EDGE_TYPES, fileUri } from '@repolead/domain';
import type { CodeSymbol, Module } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

import type { ScanOptions, ScanResult } from './scan';
import { EXTRACTION_VERSION, scanRepository } from './scan';
import { collectQuality } from './quality';

export interface RefreshResult {
  upToDate: boolean;
  changedFiles: string[];
  changedSymbolIds: string[];
  removedSymbolIds: string[];
  affectedModules: string[];
  previousSnapshotId: string | null;
  scan: ScanResult | null;
  durationMs: number;
}

/** Compare against indexed bytes, including an already-indexed dirty working tree. */
export async function refreshRepository(options: ScanOptions): Promise<RefreshResult> {
  const startedAt = Date.now();
  const rootPath = resolve(options.rootPath);
  let repositoryName = options.repositoryName ?? basename(rootPath);
  const dbPath = options.dbPath ?? join(rootPath, '.repolead', 'repolead.db');
  const configuration = loadConfig(rootPath);
  const store = await openStore(dbPath);
  const previous = store.getLatestSnapshot();
  const previousSymbols = new Map<string, CodeSymbol>();
  const oldFileHashes = new Map<string, string>();
  let previousModules: Module[] = [];
  let configurationChanged = false;
  let extractionChanged = false;
  try {
    if (previous) {
      const repository = store.getRepository(previous.repositoryId)!;
      if (resolve(repository.rootPath) !== rootPath) { throw new Error('This database belongs to a different repository path.'); }
      if (options.repositoryName && options.repositoryName !== repository.name) {
        throw new Error('Refresh cannot change the indexed repository identity; use a new database for a renamed repository.');
      }
      repositoryName = repository.name;
      configurationChanged = store.getSnapshotMetadata(previous.id, 'configuration_hash') !== configuration.fingerprint;
      extractionChanged = store.getSnapshotMetadata(previous.id, 'extraction_version') !== EXTRACTION_VERSION
        || store.getSnapshotMetadata(previous.id, 'scip_enabled') !== String(options.scip !== false);
      for (const symbol of store.listSymbols(previous.id)) { previousSymbols.set(symbol.id, symbol); }
      previousModules = store.listModules(previous.id);
      const files = store.db.prepare('SELECT path, content_hash FROM files WHERE snapshot_id = ?')
        .all(previous.id) as { path: string; content_hash: string }[];
      for (const file of files) { oldFileHashes.set(file.path, file.content_hash); }
    }
  } finally { store.close(); }

  const [head, tracked] = await Promise.all([gitHead(rootPath), listTrackedFiles(rootPath)]);
  const currentFileHashes = new Map<string, string>();
  for (const path of tracked) {
    try {
      const target = join(rootPath, path);
      if (lstatSync(target).isFile()) { currentFileHashes.set(path, contentHash(readFileSync(target))); }
    } catch { /* A tracked deletion is represented by its absence, like scan. */ }
  }
  const changedFiles = [...new Set([...oldFileHashes.keys(), ...currentFileHashes.keys()])]
    .filter((path) => oldFileHashes.get(path) !== currentFileHashes.get(path)).sort();
  if (previous && head === previous.commitSha && changedFiles.length === 0 && !configurationChanged && !extractionChanged) {
    const currentStore = await openStore(dbPath);
    try {
      if (configuration.config.metrics.tools.length || configuration.config.metrics.coverage) {
        await collectQuality({ store: currentStore, snapshotId: previous.id, tools: configuration.config.metrics.tools,
          coveragePath: configuration.config.metrics.coverage });
      }
      refreshOpportunities(currentStore, previous.id);
    } finally { currentStore.close(); }
    return { upToDate: true, changedFiles: [], changedSymbolIds: [], removedSymbolIds: [],
      affectedModules: [], previousSnapshotId: previous.id, scan: null, durationMs: Date.now() - startedAt };
  }

  const scan = await scanRepository({ ...options, dbPath, repositoryName, previousSnapshotId: previous?.id });
  const reopened = await openStore(dbPath);
  try {
    const currentSymbols = reopened.listSymbols(scan.snapshotId);
    const currentIds = new Set(currentSymbols.map((symbol) => symbol.id));
    const changedSymbolIds = currentSymbols.filter((symbol) => previousSymbols.get(symbol.id)?.contentHash !== symbol.contentHash)
      .map((symbol) => symbol.id);
    const removedSymbolIds = [...previousSymbols.keys()].filter((id) => !currentIds.has(id));
    const modules = reopened.listModules(scan.snapshotId);
    const changedPaths = new Set(changedFiles);
    const affected = new Set<string>();
    const owner = (path: string, entries: Module[]) => entries.filter((module) => module.path === '.' || path.startsWith(`${module.path}/`))
      .sort((left, right) => right.path.length - left.path.length)[0];
    for (const path of changedPaths) {
      const current = owner(path, modules);
      const old = owner(path, previousModules);
      if (current) { affected.add(current.name); }
      if (old) { affected.add(old.name); }
    }
    // Traverse both graphs so deletion/rename cannot erase the old dependency chain.
    const seeds = [...changedPaths].map((path) => fileUri(repositoryName, path));
    seeds.push(...changedSymbolIds, ...removedSymbolIds);
    for (const snapshotId of [previous?.id, scan.snapshotId].filter((id): id is string => Boolean(id))) {
      const graph = reopened.loadGraph(snapshotId);
      const prefix = fileUri(repositoryName, '');
      const seen = new Set(seeds);
      let frontier = seeds;
      for (let depth = 0; depth < configuration.config.analysis_budget.max_reanalysis_depth && frontier.length; depth += 1) {
        const next: string[] = [];
        for (const target of frontier) {
          for (const edge of graph.incoming.get(target) ?? []) {
            if (!DEPENDENCY_EDGE_TYPES.has(edge.edgeType) || seen.has(edge.sourceId)) { continue; }
            seen.add(edge.sourceId); next.push(edge.sourceId);
            const path = graph.symbols.get(edge.sourceId)?.path ?? (edge.sourceId.startsWith(prefix) ? edge.sourceId.slice(prefix.length) : null);
            if (path) {
              const module = owner(path, modules) ?? owner(path, previousModules);
              if (module) { affected.add(module.name); }
            }
          }
        }
        frontier = next;
      }
    }
    if (configurationChanged || extractionChanged) {
      for (const module of modules) { affected.add(module.name); }
    }
    return { upToDate: false, changedFiles, changedSymbolIds, removedSymbolIds, affectedModules: [...affected].sort(),
      previousSnapshotId: previous?.id ?? null, scan, durationMs: Date.now() - startedAt };
  } finally { reopened.close(); }
}
