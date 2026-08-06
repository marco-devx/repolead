export interface EmbeddingsClient {
  embed(texts: string[]): Promise<number[][]>;
}

const BATCH_SIZE = 32;

/** Cliente de Hugging Face Text Embeddings Inference (POST /embed). */
export class TeiEmbeddingsClient implements EmbeddingsClient {
  constructor(private readonly baseUrl: string) {}

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
