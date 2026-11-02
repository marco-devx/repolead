import type { CodeSymbol, KnowledgeItem } from '@repolead/domain';
import type { KnowledgeFilters, KnowledgeStore } from '@repolead/knowledge-store';
import { buildKnowledgeItems } from '@repolead/knowledge-store';

import type { EmbeddingsClient } from './embeddings';
import type { QdrantSearcher } from './qdrant';
import type { RerankerClient } from './reranker';

export interface HybridSearchOptions {
  store: KnowledgeStore;
  snapshotId: string;
  collection: string;
  query: string;
  embeddings?: EmbeddingsClient | null;
  qdrant?: QdrantSearcher | null;
  reranker?: RerankerClient | null;
  candidateLimit?: number;
  limit?: number;
  filters?: KnowledgeFilters;
  onWarning?: (message: string) => void;
}

export interface SearchHit { symbol: CodeSymbol; score: number; sources: string[] }
export interface KnowledgeHit { item: KnowledgeItem; score: number; sources: string[] }

/** Compact symbol label; retrieval uses the full persisted input when available. */
export function symbolText(symbol: CodeSymbol): string {
  return `${symbol.kind} ${symbol.qualifiedName} ${symbol.signature ?? ''} — ${symbol.path}`;
}

const RRF_K = 60;

