import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';

import { collectHistory, gitHead, listTrackedFiles } from '@repolead/adapter-git';
import { extractPythonSource, isPythonTestPath, resolvePythonImport } from '@repolead/adapter-python';
import { indexWithScipPython, indexWithScipTypescript } from '@repolead/adapter-scip';
import type { ScipIndexerDiagnostic } from '@repolead/adapter-scip';
import { extractFromSource, isTestPath } from '@repolead/adapter-typescript';
import type { FileExtraction } from '@repolead/adapter-typescript';
import { loadConfig } from '@repolead/config';
import { refreshOpportunities } from '@repolead/change-analysis';
import type { CodeSymbol, Edge, ExportBinding, KnowledgeDocument, Metric, Module, SourceFile, SymbolReference, TestCase } from '@repolead/domain';
import { contentHash, fileUri, moduleUri, sliceSource, stableSymbolId } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import { openStore } from '@repolead/knowledge-store';

import { buildScipEdges } from './scip-enrich';
import type { ReconciliationDiagnostic } from './scip-enrich';
import { documentationEdges, isDocumentation } from './documents';
import { graphMetrics } from './metrics';
import { collectQuality } from './quality';

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
  '.mdx': 'markdown',
  '.txt': 'text',
  '.rst': 'text',
  '.html': 'html',
  '.css': 'css',
  '.sql': 'sql',
  '.sh': 'shell',
};

const MAX_PARSE_BYTES = 1024 * 1024;
// Bump whenever extraction semantics or the parser grammar changes.
export const EXTRACTION_VERSION = 'tree-sitter-ts-js-py-route-handlers-visibility-v11';

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

function isParseableTypescript(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path) && !path.endsWith('.d.ts');
}

function isParseablePython(path: string): boolean {
  return path.endsWith('.py');
}

function isTestFile(path: string): boolean {
  return isTestPath(path) || isPythonTestPath(path);
}

/** Resuelve un import relativo a un archivo real del repo (con .ts/.tsx/index). */
function resolveRelativeImport(fromPath: string, specifier: string, tracked: Set<string>): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const sourceBase = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  const candidates = [
    base,
    ...(sourceBase !== base ? [`${sourceBase}.ts`, `${sourceBase}.tsx`, `${sourceBase}.mts`, `${sourceBase}.cts`] : []),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
  return candidates.find((candidate) => tracked.has(candidate)) ?? null;
}

export interface ScanOptions {
  rootPath: string;
  dbPath?: string;
  repositoryName?: string;
  /** Ejecuta scip-typescript para resolver referencias (default: true). */
  scip?: boolean;
  /** Reuse syntax extraction for unchanged files in this previous snapshot. */
  previousSnapshotId?: string;
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
  parsing: { parsedFiles: number; reusedFiles: number };
  diagnostics: { extraction: number; scipUnmapped: number; indexers: ScipIndexerDiagnostic[] };
  durationMs: number;
}

