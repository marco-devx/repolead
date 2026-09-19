import { contentHash } from '@repolead/domain';

export interface EmbeddingsClient {
  embed(texts: string[]): Promise<number[][]>;
  /** Identity of weights/configuration; no identity means no vector reuse. */
  cacheKey?(): Promise<string | null>;
}

const BATCH_SIZE = 32;

/** Cliente de Hugging Face Text Embeddings Inference (POST /embed). */
export class TeiEmbeddingsClient implements EmbeddingsClient {
  constructor(private readonly baseUrl: string) {}

  async cacheKey(): Promise<string | null> {
    try {
      const response = await fetch(`${this.baseUrl}/info`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) {
        return null;
      }
      const info = await response.json() as Record<string, unknown>;
      if (typeof info['model_id'] !== 'string' || typeof info['model_sha'] !== 'string') {
        return null;
      }
      return contentHash(JSON.stringify(Object.fromEntries(Object.entries(info).sort())));
    } catch {
      return null;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let index = 0; index < texts.length; index += BATCH_SIZE) {
      const batch = texts.slice(index, index + BATCH_SIZE);
      const response = await fetch(`${this.baseUrl}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: batch }),
      });
      if (!response.ok) {
        throw new Error(`TEI /embed → HTTP ${response.status}: ${await response.text()}`);
      }
      vectors.push(...((await response.json()) as number[][]));
    }
    return vectors;
  }
}
