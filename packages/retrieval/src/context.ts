import type { CodeSymbol, Edge, Module } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';

import { rankSymbols } from './ranking';
import { readIndexedSource } from './source';
import { countTokens, TOKENIZER, validateTokenBudget } from './tokens';

export function owningModule(path: string, modules: Module[]): Module | undefined {
  return modules.filter((module) => module.path === '.' || path.startsWith(`${module.path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

export interface ContextOptions {
  store: KnowledgeStore;
  snapshotId: string;
  query?: string;
  module?: string;
  symbols?: string[];
  seedIds?: string[];
  maxTokens?: number;
  includeSource?: boolean;
  exposeSource?: boolean;
}

export interface ContextPack {
  text: string;
  tokens: number;
  tokenizer: string;
  budget: number;
  symbolIds: string[];
  sourceSymbolIds: string[];
  totalSymbols: number;
  totalEdges: number;
  includedEdges: number;
  sourceOmissions: string[];
}

/** Task-specific map and optional complete source spans, under a measured token budget. */
export function buildContextPack(options: ContextOptions): ContextPack {
  const { store, snapshotId } = options;
  const budget = validateTokenBudget(options.maxTokens ?? 2000);
  if ((options.query?.length ?? 0) > 2000) {
    throw new Error('La consulta admite hasta 2000 caracteres.');
  }
  const snapshot = store.db.prepare('SELECT repository_id, commit_sha FROM snapshots WHERE id = ?')
    .get(snapshotId) as { repository_id: string; commit_sha: string } | undefined;
  if (!snapshot) {
    throw new Error('Snapshot desconocido.');
  }
  const repo = store.getRepository(snapshot.repository_id)!;
  const graph = store.loadGraph(snapshotId);
  const modules = store.listModules(snapshotId);
  let candidates = [...graph.symbols.values()];
  if (options.module) {
    const matches = modules.filter((module) => module.name === options.module || module.path === options.module);
    if (matches.length !== 1) {
      throw new Error('Módulo desconocido o ambiguo; usa la ruta del módulo.');
    }
    candidates = candidates.filter((symbol) => owningModule(symbol.path, modules)?.id === matches[0]!.id);
  }
  const eligible = new Set(candidates.map((symbol) => symbol.id));
  const seeds = new Set((options.seedIds ?? []).filter((id) => eligible.has(id)));
  for (const name of options.symbols ?? []) {
    const matches = candidates.filter((symbol) => symbol.id === name || symbol.qualifiedName === name);
    if (matches.length !== 1) {
      throw new Error(`Símbolo desconocido o ambiguo: ${name}; usa su ID o limita el módulo.`);
    }
    seeds.add(matches[0]!.id);
  }
  const ranked = rankSymbols(graph, options.query, seeds).filter((symbol) => eligible.has(symbol.id));
  if (seeds.size === 0 && options.query) {
    for (const symbol of ranked.slice(0, 3)) {
      seeds.add(symbol.id);
    }
  }
  // A task needs the seed and its immediate callers/callees, not every unrelated symbol.
  if (seeds.size > 0) {
    const nearby = new Set(seeds);
    for (const id of seeds) {
      const related = options.includeSource
        ? graph.outgoing.get(id) ?? []
        : [...(graph.incoming.get(id) ?? []), ...(graph.outgoing.get(id) ?? [])];
      for (const edge of related) {
        if (edge.edgeType !== 'CONTAINS') {
          nearby.add(edge.sourceId);
          nearby.add(edge.targetId);
        }
      }
    }
    candidates = ranked.filter((symbol) => nearby.has(symbol.id));
  } else {
    candidates = ranked;
  }
  const scopeIds = new Set(candidates.map((symbol) => symbol.id));
  const edges: Edge[] = [];
  for (const id of scopeIds) {
    edges.push(...(graph.outgoing.get(id) ?? []).filter((edge) =>
      edge.edgeType !== 'CONTAINS' && scopeIds.has(edge.targetId)));
  }
  edges.sort((left, right) => right.confidence - left.confidence ||
    `${left.sourceId}${left.targetId}${left.edgeType}`.localeCompare(`${right.sourceId}${right.targetId}${right.edgeType}`));

  const selected: CodeSymbol[] = [];
  const selectedEdges: Edge[] = [];
  const sources: { symbol: CodeSymbol; text: string }[] = [];
  const sourceOmissions: string[] = [];
  const render = (): string => {
    const ids = new Map(selected.map((symbol, index) => [symbol.id, index + 1]));
    const covered = (symbol: CodeSymbol): boolean => sources.some((entry) => entry.symbol.path === symbol.path &&
      entry.symbol.startLine <= symbol.startLine && entry.symbol.endLine >= symbol.endLine);
    return [
      `RepoLead ${repo.name} @${snapshot.commit_sha.slice(0, 12)} (${snapshotId})`,
      `Budget ${budget} ${TOKENIZER} (proxy); symbols ${selected.length}/${candidates.length}; relations ${selectedEdges.length}/${edges.length}; complete sources ${sources.length}; omitted sources ${sourceOmissions.length}.`,
      ...selected.filter((symbol) => !covered(symbol)).map((symbol) => `${ids.get(symbol.id)}. ${symbol.path}:${symbol.startLine}-${symbol.endLine} ${symbol.kind} ${symbol.qualifiedName}${symbol.signature ? ` ${symbol.signature}` : ''}`),
      ...selectedEdges.map((edge) => `${ids.get(edge.sourceId)} -${edge.edgeType}-> ${ids.get(edge.targetId)} [${edge.analyzer}]`),
      ...sources.map(({ symbol, text }) => `SOURCE ${ids.get(symbol.id) ?? '-'} ${symbol.qualifiedName} ${symbol.path}:${symbol.startLine}-${symbol.endLine}\n${text}`),
      ...(sourceOmissions.length > 0 ? ['Some requested sources did not fit, were stale, unavailable, or disabled; request them separately.'] : []),
    ].join('\n');
  };
  const fits = (): boolean => countTokens(render()) <= budget;
  if (!fits()) {
    throw new Error('El presupuesto no alcanza para los metadatos; aumenta maxTokens.');
  }
  // Reserve seed map rows before adding their source, so exact matches remain discoverable.
  for (const symbol of candidates.filter((symbol) => seeds.has(symbol.id))) {
    selected.push(symbol);
    if (!fits()) {
      selected.pop();
    }
  }
  if (options.includeSource) {
    const requests = candidates.filter((symbol) => seeds.has(symbol.id));
    if (requests.length === 0) {
      requests.push(...candidates.slice(0, 3));
    }
    requests.sort((left, right) => (right.endLine - right.startLine) - (left.endLine - left.startLine));
    for (const symbol of requests) {
      try {
        if (options.exposeSource === false) {
          throw new Error('source access disabled');
        }
        const source = readIndexedSource(store, snapshotId, repo.rootPath, symbol.path);
        if (sources.some((entry) => entry.symbol.path === symbol.path && entry.symbol.startLine <= symbol.startLine && entry.symbol.endLine >= symbol.endLine)) {
          continue;
        }
        const text = source.split('\n').slice(symbol.startLine - 1, symbol.endLine)
          .map((line, index) => `${symbol.startLine + index}\t${line}`).join('\n');
        sources.push({ symbol, text });
        if (!fits()) {
          sources.pop();
          sourceOmissions.push(symbol.id);
        }
      } catch {
        sourceOmissions.push(symbol.id);
      }
    }
  }
  for (const symbol of candidates) {
    if (selected.some((item) => item.id === symbol.id)) {
      continue;
    }
    selected.push(symbol);
    if (!fits()) {
      selected.pop();
    }
  }
  const selectedIds = new Set(selected.map((symbol) => symbol.id));
  for (const edge of edges) {
    if (!selectedIds.has(edge.sourceId) || !selectedIds.has(edge.targetId)) {
      continue;
    }
    selectedEdges.push(edge);
    if (!fits()) {
      selectedEdges.pop();
    }
  }
  // Omission metadata itself consumes tokens. Never return a silently oversized response.
  while (!fits() && (selectedEdges.length > 0 || selected.length > 0 || sources.length > 0)) {
    if (selectedEdges.length > 0) {
      selectedEdges.pop();
    } else if (selected.length > 0) {
      selected.pop();
    } else {
      const removed = sources.pop()!;
      sourceOmissions.push(removed.symbol.id);
    }
  }
  const text = render();
  if (countTokens(text) > budget) {
    throw new Error('El presupuesto no alcanza para los metadatos.');
  }
  return {
    text, tokens: countTokens(text), tokenizer: TOKENIZER, budget,
    symbolIds: selected.map((symbol) => symbol.id),
    sourceSymbolIds: candidates.filter((symbol) => sources.some((entry) => entry.symbol.path === symbol.path &&
      entry.symbol.startLine <= symbol.startLine && entry.symbol.endLine >= symbol.endLine)).map((symbol) => symbol.id),
    totalSymbols: candidates.length, totalEdges: edges.length, includedEdges: selectedEdges.length, sourceOmissions,
  };
}