export async function scanRepository(options: ScanOptions): Promise<ScanResult> {
  const startedAt = Date.now();
  const rootPath = resolve(options.rootPath);
  const canonicalRoot = realpathSync(rootPath);
  const repositoryName = options.repositoryName ?? basename(rootPath);
  const settings = loadConfig(rootPath);

  const commitSha = await gitHead(rootPath);
  const trackedFiles = await listTrackedFiles(rootPath);
  const tracked = new Set(trackedFiles);
  const history = await collectHistory(rootPath);

  const dbPath = options.dbPath ?? join(rootPath, '.repolead', 'repolead.db');
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(isAbsolute(dbPath) ? dbPath : resolve(dbPath)), { recursive: true });
  }
  const store: KnowledgeStore = await openStore(dbPath);
  try {
  const repository = store.upsertRepository({ name: repositoryName, rootPath });
  // Publish only after the complete deterministic snapshot can be committed atomically.
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha, persist: false });
  const previous = options.previousSnapshotId ? store.getSnapshot(options.previousSnapshotId) : null;
  if (previous && previous.repositoryId !== repository.id) { throw new Error('Extraction cache belongs to a different repository.'); }
  const cachedExtractions = new Map((previous ? store.db.prepare(
    'SELECT path, content_hash, extraction_json FROM file_extractions WHERE snapshot_id = ? AND analyzer_version = ?',
  ).all(previous.id, EXTRACTION_VERSION) as { path: string; content_hash: string; extraction_json: string }[] : [])
    .map((row) => [row.path, row]));
  const extractions: { path: string; contentHash: string; json: string }[] = [];
  const parsing = { parsedFiles: 0, reusedFiles: 0 };

  const files: SourceFile[] = [];
  const documents: KnowledgeDocument[] = [];
  const sources: { path: string; contentHash: string; content: string }[] = [];
  const skippedDocuments: string[] = [];
  const symbols = new Map<string, CodeSymbol>();
  const exports: ExportBinding[] = [];
  const extractionDiagnostics: { path: string; line: number; message: string }[] = [];
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
      if (!lstatSync(absolutePath).isFile()) { continue; }
      const relativeTarget = relative(canonicalRoot, realpathSync(absolutePath));
      if (relativeTarget === '..' || relativeTarget.startsWith('../') || isAbsolute(relativeTarget)) { continue; }
      content = readFileSync(absolutePath);
    } catch {
      if (isDocumentation(path, settings.config.documentation.paths)) { skippedDocuments.push(`${path}: unreadable`); }
      continue;
    }

    const fileHistory = history.files.get(path);
    const fileId = fileUri(repositoryName, path);
    const language = LANGUAGES[extensionOf(path)] ?? null;
    const source = language !== null && content.length <= MAX_PARSE_BYTES ? content.toString('utf8') : null;
    const hash = contentHash(content);

    files.push({
      id: fileId,
      repositoryId: repository.id,
      snapshotId: snapshot.id,
      path,
      language,
      contentHash: hash,
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

    if (source === null) {
      if (isDocumentation(path, settings.config.documentation.paths)) { skippedDocuments.push(`${path}: exceeds the 1 MiB document limit`); }
      continue;
    }
    if (!source.includes('\0') && contentHash(source) === hash) { sources.push({ path, contentHash: hash, content: source }); }
    if (isDocumentation(path, settings.config.documentation.paths) && !source.includes('\0')) {
      documents.push({ id: `${fileId}#document`, snapshotId: snapshot.id, repositoryId: repository.id, path,
        title: /^#\s+(.+)$/m.exec(source)?.[1]?.trim() ?? basename(path), content: source, contentHash: hash });
    }
    if (isDocumentation(path, settings.config.documentation.paths) && source.includes('\0')) { skippedDocuments.push(`${path}: binary content`); }
    if (!isParseableTypescript(path) && !isParseablePython(path)) { continue; }
    let extraction: FileExtraction;
    const cached = cachedExtractions.get(path);
    if (cached?.content_hash === hash) {
      extraction = JSON.parse(cached.extraction_json) as FileExtraction;
      parsing.reusedFiles += 1;
    } else if (isParseableTypescript(path)) {
      extraction = await extractFromSource(path, source);
      parsing.parsedFiles += 1;
    } else {
      extraction = await extractPythonSource(path, source);
      parsing.parsedFiles += 1;
    }
    extractions.push({ path, contentHash: hash, json: JSON.stringify(extraction) });
    for (const [name, value] of Object.entries(extraction.metrics ?? {})) {
      metrics.push({ snapshotId: snapshot.id, subjectId: fileId, name, value, analyzer: 'tree-sitter-metrics-v1' });
    }

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
        ...(extracted.visibility ? { visibility: extracted.visibility } : {}),
        startLine: extracted.startLine,
        endLine: extracted.endLine,
        ...(extracted.span ? { span: extracted.span } : {}),
        ...(extracted.route ? { route: extracted.route } : {}),
        contentHash: contentHash(sliceSource(source, extracted)),
        source: 'tree-sitter',
      });
      for (const [name, value] of Object.entries(extracted.metrics ?? {})) {
        metrics.push({ snapshotId: snapshot.id, subjectId: symbolId, name, value, analyzer: 'tree-sitter-metrics-v1' });
      }

      const containerId = extracted.parent
        ? [...symbols.values()].find((candidate) => candidate.path === path && candidate.qualifiedName === extracted.parent
          && ['class', 'interface'].includes(candidate.kind))?.id ?? fileId : fileId;
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

    for (const entry of extraction.exports ?? []) {
      const local = entry.sourceModule === null && entry.localName ? [...symbols.values()].filter((symbol) => symbol.path === path && symbol.qualifiedName === entry.localName) : [];
      exports.push({ ...entry, id: `export_${contentHash(JSON.stringify([repositoryName, path, entry.exportedName, entry.localName, entry.sourceModule, entry.startLine])).slice(0, 32)}`,
        snapshotId: snapshot.id, path, symbolId: local.length === 1 ? local[0]!.id : null });
    }
    const typeEdges = new Map<string, Edge>();
    for (const usage of extraction.typeUses ?? []) {
      if (usage.specifier.startsWith('.')) { continue; } // Local contracts remain compiler/import dependencies.
      const candidates = [...symbols.values()].filter((symbol) => symbol.path === path && symbol.qualifiedName === usage.source
        && symbol.startLine <= usage.declarationLine && symbol.endLine >= usage.endLine && symbol.kind !== 'endpoint');
      if (candidates.length !== 1) { continue; }
      const targetId = `external://${isParseablePython(path) ? 'python' : 'npm'}/${encodeURIComponent(usage.specifier)}#type:${encodeURIComponent(usage.imported)}`;
      const key = `${candidates[0]!.id}\n${targetId}`;
      const location = { startLine: usage.startLine, endLine: usage.endLine, startColumn: usage.startColumn,
        endColumn: usage.endColumn, expression: usage.expression };
      const existing = typeEdges.get(key);
      if (existing) { (existing.evidence as { locations: typeof location[] }).locations.push(location); }
      else {
        typeEdges.set(key, { snapshotId: snapshot.id, sourceId: candidates[0]!.id, targetId, edgeType: 'DEPENDS_ON',
          analyzer: 'tree-sitter-type-contract', confidence: 1, evidence: { path, specifier: usage.specifier,
            imported: usage.imported, local: usage.local, importLine: usage.importLine, usage: 'public_signature', locations: [location] } });
      }
    }
    for (const edge of typeEdges.values()) { addEdge(edge); }
    for (const diagnostic of extraction.diagnostics ?? []) { extractionDiagnostics.push({ path, ...diagnostic }); }

    for (const endpoint of [...symbols.values()].filter((symbol) => symbol.path === path && symbol.route?.handler)) {
      if (endpoint.route?.framework === 'express' && endpoint.route.handlerScope !== 'module') { continue; }
      const matches = [...symbols.values()].filter((symbol) => symbol.path === path && symbol.qualifiedName === endpoint.route!.handler && ['function', 'method'].includes(symbol.kind));
      if (matches.length === 1) {
        addEdge({ snapshotId: snapshot.id, sourceId: endpoint.id, targetId: matches[0]!.id, edgeType: 'CALLS', confidence: 1,
          analyzer: 'route-binding', evidence: { path, line: endpoint.startLine, route: endpoint.route } });
      }
    }

    for (const importEntry of extraction.imports) {
      const targetPath = isParseablePython(path)
        ? resolvePythonImport(path, importEntry.specifier, tracked)
        : resolveRelativeImport(path, importEntry.specifier, tracked);
      const targetId = targetPath ? fileUri(repositoryName, targetPath) : importEntry.specifier.startsWith('.')
        ? null : `external://${isParseablePython(path) ? 'python' : 'npm'}/${encodeURIComponent(importEntry.specifier)}`;
      if (!targetId) { continue; }
      addEdge({
        snapshotId: snapshot.id,
        sourceId: fileId,
        targetId,
        edgeType: 'IMPORTS',
        confidence: 1,
        analyzer: 'tree-sitter',
        evidence: { path, line: importEntry.startLine, specifier: importEntry.specifier },
      });
      if (targetPath && isTestFile(path)) {
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

    const testOccurrences = new Map<string, number>();
    for (const testEntry of extraction.tests) {
      const occurrence = testOccurrences.get(testEntry.name) ?? 0;
      testOccurrences.set(testEntry.name, occurrence + 1);
      tests.push({
        id: `test_${createHash('sha256').update(`${repositoryName}\n${path}\n${testEntry.name}\n${occurrence}`).digest('hex').slice(0, 24)}`,
        snapshotId: snapshot.id,
        path,
        name: testEntry.name,
        startLine: testEntry.startLine,
        endLine: testEntry.endLine,
        ...(testEntry.span ? { span: testEntry.span } : {}),
        contentHash: contentHash(sliceSource(source, testEntry)),
      });
    }
  }

  // Named reexports resolve through tracked files; cycles or wildcard namespaces remain explicit bindings.
  for (let pass = 0; pass < exports.length; pass += 1) {
    let resolved = 0;
    for (const entry of exports) {
      if (entry.symbolId || !entry.sourceModule || !entry.localName || entry.localName === '*') { continue; }
      const targetPath = resolveRelativeImport(entry.path, entry.sourceModule, tracked);
      const matches = exports.filter((target) => target.path === targetPath && target.exportedName === entry.localName && target.symbolId);
      const ids = [...new Set(matches.map((target) => target.symbolId))];
      if (ids.length === 1) { entry.symbolId = ids[0]!; resolved += 1; }
    }
    if (!resolved) { break; }
  }

  // Módulos: cada directorio con package.json es un módulo; los archivos se
  // asignan al módulo más cercano hacia la raíz.
  const detectedModuleDirs = [
    ...new Set(
      trackedFiles
        .filter((path) => ['package.json', 'pyproject.toml', 'setup.py'].includes(basename(path)))
        .map((path) => posix.dirname(path)),
    ),
    ...new Set(exports.filter((entry) => entry.sourceModule && /(^|\/)index\.[cm]?[jt]sx?$/.test(entry.path)).map((entry) => posix.dirname(entry.path))),
  ];
  const declarations = settings.config.modules.length > 0 ? [...settings.config.modules] :
    [...new Set(detectedModuleDirs)].map((path) => ({ name: path === '.' ? repositoryName :
      ['package.json', 'pyproject.toml', 'setup.py'].some((manifest) => tracked.has(`${path}/${manifest}`)) ? basename(path) : path, path }));
  if (!declarations.some((entry) => entry.path === '.')) {
    const uncovered = files.some((file) => !declarations.some((entry) => file.path.startsWith(`${entry.path}/`)));
    if (declarations.length === 0 || uncovered) {
      let name = repositoryName;
      while (declarations.some((entry) => entry.name === name)) { name += ':root'; }
      declarations.push({ name, path: '.' });
    }
  }
  const modules: Module[] = declarations.map(({ name, path: dir }) => ({
    id: moduleUri(repositoryName, dir === '.' ? 'root' : dir),
    repositoryId: repository.id,
    snapshotId: snapshot.id,
    name,
    path: dir,
  }));
  const sortedModuleDirs = modules.map((module) => module.path).sort((left, right) => right.length - left.length);
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
  const references: SymbolReference[] = [];
  const reconciliation: ReconciliationDiagnostic[] = [];
  const indexerDiagnostics: ScipIndexerDiagnostic[] = [];
  if (options.scip !== false) {
    const hasTs = trackedFiles.some((path) => isParseableTypescript(path));
    const hasPy = trackedFiles.some((path) => isParseablePython(path));
    const indexerOptions = { onDiagnostic: (entry: ScipIndexerDiagnostic) => indexerDiagnostics.push(entry) };
    const indexes = [
      ...(hasTs ? [await indexWithScipTypescript(rootPath, indexerOptions)] : []),
      ...(hasPy ? [await indexWithScipPython(rootPath, indexerOptions)] : []),
    ].filter((index) => index !== null);
    let unmapped = 0;
    const extractionByPath = new Map(extractions.map((entry) => [entry.path, JSON.parse(entry.json) as FileExtraction]));
    const sourceFacts = new Map(sources.map((source) => [source.path, { id: fileUri(repositoryName, source.path),
      content: source.content, calls: extractionByPath.get(source.path)?.calls ?? [], inheritance: extractionByPath.get(source.path)?.inheritance ?? [] }]));
    for (const scipIndex of indexes) {
      const enrichment = buildScipEdges(scipIndex, [...symbols.values()], snapshot.id, sourceFacts);
      references.push(...enrichment.references);
      reconciliation.push(...enrichment.diagnostics);
      for (const edge of enrichment.edges) {
        addEdge(edge);
      }
      referencesResolved = (referencesResolved ?? 0) + enrichment.resolvedReferences;
      unmapped += enrichment.unmappedDefinitions;
    }
    const indexedPaths = new Set(indexes.flatMap((index) => index.documents.map((document) => document.relativePath)));
    for (const endpoint of [...symbols.values()].filter((symbol) => symbol.route?.handlerLocation && indexedPaths.has(symbol.path))) {
      const location = endpoint.route!.handlerLocation!;
      const matches = references.filter((reference) => !reference.isDefinition && reference.path === endpoint.path
        && reference.startLine === location.startLine && reference.startColumn === location.startColumn
        && reference.endLine === location.endLine && reference.endColumn === location.endColumn);
      const targets = [...new Set(matches.map((reference) => reference.targetId))];
      // Compiler identity wins over a same-name syntactic guess, including imported aliases.
      for (const [key, edge] of edges) { if (edge.sourceId === endpoint.id && edge.analyzer === 'route-binding') { edges.delete(key); } }
      if (targets.length !== 1) {
        reconciliation.push({ path: endpoint.path, line: location.startLine, symbol: endpoint.qualifiedName,
          reason: 'Named route handler has no unique extracted compiler target; no same-name binding assumed.' });
        continue;
      }
      addEdge({ snapshotId: snapshot.id, sourceId: endpoint.id, targetId: targets[0]!, edgeType: 'CALLS',
        confidence: 0.95, analyzer: 'route-binding-scip', evidence: { path: endpoint.path, ...location, referenceKind: 'registered-handler' } });
    }
    if (indexes.length > 0) {
      metrics.push({
        snapshotId: snapshot.id,
        subjectId: fileUri(repositoryName, '.'),
        name: 'scip_unmapped_definitions',
        value: unmapped,
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

  for (const edge of documentationEdges(documents, files, [...symbols.values()])) { addEdge(edge); }
  metrics.push(...graphMetrics(snapshot.id, [...symbols.values()], files, modules, [...edges.values()]));
  const measuredPaths = new Set(extractions.map((entry) => entry.path));
  const unmeasuredSyntax = files.filter((file) => (isParseableTypescript(file.path) || isParseablePython(file.path)) && !measuredPaths.has(file.path))
    .map((file) => file.path);

  store.db.transaction(() => {
    snapshot.createdAt = new Date().toISOString();
    store.insertSnapshot(snapshot);
    store.insertFiles(files);
    store.insertSnapshotSources(snapshot.id, sources);
    store.insertDocuments(documents);
    store.insertSymbols([...symbols.values()]);
    store.insertExports(exports);
    store.insertReferences(references);
    store.insertEdges([...edges.values()]);
    store.insertModules(modules);
    store.insertTests(tests);
    store.insertMetrics(metrics);
    store.setSnapshotMetadata(snapshot.id, 'configuration_hash', settings.fingerprint);
    store.setSnapshotMetadata(snapshot.id, 'extraction_version', EXTRACTION_VERSION);
    store.setSnapshotMetadata(snapshot.id, 'scip_enabled', String(options.scip !== false));
    store.setSnapshotMetadata(snapshot.id, 'documentation_omissions', JSON.stringify(skippedDocuments));
    store.setSnapshotMetadata(snapshot.id, 'extraction_diagnostics', JSON.stringify(extractionDiagnostics));
    store.setSnapshotMetadata(snapshot.id, 'scip_diagnostics', JSON.stringify({ indexers: indexerDiagnostics, reconciliation }));
    store.setSnapshotMetadata(snapshot.id, 'metrics_status', JSON.stringify({
      syntax: { analyzer: 'tree-sitter-metrics-v1', status: unmeasuredSyntax.length || extractionDiagnostics.some((entry) => entry.message.includes('syntax errors')) ? 'partial' : 'complete',
        omittedFiles: unmeasuredSyntax },
      graph: { analyzer: 'observed-graph-metrics-v1', semanticReferencesAvailable: referencesResolved !== null },
      external: {}, coverage: { status: 'not_imported' },
    }));
    const insert = store.db.prepare('INSERT INTO file_extractions (snapshot_id, path, content_hash, analyzer_version, extraction_json) VALUES (?, ?, ?, ?, ?)');
    for (const extraction of extractions) {
      insert.run(snapshot.id, extraction.path, extraction.contentHash, EXTRACTION_VERSION, extraction.json);
    }
    store.rebuildSearchIndex(snapshot.id);
    refreshOpportunities(store, snapshot.id);
  })();

  if (settings.config.metrics.tools.length || settings.config.metrics.coverage) {
    await collectQuality({ store, snapshotId: snapshot.id, tools: settings.config.metrics.tools, coveragePath: settings.config.metrics.coverage });
  }
  const counts = store.getCounts(snapshot.id);

  return {
    repositoryName,
    snapshotId: snapshot.id,
    commitSha,
    dbPath,
    counts,
    referencesResolved,
    parsing,
    diagnostics: { extraction: extractionDiagnostics.length, scipUnmapped: reconciliation.length, indexers: indexerDiagnostics },
    durationMs: Date.now() - startedAt,
  };
  } finally { store.close(); }
}
