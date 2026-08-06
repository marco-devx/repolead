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

export interface QdrantSearcher {
  ensureCollection(name: string, dimension: number): Promise<void>;
  upsert(name: string, points: QdrantPoint[]): Promise<void>;
  search(name: string, vector: number[], snapshotId: string, limit: number): Promise<QdrantHit[]>;
}

/** Qdrant exige ids UUID o enteros: sym_<32 hex> → formato UUID. */
export function symbolIdToPointId(symbolId: string): string {
  const hex = symbolId.replace(/^sym_/, '').padEnd(32, '0').slice(0, 32);
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
    });
    if (!response.ok) {
      throw new Error(`Qdrant ${method} ${path} → HTTP ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  async ensureCollection(name: string, dimension: number): Promise<void> {
    const exists = await fetch(`${this.baseUrl}/collections/${name}`);
    if (exists.ok) {
      return;
    }
    await this.request('PUT', `/collections/${name}`, {
      vectors: { size: dimension, distance: 'Cosine' },
    });
  }

  async upsert(name: string, points: QdrantPoint[]): Promise<void> {
    await this.request('PUT', `/collections/${name}/points?wait=true`, { points });
  }

  async search(name: string, vector: number[], snapshotId: string, limit: number): Promise<QdrantHit[]> {
    const result = (await this.request('POST', `/collections/${name}/points/search`, {
      vector,
      limit,
      with_payload: true,
      filter: { must: [{ key: 'snapshot_id', match: { value: snapshotId } }] },
    })) as { result: { id: string; score: number; payload?: Record<string, unknown> }[] };
    return result.result.map((hit) => ({ id: String(hit.id), score: hit.score, payload: hit.payload ?? {} }));
  }
}