/** FTS + vectors + graph, with snapshot-checked SQLite content and explicit degradation. */
export async function hybridKnowledgeSearch(options: HybridSearchOptions): Promise<KnowledgeHit[]> {
  const { store, snapshotId, query } = options;
  const limit = options.limit ?? 8;
  const candidateLimit = Math.max(options.candidateLimit ?? 20, limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || !Number.isInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 100) {
    throw new Error('Search limits must be integers between 1 and 100.');
  }
  if (!query.trim()) { return []; }
  const snapshot = store.getSnapshot(snapshotId);
  const repository = snapshot ? store.getRepository(snapshot.repositoryId) : null;
  if (!repository || (options.filters?.repository && options.filters.repository !== repository.name)) { return []; }
  const filters = { ...options.filters, repository: repository.name };
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean))];
  const indexed = store.db.prepare('SELECT 1 FROM knowledge_items WHERE snapshot_id = ? LIMIT 1').get(snapshotId);
  // Old databases can be read without mutating them. A refresh/reindex persists this projection.
  const legacy = indexed ? null : buildKnowledgeItems(store, snapshotId).filter((item) => store.matchesKnowledge(item, filters));
  const legacyById = new Map(legacy?.map((item) => [item.id, item]) ?? []);
  const lexical = legacy
    ? legacy.map((item) => ({ item, rank: terms.filter((term) => item.text.toLowerCase().includes(term)).length }))
      .filter((entry) => entry.rank > 0).sort((a, b) => b.rank - a.rank).slice(0, candidateLimit)
    : store.searchKnowledge(snapshotId, query, candidateLimit, filters);
  const items = new Map(lexical.map((hit) => [hit.item.id, hit.item]));
  const rankLists = [{ ids: lexical.map((hit) => hit.item.id), weight: 1, source: 'fts' }];
  const warn = (stage: string, error: unknown) => options.onWarning?.(`${stage} unavailable; using remaining signals: ${error instanceof Error ? error.message : String(error)}`);

  if (options.embeddings && options.qdrant) {
    try {
      const vector = options.embeddings.embedQuery
        ? await options.embeddings.embedQuery(query) : (await options.embeddings.embed([query]))[0];
      if (!vector?.length || !vector.every(Number.isFinite)) { throw new Error('Invalid query embedding.'); }
      const modelKey = await options.embeddings.cacheKey?.();
      const vectorHits = await options.qdrant.search(options.collection, vector, snapshotId, candidateLimit, { ...filters, embeddingModel: modelKey ?? undefined });
      const ids = new Set<string>();
      for (const hit of vectorHits) {
        const id = hit.payload['item_id'];
        if (typeof id !== 'string' || hit.payload['snapshot_id'] !== snapshotId || hit.payload['repository'] !== repository.name) { continue; }
        if (modelKey && hit.payload['embedding_model'] !== modelKey) { continue; }
        const item = items.get(id) ?? legacyById.get(id) ?? store.getKnowledgeItem(snapshotId, id);
        if (!item || !store.matchesKnowledge(item, filters) || hit.payload['embedding_hash'] !== item.contentHash) { continue; }
        items.set(id, item);
        ids.add(id);
      }
      rankLists.push({ ids: [...ids], weight: 1, source: 'vector' });
    } catch (error) { warn('Vector search', error); }
  }

  const symbolItems = [...items.values()].filter((item) => item.entityKind === 'symbol' || (item.entityKind === 'summary' && item.kind === 'symbol'));
  const subjects = [...new Set(symbolItems.map((item) => item.subjectId))];
  if (subjects.length) {
    const placeholders = subjects.map(() => '?').join(',');
    const rows = store.db.prepare(`SELECT target_id, COUNT(*) AS n FROM edges
      WHERE snapshot_id = ? AND edge_type <> 'CONTAINS' AND target_id IN (${placeholders})
      GROUP BY target_id ORDER BY n DESC, target_id`).all(snapshotId, ...subjects) as { target_id: string; n: number }[];
    rankLists.push({ ids: rows.flatMap((row) => symbolItems.filter((item) => item.subjectId === row.target_id).map((item) => item.id)), weight: 0.5, source: 'graph' });
  }
  const fused = new Map<string, { score: number; sources: Set<string> }>();
  for (const list of rankLists) {
    list.ids.forEach((id, rank) => {
      const entry = fused.get(id) ?? { score: 0, sources: new Set<string>() };
      entry.score += list.weight / (RRF_K + rank + 1);
      entry.sources.add(list.source);
      fused.set(id, entry);
    });
  }
  let candidates: KnowledgeHit[] = [...fused].map(([id, entry]) => ({ item: items.get(id)!, score: entry.score, sources: [...entry.sources] }));
  if (terms.length >= 2) {
    for (const candidate of candidates) {
      const text = candidate.item.text.toLowerCase();
      candidate.score += (terms.filter((term) => text.includes(term)).length / terms.length) ** 2 * 0.03;
    }
  }
  candidates = candidates.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).slice(0, candidateLimit);
  if (options.reranker && candidates.length > 1) {
    try {
      const scores = await options.reranker.rerank(query, candidates.map((candidate) => candidate.item.text));
      if (scores.length !== candidates.length || scores.some((score) => score !== null && !Number.isFinite(score))) { throw new Error('Invalid reranker scores.'); }
      const ranked = candidates.flatMap((candidate, index) => scores[index] === null ? []
        : [{ ...candidate, score: scores[index]!, sources: [...candidate.sources, 'rerank'] }]).sort((a, b) => b.score - a.score);
      const omitted = scores.filter((score) => score === null).length;
      if (omitted) { options.onWarning?.(`Reranker rejected ${omitted} oversized inputs; their fused positions are retained without reranker scores.`); }
      let index = 0;
      candidates = candidates.map((candidate, position) => scores[position] === null ? candidate : ranked[index++]!);
    } catch (error) { warn('Reranker', error); }
  }
  return candidates.slice(0, limit);
}

/** Symbol-only compatibility for code context packs and existing clients. */
export async function hybridSearch(options: HybridSearchOptions): Promise<SearchHit[]> {
  const hits = await hybridKnowledgeSearch({ ...options, filters: { ...options.filters, entityKinds: ['symbol'] } });
  return hits.flatMap((hit) => {
    const symbol = options.store.getSymbol(options.snapshotId, hit.item.subjectId);
    return symbol ? [{ symbol, score: hit.score, sources: hit.sources }] : [];
  });
}
