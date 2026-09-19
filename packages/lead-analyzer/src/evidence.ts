import type { Module } from '@repolead/domain';
import { contentHash } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import { countTokens, owningModule, rankSymbols, validateTokenBudget } from '@repolead/retrieval';

export interface AnalysisBudget {
  maxTokens?: number;
  /** Optional compatibility caps; tokens are the default constraint. */
  maxSymbolsPerPack?: number;
  maxEdgesPerPack?: number;
}

export const DEFAULT_BUDGET: AnalysisBudget = { maxTokens: 4000 };

export interface ModuleEvidencePack {
  module: { name: string; path: string };
  /** Hashes all owned code and incident dependencies, including omitted evidence. */
  fingerprint: string;
  files: { path: string; language: string | null; lineCount: number | null; commitCount: number }[];
  symbols: {
    qualifiedName: string; kind: string; signature: string | null; path: string;
    startLine: number; endLine: number; fanIn: number;
  }[];
  internalEdges: { from: string; to: string; type: string }[];
  incomingDependencies: string[];
  outgoingDependencies: string[];
  tests: { path: string; name: string }[];
  coChanges: { file: string; with: string; count: number }[];
  truncation: {
    droppedSymbols: number; droppedEdges: number; droppedFiles: number;
    droppedDependencies: number; droppedTests: number; droppedCoChanges: number;
  };
}

/** Aider-style selection; content/dependency invalidation inspired by CocoIndex. */
export function buildModuleEvidencePack(
  store: KnowledgeStore,
  snapshotId: string,
  module: Module,
  budget: AnalysisBudget = DEFAULT_BUDGET,
): ModuleEvidencePack {
  const maxTokens = validateTokenBudget(budget.maxTokens ?? DEFAULT_BUDGET.maxTokens!);
  const modules = store.listModules(snapshotId);
  const belongs = (path: string): boolean => owningModule(path, modules)?.id === module.id;
  const graph = store.loadGraph(snapshotId);
  const symbols = rankSymbols(graph).filter((symbol) => belongs(symbol.path));
  const ownIds = new Set(symbols.map((symbol) => symbol.id));
  const files = store.db.prepare('SELECT id, path, language, line_count, content_hash FROM files WHERE snapshot_id = ? ORDER BY path')
    .all(snapshotId) as { id: string; path: string; language: string | null; line_count: number | null; content_hash: string }[];
  const ownFiles = files.filter((file) => belongs(file.path));
  const ownSubjects = new Set([...ownIds, ...ownFiles.map((file) => file.id)]);
  const edges = [...graph.outgoing.values()].flat().filter((edge) => edge.edgeType !== 'CONTAINS');
  const internal = edges.filter((edge) => ownIds.has(edge.sourceId) && ownIds.has(edge.targetId));
  const boundary = edges.filter((edge) => ownSubjects.has(edge.sourceId) !== ownSubjects.has(edge.targetId));
  const incident = edges.filter((edge) => ownSubjects.has(edge.sourceId) || ownSubjects.has(edge.targetId));
  const externalIds = new Set(boundary.flatMap((edge) => [edge.sourceId, edge.targetId]).filter((id) => !ownSubjects.has(id)));
  const fileNames = new Map(files.map((file) => [file.id, file.path]));
  const label = (id: string): string => graph.symbols.get(id)?.qualifiedName ?? fileNames.get(id) ?? id;
  const incoming = [...new Set(boundary.filter((edge) => ownSubjects.has(edge.targetId)).map((edge) => label(edge.sourceId)))].sort();
  const outgoing = [...new Set(boundary.filter((edge) => ownSubjects.has(edge.sourceId)).map((edge) => label(edge.targetId)))].sort();
  const commitRows = store.db.prepare("SELECT subject_id, value FROM metrics WHERE snapshot_id = ? AND name = 'commit_count'")
    .all(snapshotId) as { subject_id: string; value: number }[];
  const commits = new Map(commitRows.map((row) => [row.subject_id, row.value]));
  const tests = (store.db.prepare('SELECT path, name FROM tests WHERE snapshot_id = ? ORDER BY path, name').all(snapshotId) as { path: string; name: string }[])
    .filter((test) => belongs(test.path));
  const coChanges = (store.db.prepare("SELECT subject_id, name, value FROM metrics WHERE snapshot_id = ? AND name LIKE 'co_change:%' ORDER BY subject_id, name")
    .all(snapshotId) as { subject_id: string; name: string; value: number }[])
    .map((row) => ({ file: fileNames.get(row.subject_id) ?? row.subject_id, with: row.name.slice('co_change:'.length), count: row.value }))
    .filter((entry) => belongs(entry.file) || belongs(entry.with));
  const fingerprint = contentHash(JSON.stringify({
    files: ownFiles.map((file) => [file.path, file.content_hash]),
    symbols: symbols.map((symbol) => [symbol.id, symbol.contentHash]).sort(),
    edges: incident.map((edge) => [edge.sourceId, edge.targetId, edge.edgeType, edge.analyzer]).sort(),
    dependencies: [...externalIds].sort().map((id) => [id, graph.symbols.get(id)?.contentHash ?? files.find((file) => file.id === id)?.content_hash]),
  }));
  const pack: ModuleEvidencePack = {
    module: { name: module.name, path: module.path }, fingerprint,
    files: [], symbols: [], internalEdges: [], incomingDependencies: [], outgoingDependencies: [], tests: [], coChanges: [],
    truncation: {
      droppedSymbols: symbols.length, droppedEdges: internal.length, droppedFiles: ownFiles.length,
      droppedDependencies: incoming.length + outgoing.length, droppedTests: tests.length, droppedCoChanges: coChanges.length,
    },
  };
  const fits = (): boolean => countTokens(JSON.stringify(pack)) <= maxTokens;
  if (!fits()) {
    throw new Error('Presupuesto insuficiente para los metadatos de ' + module.name);
  }
  const add = <T>(list: T[], item: T, counter: keyof ModuleEvidencePack['truncation']): boolean => {
    list.push(item);
    pack.truncation[counter] -= 1;
    if (fits()) {
      return true;
    }
    list.pop();
    pack.truncation[counter] += 1;
    return false;
  };
  // Reserve a quarter for relations/files/tests instead of consuming everything on signatures.
  const keptIds = new Set<string>();
  for (const symbol of symbols) {
    if (pack.symbols.length >= (budget.maxSymbolsPerPack ?? Infinity)) {
      break;
    }
    const item = {
      qualifiedName: symbol.qualifiedName, kind: symbol.kind, signature: symbol.signature, path: symbol.path,
      startLine: symbol.startLine, endLine: symbol.endLine,
      fanIn: (graph.incoming.get(symbol.id) ?? []).filter((edge) => edge.edgeType !== 'CONTAINS').length,
    };
    if (countTokens(JSON.stringify(pack)) > maxTokens * 0.75) {
      break;
    }
    if (add(pack.symbols, item, 'droppedSymbols')) {
      keptIds.add(symbol.id);
    }
  }
  for (const edge of internal) {
    if (pack.internalEdges.length >= (budget.maxEdgesPerPack ?? Infinity)) {
      break;
    }
    if (keptIds.has(edge.sourceId) && keptIds.has(edge.targetId)) {
      add(pack.internalEdges, { from: label(edge.sourceId), to: label(edge.targetId), type: edge.edgeType }, 'droppedEdges');
    }
  }
  for (const dependency of incoming) {
    add(pack.incomingDependencies, dependency, 'droppedDependencies');
  }
  for (const dependency of outgoing) {
    add(pack.outgoingDependencies, dependency, 'droppedDependencies');
  }
  for (const file of ownFiles) {
    add(pack.files, { path: file.path, language: file.language, lineCount: file.line_count, commitCount: commits.get(file.id) ?? 0 }, 'droppedFiles');
  }
  for (const test of tests) {
    add(pack.tests, test, 'droppedTests');
  }
  for (const entry of coChanges) {
    add(pack.coChanges, entry, 'droppedCoChanges');
  }
  return pack;
}

