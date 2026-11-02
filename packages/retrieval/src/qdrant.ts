import { contentHash } from '@repolead/domain';
import type { KnowledgeFilters } from '@repolead/knowledge-store';

export class QdrantRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantHit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface VectorFilters extends KnowledgeFilters { embeddingModel?: string }

export interface QdrantSearcher {
  ensureCollection(name: string, dimension: number): Promise<void>;
  upsert(name: string, points: QdrantPoint[]): Promise<void>;
  search(name: string, vector: number[], snapshotId: string, limit: number, filters?: VectorFilters): Promise<QdrantHit[]>;
  retrieve?(name: string, ids: string[]): Promise<QdrantPoint[]>;
  updatePayloads?(name: string, updates: { ids: string[]; payload: Record<string, unknown> }[]): Promise<void>;
  prune?(name: string, repository: string, generation: string): Promise<void>;
}

/** Qdrant exige ids UUID o enteros: sym_<32 hex> → formato UUID. */
export function symbolIdToPointId(symbolId: string): string {
  const hex = /^sym_[a-f\d]{32}$/i.test(symbolId) ? symbolId.slice(4) : contentHash(symbolId).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Cliente REST mínimo de Qdrant (fuente derivada: siempre reconstruible desde SQLite). */
export class QdrantRestClient implements QdrantSearcher {
  constructor(private readonly baseUrl: string) {}

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new QdrantRequestError(response.status, `Qdrant ${method} ${path} → HTTP ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  async ensureCollection(name: string, dimension: number): Promise<void> {
    const exists = await fetch(`${this.baseUrl}/collections/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(10000) });
    if (exists.ok) {
      const data = await exists.json() as { result: { config: { params: { vectors: { size?: number } } } } };
      if (data.result.config.params.vectors.size !== dimension) {
        throw new Error(`Qdrant collection ${name} has a different vector dimension; choose a new collection for this embedding model.`);
      }
      return;
    }
    if (exists.status !== 404) { throw new Error(`Qdrant collection lookup failed: HTTP ${exists.status}`); }
    await this.request('PUT', `/collections/${encodeURIComponent(name)}`, {
      vectors: { size: dimension, distance: 'Cosine' },
    });
  }

  async upsert(name: string, points: QdrantPoint[]): Promise<void> {
    await this.request('PUT', `/collections/${encodeURIComponent(name)}/points?wait=true`, { points });
  }

  async retrieve(name: string, ids: string[]): Promise<QdrantPoint[]> {
    const response = await this.request('POST', `/collections/${encodeURIComponent(name)}/points`, {
      ids, with_payload: true, with_vector: true,
    }) as { result: QdrantPoint[] };
    return response.result.filter((point) => Array.isArray(point.vector) && point.vector.length > 0);
  }

  async updatePayloads(name: string, updates: { ids: string[]; payload: Record<string, unknown> }[]): Promise<void> {
    if (!updates.length) { return; }
    await this.request('POST', `/collections/${encodeURIComponent(name)}/points/batch?wait=true`, {
      operations: updates.map((update) => ({ set_payload: { points: update.ids, payload: update.payload } })),
    });
  }

  async prune(name: string, repository: string, generation: string): Promise<void> {
    try {
    await this.request('POST', `/collections/${encodeURIComponent(name)}/points/delete?wait=true`, {
      filter: { must: [{ key: 'repository', match: { value: repository } }],
        must_not: [{ key: 'index_generation', match: { value: generation } }] },
    });
    } catch (error) {
      if (!(error instanceof QdrantRequestError) || error.status !== 404) { throw error; }
    }
  }

  async search(name: string, vector: number[], snapshotId: string, limit: number, filters: VectorFilters = {}): Promise<QdrantHit[]> {
    const must: Record<string, unknown>[] = [{ key: 'snapshot_id', match: { value: snapshotId } }];
    for (const [key, value] of Object.entries({ repository: filters.repository, language: filters.language, kind: filters.kind, embedding_model: filters.embeddingModel })) {
      if (value) { must.push({ key, match: { value } }); }
    }
    if (filters.entityKinds?.length) { must.push({ key: 'entity_kind', match: { any: filters.entityKinds } }); }
    if (filters.module) { must.push({ should: [
      { key: 'module', match: { value: filters.module } }, { key: 'module_path', match: { value: filters.module } },
    ] }); }
    const result = (await this.request('POST', `/collections/${encodeURIComponent(name)}/points/search`, {
      vector,
      limit,
      with_payload: true,
      filter: { must },
    })) as { result: { id: string; score: number; payload?: Record<string, unknown> }[] };
    return result.result.map((hit) => ({ id: String(hit.id), score: hit.score, payload: hit.payload ?? {} }));
  }
}
