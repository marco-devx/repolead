import { basename, resolve } from 'node:path';

import { changedFilesSince, gitHead } from '@repolead/adapter-git';
import { fileUri } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

import type { ScanOptions, ScanResult } from './scan';
import { scanRepository } from './scan';

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

/**
 * Refresh incremental (regla 6 del plan): git diff decide si hay trabajo;
 * la capa determinística se re-escanea (barata) y las capas costosas se
 * invalidan selectivamente — los summaries por caché de contenido (Fase 5)
 * y los vectores por la lista de símbolos cambiados que devuelve este paso.
 */
export async function refreshRepository(options: ScanOptions): Promise<RefreshResult> {
  const startedAt = Date.now();
  const rootPath = resolve(options.rootPath);
  const repositoryName = options.repositoryName ?? basename(rootPath);
  const dbPath = options.dbPath ?? `${rootPath}/.repolead/repolead.db`;

  const store = await openStore(dbPath);
  const previous = store.getLatestSnapshot();
  const previousSymbols = new Map<string, string>();
  if (previous) {
    for (const symbol of store.listSymbols(previous.id)) {
      previousSymbols.set(symbol.id, symbol.contentHash);
    }
  }
  store.close();

  if (previous) {
    const [head, changedFiles] = await Promise.all([
      gitHead(rootPath),
      changedFilesSince(rootPath, previous.commitSha),
    ]);
    if (head === previous.commitSha && changedFiles.length === 0) {
      return {
        upToDate: true,
        changedFiles: [],
        changedSymbolIds: [],
        removedSymbolIds: [],
        affectedModules: [],
        previousSnapshotId: previous.id,
        scan: null,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  const scan = await scanRepository({ ...options, dbPath, repositoryName });

  const reopened = await openStore(dbPath);
  const currentSymbols = reopened.listSymbols(scan.snapshotId);
  const currentIds = new Set(currentSymbols.map((symbol) => symbol.id));

  const changedSymbolIds = currentSymbols
    .filter((symbol) => previousSymbols.get(symbol.id) !== symbol.contentHash)
    .map((symbol) => symbol.id);
  const removedSymbolIds = [...previousSymbols.keys()].filter((id) => !currentIds.has(id));

  // Módulos afectados: los que contienen símbolos cambiados + los que importan
  // archivos cambiados (dependientes directos).
  const changedPaths = new Set(
    currentSymbols
      .filter((symbol) => changedSymbolIds.includes(symbol.id))
      .map((symbol) => symbol.path),
  );
  const moduleOfFile = new Map<string, string>();
  const moduleNames = new Map<string, string>();
  for (const module of reopened.listModules(scan.snapshotId)) {
    moduleNames.set(module.id, module.name);
  }
  const containsRows = reopened.db
    .prepare(
      `SELECT source_id, target_id FROM edges
       WHERE snapshot_id = ? AND edge_type = 'CONTAINS' AND analyzer = 'module-detection'`,
    )
    .all(scan.snapshotId) as { source_id: string; target_id: string }[];
  for (const row of containsRows) {
    moduleOfFile.set(row.target_id, row.source_id);
  }

  const affected = new Set<string>();
  for (const path of changedPaths) {
    const moduleId = moduleOfFile.get(fileUri(repositoryName, path));
    if (moduleId) {
      affected.add(moduleId);
    }
  }
  const importRows = reopened.db
    .prepare(`SELECT source_id, target_id FROM edges WHERE snapshot_id = ? AND edge_type = 'IMPORTS'`)
    .all(scan.snapshotId) as { source_id: string; target_id: string }[];
  const changedFileUris = new Set([...changedPaths].map((path) => fileUri(repositoryName, path)));
  for (const row of importRows) {
    if (changedFileUris.has(row.target_id)) {
      const dependentModule = moduleOfFile.get(row.source_id);
      if (dependentModule) {
        affected.add(dependentModule);
      }
    }
  }
  reopened.close();

  const changedFiles = previous ? await changedFilesSince(rootPath, previous.commitSha) : [];

  return {
    upToDate: false,
    changedFiles,
    changedSymbolIds,
    removedSymbolIds,
    affectedModules: [...affected].map((id) => moduleNames.get(id) ?? id).sort(),
    previousSnapshotId: previous?.id ?? null,
    scan,
    durationMs: Date.now() - startedAt,
  };
}
