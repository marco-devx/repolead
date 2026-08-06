import type { Command } from 'commander';

import { openStore } from '@repolead/knowledge-store';
import {
  QdrantRestClient,
  TeiEmbeddingsClient,
  TeiRerankerClient,
  hybridSearch,
  indexSnapshot,
} from '@repolead/retrieval';

const DEFAULT_DB = '.repolead/repolead.db';
const COLLECTION = 'repolead-symbols';

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function serviceUrls(): { tei: string; qdrant: string; reranker: string } {
  return {
    tei: process.env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8080',
    qdrant: process.env['REPOLEAD_QDRANT_URL'] ?? 'http://localhost:6333',
    reranker: process.env['REPOLEAD_RERANKER_URL'] ?? 'http://localhost:8081',
  };
}

export function registerQuery(program: Command): void {
  program
    .command('query')
    .description('Consulta el conocimiento del repositorio (FTS5 + vectores + grafo)')
    .argument('<text...>', 'consulta en lenguaje natural')
    .option('--db <path>', 'ruta del archivo SQLite', DEFAULT_DB)
    .option('--limit <n>', 'evidencias finales', '8')
    .action(async (text: string[], options: { db: string; limit: string }) => {
      const store = await openStore(options.db);
      const snapshot = store.getLatestSnapshot();
      if (!snapshot) {
        console.error('No hay snapshots: corre `repolead scan` primero.');
        process.exitCode = 1;
        return;
      }

      const urls = serviceUrls();
      const [teiUp, qdrantUp, rerankerUp] = await Promise.all([
        reachable(`${urls.tei}/health`),
        reachable(`${urls.qdrant}/healthz`),
        reachable(`${urls.reranker}/health`),
      ]);

      const hits = await hybridSearch({
        store,
        snapshotId: snapshot.id,
        collection: COLLECTION,
        query: text.join(' '),
        embeddings: teiUp ? new TeiEmbeddingsClient(urls.tei) : null,
        qdrant: qdrantUp ? new QdrantRestClient(urls.qdrant) : null,
        reranker: rerankerUp ? new TeiRerankerClient(urls.reranker) : null,
        limit: Number(options.limit),
      });

      if (!teiUp || !qdrantUp) {
        console.log('− búsqueda vectorial desactivada (TEI/Qdrant no disponibles) — solo FTS5 + grafo\n');
      }
      if (hits.length === 0) {
        console.log('Sin resultados.');
        return;
      }
      for (const [index, hit] of hits.entries()) {
        const { symbol } = hit;
        console.log(
          `${String(index + 1).padStart(2)}. ${symbol.qualifiedName} (${symbol.kind})  ${symbol.path}:${symbol.startLine}-${symbol.endLine}`,
        );
        console.log(`    score ${hit.score.toFixed(4)} · ${hit.sources.join(' + ')}`);
      }
      store.close();
    });
}

export function registerReindex(program: Command): void {
  program
    .command('reindex')
    .description('Reconstruye el índice vectorial en Qdrant desde SQLite (fuente de verdad)')
    .option('--db <path>', 'ruta del archivo SQLite', DEFAULT_DB)
    .action(async (options: { db: string }) => {
      const urls = serviceUrls();
      const [teiUp, qdrantUp] = await Promise.all([
        reachable(`${urls.tei}/health`),
        reachable(`${urls.qdrant}/healthz`),
      ]);
      if (!teiUp || !qdrantUp) {
        console.error('Necesitas TEI y Qdrant corriendo: docker compose up -d');
        process.exitCode = 1;
        return;
      }

      const store = await openStore(options.db);
      const snapshot = store.getLatestSnapshot();
      if (!snapshot) {
        console.error('No hay snapshots: corre `repolead scan` primero.');
        process.exitCode = 1;
        return;
      }
      const repository = store.getRepository(snapshot.repositoryId);

      const count = await indexSnapshot({
        store,
        snapshotId: snapshot.id,
        repositoryName: repository?.name ?? 'unknown',
        collection: COLLECTION,
        embeddings: new TeiEmbeddingsClient(urls.tei),
        qdrant: new QdrantRestClient(urls.qdrant),
      });
      console.log(`✓ ${count} símbolos vectorizados en Qdrant (colección ${COLLECTION})`);
      store.close();
    });
}
