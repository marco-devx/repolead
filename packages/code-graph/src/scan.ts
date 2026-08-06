import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';

import { collectHistory, gitHead, listTrackedFiles } from '@repolead/adapter-git';
import { indexWithScipTypescript } from '@repolead/adapter-scip';
import { extractFromSource, isTestPath } from '@repolead/adapter-typescript';
import type { CodeSymbol, Edge, Metric, Module, SourceFile, TestCase } from '@repolead/domain';
import { contentHash, fileUri, moduleUri, stableSymbolId } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import { openStore } from '@repolead/knowledge-store';

import { buildScipEdges } from './scip-enrich';

const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.sql': 'sql',
  '.sh': 'shell',
};

const MAX_PARSE_BYTES = 1024 * 1024;

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

function isParseableTypescript(path: string): boolean {
  return /\.[cm]?tsx?$/.test(path) && !path.endsWith('.d.ts');
}

/** Resuelve un import relativo a un archivo real del repo (con .ts/.tsx/index). */
function resolveRelativeImport(fromPath: string, specifier: string, tracked: Set<string>): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => tracked.has(candidate)) ?? null;
}

export interface ScanOptions {
  rootPath: string;
  dbPath?: string;
  repositoryName?: string;
  /** Ejecuta scip-typescript para resolver referencias (default: true). */
  scip?: boolean;
}

export interface ScanResult {
  repositoryName: string;
  snapshotId: string;
  commitSha: string;
  dbPath: string;
  counts: {
    files: number;
    symbols: number;
    edges: number;
    modules: number;
    tests: number;
    metrics: number;
  };
  /** Referencias resueltas por SCIP; null si el indexador no corrió. */
  referencesResolved: number | null;
  durationMs: number;
}

