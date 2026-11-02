export interface RerankerClient {
  /** Un score por documento, en orden de entrada; null = entrada rechazada por longitud. */
  rerank(query: string, documents: string[]): Promise<(number | null)[]>;
}

/** Cliente del endpoint /rerank de TEI, con entradas completas y validación de índices. */
export class TeiRerankerClient implements RerankerClient {
  constructor(private readonly baseUrl: string) {}

  async rerank(query: string, documents: string[]): Promise<(number | null)[]> {
    const scores: (number | null)[] = [];
    for (let start = 0; start < documents.length; start += 32) {
      scores.push(...await this.batch(query, documents.slice(start, start + 32)));
    }
    return scores;
  }

  private async batch(query: string, documents: string[]): Promise<(number | null)[]> {
    const response = await fetch(`${this.baseUrl}/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, texts: documents, truncate: false }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      const message = await response.text();
      if ([413, 422].includes(response.status) && /tokens|too large|batch size|input.{0,30}length/i.test(message)) {
        // Isolate unsupported inputs without truncation or disabling reranking for all candidates.
        if (documents.length === 1) { return [null]; }
        const middle = Math.ceil(documents.length / 2);
        return [...await this.batch(query, documents.slice(0, middle)), ...await this.batch(query, documents.slice(middle))];
      }
      throw new Error(`TEI /rerank → HTTP ${response.status}: ${message}`);
    }
    const ranked = (await response.json()) as { index: number; score: number }[];
    if (!Array.isArray(ranked) || ranked.length !== documents.length || new Set(ranked.map((entry) => entry.index)).size !== documents.length
      || ranked.some((entry) => !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= documents.length || !Number.isFinite(entry.score))) {
      throw new Error('TEI reranker returned invalid scores or indices.');
    }
    const scores = new Array<number>(documents.length).fill(0);
    for (const entry of ranked) {
      scores[entry.index] = entry.score;
    }
    return scores;
  }
}
