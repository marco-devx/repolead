import { Option } from 'commander';
import type { Command } from 'commander';

import { KNOWLEDGE_KINDS } from '@repolead/domain';
import type { KnowledgeKind } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { TeiEmbeddingsClient, hybridKnowledgeSearch, indexSnapshot, indexedCollection, defaultEmbeddingCollection, retrievalServices, vectorBackend } from '@repolead/retrieval';

import { printVectorProgress } from './vector-progress';

const DEFAULT_DB = '.repolead/repolead.db';

async function reachable(url: string): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
}

function serviceUrls(): { tei: string; qdrant: string; reranker: string } {
  return {
    tei: process.env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8082',
    qdrant: process.env['REPOLEAD_QDRANT_URL'] ?? 'http://localhost:6333',
    reranker: process.env['REPOLEAD_RERANKER_URL'] ?? 'http://localhost:8081',
  };
}

export function registerQuery(program: Command): void {
  program.command('query')
    .description('Consulta código, resúmenes, documentos, hallazgos y tests (FTS5 + vectores + grafo)')
    .argument('<text...>', 'consulta en lenguaje natural')
    .option('--db <path>', 'ruta del archivo SQLite', DEFAULT_DB)
    .option('--limit <n>', 'resultados finales (1–100)', '8')
    .option('--collection <name>', 'colección Qdrant (default: registrada en el snapshot)')
    .option('--snapshot <id>', 'snapshot SQLite (default: último; Qdrant conserva solo el último)')
    .addOption(new Option('--type <type>', 'tipo de conocimiento').choices([...KNOWLEDGE_KINDS]))
    .option('--language <name>', 'lenguaje exacto')
    .option('--module <name>', 'nombre o ruta de módulo')
    .option('--kind <name>', 'subtipo: function, product, documentation, identificador de policy, etc.')
    .action(async (text: string[], options: { db: string; limit: string; collection?: string; snapshot?: string;
      type?: KnowledgeKind; language?: string; module?: string; kind?: string }) => {
      const store = await openStore(options.db);
      try {
        const snapshot = options.snapshot ? store.getSnapshot(options.snapshot) : store.getLatestSnapshot();
        if (!snapshot) { throw new Error('No existe el snapshot: corre `repolead scan` primero o verifica --snapshot.'); }
        const services = await retrievalServices();
        const hits = await hybridKnowledgeSearch({
          store, snapshotId: snapshot.id, collection: options.collection ?? indexedCollection(store, snapshot.id), query: text.join(' '),
          ...services,
          limit: Number(options.limit),
          filters: { entityKinds: options.type ? [options.type] : undefined, language: options.language, module: options.module, kind: options.kind },
          onWarning: (message) => console.warn(`− ${message}`),
        });
        if (!services.embeddings || !services.qdrant) { console.log('− búsqueda vectorial desactivada (TEI/backend no disponibles) — solo FTS5 + grafo\n'); }
        if (!hits.length) { console.log('Sin resultados.'); }
        for (const [index, hit] of hits.entries()) {
          const { item } = hit;
          console.log(`${String(index + 1).padStart(2)}. ${item.title} (${item.entityKind}/${item.kind})  ${item.path}${item.startLine ? `:${item.startLine}-${item.endLine}` : ''}`);
          console.log(`    score ${hit.score.toFixed(4)} · ${hit.sources.join(' + ')} · id ${item.subjectId}`);
        }
      } finally { store.close(); }
    });
}

export function registerReindex(program: Command): void {
  program.command('reindex')
    .description('Reconstruye conocimiento buscable y sincroniza Qdrant o PostgreSQL/pgvector')
    .option('--db <path>', 'ruta del archivo SQLite', DEFAULT_DB)
    .option('--collection <name>', 'colección Qdrant (por defecto, aislada por modelo de embeddings)')
    .addOption(new Option('--vector-store <backend>', 'backend vectorial').choices(['qdrant', 'pgvector']))
    .action(async (options: { db: string; collection?: string; vectorStore?: string }) => {
      const urls = serviceUrls();
      const [teiUp, vectors] = await Promise.all([reachable(`${urls.tei}/health`), vectorBackend({ backend: options.vectorStore, required: true, migrate: true })]);
      if (!teiUp) { throw new Error('Necesitas el servicio TEI de embeddings disponible.'); }
      const store = await openStore(options.db);
      try {
        const snapshot = store.getLatestSnapshot();
        if (!snapshot) { throw new Error('No hay snapshots: corre `repolead scan` primero.'); }
        const embeddings = new TeiEmbeddingsClient(urls.tei);
        const collection = options.collection ?? await defaultEmbeddingCollection(embeddings);
        const count = await indexSnapshot({
          store, snapshotId: snapshot.id, repositoryName: store.getRepository(snapshot.repositoryId)!.name,
          collection, embeddings, qdrant: vectors!,
          onProgress: printVectorProgress,
        });
        console.log(`✓ ${count} elementos de conocimiento en ${options.vectorStore ?? process.env['REPOLEAD_VECTOR_BACKEND'] ?? 'qdrant'} (colección ${collection})`);
      } finally { store.close(); }
    });
}
