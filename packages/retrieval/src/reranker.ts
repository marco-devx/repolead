export interface RerankerClient {
  /** Devuelve un score por documento, en el mismo orden de entrada. */
  rerank(query: string, documents: string[]): Promise<number[]>;
}

/** Cliente del endpoint /rerank de TEI (modelos reranker tipo Qwen3-Reranker seq-cls). */
export class TeiRerankerClient implements RerankerClient {
  constructor(private readonly baseUrl: string) {}

  async rerank(query: string, documents: string[]): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, texts: documents }),
    });
    if (!response.ok) {
      throw new Error(`TEI /rerank → HTTP ${response.status}: ${await response.text()}`);
    }
    const ranked = (await response.json()) as { index: number; score: number }[];
    const scores = new Array<number>(documents.length).fill(0);
    for (const entry of ranked) {
      scores[entry.index] = entry.score;
    }
    return scores;
  }
}