export async function scanRepository(options: ScanOptions): Promise<ScanResult> {
  const startedAt = Date.now();
  const rootPath = resolve(options.rootPath);
  const repositoryName = options.repositoryName ?? basename(rootPath);

  const commitSha = await gitHead(rootPath);
  const trackedFiles = await listTrackedFiles(rootPath);
  const tracked = new Set(trackedFiles);
  const history = await collectHistory(rootPath);

  const dbPath = options.dbPath ?? join(rootPath, '.repolead', 'repolead.db');
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(isAbsolute(dbPath) ? dbPath : resolve(dbPath)), { recursive: true });
  }
  const store: KnowledgeStore = await openStore(dbPath);

  const repository = store.upsertRepository({ name: repositoryName, rootPath });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha });

  const files: SourceFile[] = [];
  const symbols = new Map<string, CodeSymbol>();
  const edges = new Map<string, Edge>();
  const tests: TestCase[] = [];
  const metrics: Metric[] = [];

  const addEdge = (edge: Edge): void => {
    edges.set(`${edge.sourceId}\n${edge.targetId}\n${edge.edgeType}\n${edge.analyzer}`, edge);
  };

  for (const path of trackedFiles) {
    const absolutePath = join(rootPath, path);
    let content: Buffer;
    try {
      content = readFileSync(absolutePath);
    } catch {
      continue;
    }

    const fileHistory = history.files.get(path);
    const fileId = fileUri(repositoryName, path);
    const language = LANGUAGES[extensionOf(path)] ?? null;
    const source = language !== null && content.length <= MAX_PARSE_BYTES ? content.toString('utf8') : null;

    files.push({
      id: fileId,
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      path,
      language,
      contentHash: contentHash(content),
      lineCount: source === null ? null : source.split('\n').length,
      lastAuthor: fileHistory?.lastAuthor ?? null,
      lastCommitAt: fileHistory?.lastCommitAt ?? null,
    });

    if (fileHistory) {
      metrics.push({
        snapshotId: snapshot.id,
        subjectId: fileId,
        name: 'commit_count',
        value: fileHistory.commitCount,
        analyzer: 'git',
      });
    }

    if (source === null || !isParseableTypescript(path)) {
      continue;
    }

    const extraction = await extractFromSource(path, source);

    for (const extracted of extraction.symbols) {
      const symbolId = stableSymbolId({
        repository: repositoryName,
        path,
        kind: extracted.kind,
        qualifiedName: extracted.qualifiedName,
        signature: extracted.signature,
      });
      if (symbols.has(symbolId)) {
        continue;
      }
      symbols.set(symbolId, {
        id: symbolId,
        repositoryId: repository.id,
        snapshotId: snapshot.id,
        path,
        qualifiedName: extracted.qualifiedName,
        kind: extracted.kind,
        signature: extracted.signature,
        startLine: extracted.startLine,
        endLine: extracted.endLine,
        contentHash: contentHash(source.split('\n').slice(extracted.startLine - 1, extracted.endLine).join('\n')),
        source: 'tree-sitter',
      });

      const containerId = extracted.parent
        ? stableSymbolId({ repository: repositoryName, path, kind: 'class', qualifiedName: extracted.parent })
        : fileId;
      addEdge({
        snapshotId: snapshot.id,
        sourceId: containerId,
        targetId: symbolId,
        edgeType: 'CONTAINS',
        confidence: 1,
        analyzer: 'tree-sitter',
        evidence: { path, line: extracted.startLine },
      });
    }

    for (const importEntry of extraction.imports) {
      const targetPath = resolveRelativeImport(path, importEntry.specifier, tracked);
      if (!targetPath) {
        continue;
      }
      addEdge({
        snapshotId: snapshot.id,
        sourceId: fileId,
        targetId: fileUri(repositoryName, targetPath),
        edgeType: 'IMPORTS',
        confidence: 1,
        analyzer: 'tree-sitter',
        evidence: { path, line: importEntry.startLine, specifier: importEntry.specifier },
      });
      if (isTestPath(path)) {
        addEdge({
          snapshotId: snapshot.id,
          sourceId: fileUri(repositoryName, targetPath),
          targetId: fileId,
          edgeType: 'TESTED_BY',
          confidence: 0.8,
          analyzer: 'convention',
          evidence: { testPath: path, specifier: importEntry.specifier },
        });
      }
    }

    for (const testEntry of extraction.tests) {
      tests.push({
        id: `test_${createHash('sha256').update(`${path}\n${testEntry.name}`).digest('hex').slice(0, 24)}`,
        snapshotId: snapshot.id,
        path,
        name: testEntry.name,
      });
    }
  }

  // Módulos: cada directorio con package.json es un módulo; los archivos se
  // asignan al módulo más cercano hacia la raíz.
  const moduleDirs = trackedFiles
    .filter((path) => basename(path) === 'package.json')
    .map((path) => posix.dirname(path));
  if (moduleDirs.length === 0) {
    moduleDirs.push('.');
  }
  const modules: Module[] = moduleDirs.map((dir) => ({
    id: moduleUri(repositoryName, dir === '.' ? 'root' : dir),
    repositoryId: repository.id,
    snapshotId: snapshot.id,
    name: dir === '.' ? repositoryName : basename(dir),
    path: dir,
  }));
  const sortedModuleDirs = [...moduleDirs].sort((left, right) => right.length - left.length);
  for (const file of files) {
    const owner = sortedModuleDirs.find((dir) => dir === '.' || file.path.startsWith(`${dir}/`));
    if (owner !== undefined) {
      addEdge({
        snapshotId: snapshot.id,
        sourceId: moduleUri(repositoryName, owner === '.' ? 'root' : owner),
        targetId: file.id,
        edgeType: 'CONTAINS',
        confidence: 1,
        analyzer: 'module-detection',
        evidence: { moduleDir: owner },
      });
    }
  }

  let referencesResolved: number | null = null;
  if (options.scip !== false) {
    const scipIndex = await indexWithScipTypescript(rootPath);
    if (scipIndex) {
      const enrichment = buildScipEdges(scipIndex, [...symbols.values()], snapshot.id);
      for (const edge of enrichment.edges) {
        addEdge(edge);
      }
      referencesResolved = enrichment.resolvedReferences;
      metrics.push({
        snapshotId: snapshot.id,
        subjectId: fileUri(repositoryName, '.'),
        name: 'scip_unmapped_definitions',
        value: enrichment.unmappedDefinitions,
        analyzer: 'scip',
      });
    }
  }

  for (const pair of history.coChanges) {
    metrics.push({
      snapshotId: snapshot.id,
      subjectId: fileUri(repositoryName, pair.a),
      name: `co_change:${pair.b}`,
      value: pair.count,
      analyzer: 'git',
    });
  }

  store.insertFiles(files);
  store.insertSymbols([...symbols.values()]);
  store.insertEdges([...edges.values()]);
  store.insertModules(modules);
  store.insertTests(tests);
  store.insertMetrics(metrics);

  const counts = store.getCounts(snapshot.id);
  store.close();

  return {
    repositoryName,
    snapshotId: snapshot.id,
    commitSha,
    dbPath,
    counts,
    referencesResolved,
    durationMs: Date.now() - startedAt,
  };
}
