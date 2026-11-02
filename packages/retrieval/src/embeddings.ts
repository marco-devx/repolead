import { contentHash } from '@repolead/domain';

export interface EmbeddingsClient {
  embed(texts: string[]): Promise<number[][]>;
  embedQuery?(query: string): Promise<number[]>;
  /** Identity of weights/configuration; no identity means no vector reuse. */
  cacheKey?(): Promise<string | null>;
}

const BATCH_SIZE = 32;

export class EmbeddingInputError extends Error {}

/** Cliente de Hugging Face Text Embeddings Inference (POST /embed). */
export class TeiEmbeddingsClient implements EmbeddingsClient {
  private information: Promise<Record<string, unknown> | null> | null = null;
  constructor(private readonly baseUrl: string) {}

  private info(): Promise<Record<string, unknown> | null> {
    this.information ??= this.readInfo();
    return this.information;
  }

  private async readInfo(): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetch(`${this.baseUrl}/info`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) {
        return null;
      }
      return await response.json() as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async cacheKey(): Promise<string | null> {
    const info = await this.info();
    if (!info || typeof info['model_id'] !== 'string' || typeof info['model_sha'] !== 'string'
      || !/^[a-f\d]{40,64}$/i.test(info['model_sha'])) { return null; }
    return contentHash(JSON.stringify({ model: info['model_id'], revision: info['model_sha'],
      dtype: info['model_dtype'], type: info['model_type'], version: info['version'], build: info['sha'],
      processing: 'complete-document-normalized-v2' }));
  }

  async embedQuery(query: string): Promise<number[]> {
    const info = await this.info();
    const text = String(info?.['model_id'] ?? '').startsWith('Qwen/Qwen3-Embedding')
      ? `Instruct: Given a question about a software repository, retrieve relevant code, documentation and evidence.\nQuery:${query}` : query;
    return (await this.embed([text]))[0]!;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let index = 0; index < texts.length; index += BATCH_SIZE) {
      const batch = texts.slice(index, index + BATCH_SIZE);
      const response = await fetch(`${this.baseUrl}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: batch, truncate: false, normalize: true }),
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) {
        const message = `TEI /embed → HTTP ${response.status}: ${await response.text()}`;
        if ([400, 413, 422].includes(response.status)) { throw new EmbeddingInputError(message); }
        throw new Error(message);
      }
      const returned = await response.json() as number[][];
      if (!Array.isArray(returned) || returned.length !== batch.length
        || returned.some((vector) => !Array.isArray(vector) || !vector.length || vector.some((value) => !Number.isFinite(value)))) {
        throw new Error('TEI returned invalid vectors or an incorrect batch length.');
      }
      vectors.push(...returned);
    }
    return vectors;
  }
}
