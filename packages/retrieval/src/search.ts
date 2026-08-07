import type { CodeSymbol } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';

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
  /** Candidatos que entran al reranker (default 20). */
  candidateLimit?: number;
  /** Evidencias finales (default 8). */
  limit?: number;
}

export interface SearchHit {
  symbol: CodeSymbol;
  score: number;
  sources: string[];
}

/** Texto que representa a un símbolo ante embeddings y reranker. */
export function symbolText(symbol: CodeSymbol): string {
  return `${symbol.kind} ${symbol.qualifiedName} ${symbol.signature ?? ''} — ${symbol.path}`;
}

const RRF_K = 60;

/**
 * Pipeline del plan: FTS5 + vector search + señal de grafo → fusión RRF →
 * ~20 candidatos → reranker → 5–8 evidencias. Cada etapa degrada con
 * gracia si su servicio no está disponible.
 */
export async function hybridSearch(options: HybridSearchOptions): Promise<SearchHit[]> {
  const { store, snapshotId, query } = options;
  const candidateLimit = options.candidateLimit ?? 20;
  const limit = options.limit ?? 8;

  const symbols = new Map<string, CodeSymbol>();
  const rankLists: { ids: string[]; weight: number; source: string }[] = [];

  const ftsHits = store.searchSymbols(snapshotId, query, candidateLimit);
  for (const hit of ftsHits) {
    symbols.set(hit.symbol.id, hit.symbol);
  }
  rankLists.push({ ids: ftsHits.map((hit) => hit.symbol.id), weight: 1, source: 'fts' });

  if (options.embeddings && options.qdrant) {
    const [vector] = await options.embeddings.embed([query]);
    if (vector) {
      const vectorHits = await options.qdrant.search(options.collection, vector, snapshotId, candidateLimit);
      const ids: string[] = [];
      for (const hit of vectorHits) {
        const symbolId = typeof hit.payload['symbol_id'] === 'string' ? hit.payload['symbol_id'] : null;
        if (!symbolId) {
          continue;
        }
        const symbol = symbols.get(symbolId) ?? store.getSymbol(snapshotId, symbolId);
        if (symbol) {
          symbols.set(symbolId, symbol);
          ids.push(symbolId);
        }
      }
      rankLists.push({ ids, weight: 1, source: 'vector' });
    }
  }

  // Señal de grafo: fan-in de cada candidato (símbolos muy referenciados pesan más).
  const candidateIds = [...symbols.keys()];
  if (candidateIds.length > 0) {
    const placeholders = candidateIds.map(() => '?').join(', ');
    const rows = store.db
      .prepare(
        `SELECT target_id, COUNT(*) AS n FROM edges
         WHERE snapshot_id = ? AND target_id IN (${placeholders})
         GROUP BY target_id ORDER BY n DESC`,
      )
      .all(snapshotId, ...candidateIds) as { target_id: string; n: number }[];
    rankLists.push({ ids: rows.map((row) => row.target_id), weight: 0.5, source: 'graph' });
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

  let candidates = [...fused.entries()]
    .map(([id, entry]) => ({ symbol: symbols.get(id), score: entry.score, sources: [...entry.sources] }))
    .filter((entry): entry is SearchHit => entry.symbol !== undefined);

  // Term-coverage bonus: with multi-term queries, candidates matching more
  // distinct terms outrank a single rare-term exact hit, without burying
  // vector-only semantic matches (bonus, not multiplier).
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter((term) => term.length > 2))];
  if (terms.length >= 2) {
    for (const candidate of candidates) {
      const text = symbolText(candidate.symbol).toLowerCase();
      const matched = terms.filter((term) => text.includes(term)).length;
      candidate.score += (matched / terms.length) ** 2 * 0.03;
    }
  }

  candidates = candidates.sort((left, right) => right.score - left.score).slice(0, candidateLimit);

  if (options.reranker && candidates.length > 1) {
    const scores = await options.reranker.rerank(
      query,
      candidates.map((candidate) => symbolText(candidate.symbol)),
    );
    candidates = candidates
      .map((candidate, index) => ({ ...candidate, score: scores[index] ?? 0, sources: [...candidate.sources, 'rerank'] }))
      .sort((left, right) => right.score - left.score);
  }

  return candidates.slice(0, limit);
}