/** Bound the final synthesis too; its cache still depends on every complete dossier. */
export function buildRepositoryEvidencePack(
  repository: string,
  stats: Record<string, number>,
  dossiers: { module: string; dossier: unknown }[],
  maxTokens = DEFAULT_BUDGET.maxTokens!,
) {
  validateTokenBudget(maxTokens);
  const pack = {
    repository, stats, fingerprint: contentHash(JSON.stringify(dossiers)),
    modules: [] as { module: string; dossier: Record<string, unknown> }[],
    truncation: { omittedModules: dossiers.length, omittedSections: 0 },
  };
  const fits = (): boolean => countTokens(JSON.stringify(pack)) <= maxTokens;
  if (!fits()) {
    throw new Error('Presupuesto insuficiente para el resumen del repositorio.');
  }
  const sections = ['responsibility', 'publicApi', 'dependencies', 'risks', 'mainFlows', 'testStrategy', 'strengths', 'opportunities'];
  const retained: { source: Record<string, unknown>; target: Record<string, unknown> }[] = [];
  for (const entry of dossiers) {
    const source = entry.dossier && typeof entry.dossier === 'object' ? entry.dossier as Record<string, unknown> : {};
    const target: Record<string, unknown> = {};
    pack.modules.push({ module: entry.module, dossier: target });
    pack.truncation.omittedModules -= 1;
    const sectionCount = sections.filter((section) => section in source).length;
    pack.truncation.omittedSections += sectionCount;
    if (fits()) {
      retained.push({ source, target });
    } else {
      pack.modules.pop();
      pack.truncation.omittedModules += 1;
      pack.truncation.omittedSections -= sectionCount;
    }
  }
  // Round-robin by section so one large dossier cannot hide all later modules.
  for (const section of sections) {
    for (const { source, target } of retained) {
      if (!(section in source)) {
        continue;
      }
      target[section] = source[section];
      pack.truncation.omittedSections -= 1;
      if (!fits()) {
        delete target[section];
        pack.truncation.omittedSections += 1;
      }
    }
  }
  return pack;
}
