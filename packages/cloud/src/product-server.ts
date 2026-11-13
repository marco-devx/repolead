import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type pg from 'pg';
import { contentHash, MAX_CONTEXT_TOKENS } from '@repolead/domain';
import { countTokens } from '@repolead/retrieval';
import { enqueue } from './jobs';
import type { CloudIdentity } from './sso';

const annotation = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const text = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
const repoSchema = z.string().min(1).max(200);
const budget = z.number().int().min(512).max(MAX_CONTEXT_TOKENS).default(MAX_CONTEXT_TOKENS);
const caveats = ['Contexto del código indexado; no prueba despliegues o configuración por cliente.',
  'La cobertura generativa depende de las entradas detectadas. Las ausencias no prueban que una función no exista.',
  'La investigación y los embeddings nuevos requieren un worker o un servicio de inferencia disponible.'];

export async function activePublication(pool: pg.Pool, identity: CloudIdentity, repo: string) {
  if (!identity.repositories.includes('*') && !identity.repositories.includes(repo)) { throw new Error('Repositorio no autorizado.'); }
  const row = await pool.query(`SELECT p.* FROM repolead_repositories r JOIN repolead_publications p
    ON p.id=r.active_publication WHERE r.name=$1 AND p.state='ready'`, [repo]);
  if (!row.rows[0]) { throw new Error('Repositorio sin publicación completa.'); }
  return row.rows[0] as { id: string; repository: string; snapshot_id: string; indexed_at: Date;
    model_key: string; dimensions: number; metadata: Record<string, unknown> };
}

export function createCloudProductServer(pool: pg.Pool, identity: CloudIdentity): McpServer {
  const server = new McpServer({ name: 'repolead-producto', version: '0.2.0' }, {
    instructions: 'SSO-authenticated published product knowledge. Use product_catalog and product_context; latest complete publications are automatic. Corroborate important current rules with product_investigate start/status and source refs. Jobs are durable in PostgreSQL and executed by authorized local workers. If a semanticJobId is returned, poll it through product_investigate action=status then repeat product_context; lexical results remain usable with their warning. Never claim code corroboration before the research job completes. Respect omissions and uncertainty; no raw code tools are exposed.',
  });
  server.registerTool('product_catalog', { description: 'Repositorios autorizados, fecha de captura y temas publicados más recientes.', annotations: annotation,
    inputSchema: { repo: repoSchema.optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(40) } },
  async ({ repo, offset, limit }) => {
    const inventory = await pool.query(`SELECT r.name AS repo,p.indexed_at,p.metadata,
      (SELECT count(*)::int FROM repolead_products x WHERE x.publication_id=p.id) AS analyses
      FROM repolead_repositories r JOIN repolead_publications p ON p.id=r.active_publication
      WHERE p.state='ready' AND ($1::boolean OR r.name=ANY($2::text[])) ORDER BY r.name`, [identity.repositories.includes('*'), identity.repositories]);
    let topics: unknown[] | undefined; let totalTopics: number | undefined;
    if (repo) {
      const publication = await activePublication(pool, identity, repo);
      topics = (await pool.query(`SELECT ref,record->>'title' AS title,record->>'kind' AS kind FROM repolead_products
        WHERE publication_id=$1 ORDER BY ref OFFSET $2 LIMIT $3`, [publication.id, offset, limit])).rows;
      totalTopics = inventory.rows.find((row) => row.repo === repo)?.analyses as number;
    }
    return text({ repositories: inventory.rows.map((row) => ({ repo: row.repo, status: 'ready', indexedAt: row.indexed_at, analyses: row.analyses })),
      ...(repo ? { repo, topics, totalTopics, offset } : {}), caveats });
  });

  server.registerTool('product_context', { description: 'Recuperación funcional en PostgreSQL FTS y pgvector. Puede encolar embeddings de consultas nuevas; repetir cuando termine semanticJobId.', annotations: annotation,
    inputSchema: { repo: repoSchema, queries: z.array(z.string().trim().min(1).max(500)).min(1).max(6),
      limit: z.number().int().min(1).max(30).default(8), maxTokens: budget } },
  async ({ repo, queries, limit, maxTokens }) => {
    const publication = await activePublication(pool, identity, repo);
    const scores = new Map<string, number>(); const records = new Map<string, Record<string, unknown>>();
    for (const query of queries) {
      // OR terms allow natural-language Spanish/English questions without requiring all stopwords.
      const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].filter((term) => term.length > 2).slice(0, 80);
      if (terms.length) {
        const lexical = await pool.query(`SELECT ref,record FROM repolead_products WHERE publication_id=$1
          AND search_document @@ to_tsquery('simple',$2) ORDER BY ts_rank(search_document,to_tsquery('simple',$2)) DESC LIMIT 40`,
        [publication.id, terms.map((term) => `${term}:*`).join(' | ')]);
        lexical.rows.forEach((row, rank) => { records.set(row.ref, row.record); scores.set(row.ref, (scores.get(row.ref) ?? 0) + 1 / (60 + rank)); });
      }
    }
    let semantic = false; let semanticJobId: string | undefined;
    const missing: string[] = [];
    for (const query of queries) {
      const cached = await pool.query('SELECT embedding::text AS embedding FROM repolead_query_vectors WHERE model_key=$1 AND query_hash=$2', [publication.model_key, contentHash(query)]);
      if (!cached.rowCount) { missing.push(query); continue; }
      // Exact cosine ranking of the small authorized product projection retains float32 precision.
      const vectors = await pool.query(`SELECT p.ref,p.record FROM repolead_products p JOIN repolead_vectors v
        ON v.content_hash=p.content_hash AND v.model_key=$2 WHERE p.publication_id=$1
        ORDER BY v.embedding <=> $3::vector LIMIT 40`, [publication.id, publication.model_key, cached.rows[0].embedding]);
      semantic ||= vectors.rowCount !== 0;
      vectors.rows.forEach((row, rank) => { records.set(row.ref, row.record); scores.set(row.ref, (scores.get(row.ref) ?? 0) + 1 / (60 + rank)); });
    }
    if (missing.length) {
      try { semanticJobId = (await enqueue(pool, publication.id, identity.subject, 'embedding', { queries: missing, modelKey: publication.model_key })).id; } catch { /* lexical retrieval is still available */ }
    }
    const selected: Record<string, unknown>[] = [];
    const ranked = [...scores].sort((a, b) => b[1] - a[1]);
    const payload = { repo, indexedAt: publication.indexed_at, status: 'ready', records: selected,
      retrieval: { semantic, reranked: false }, ...(semanticJobId ? { semanticJobId, retryAfterSeconds: 3 } : {}),
      omittedByBudgetOrLimit: ranked.length, warnings: semantic ? [] : ['Recuperación léxica; no se aplicaron vectores de consulta verificados.'], caveats };
    for (const [ref] of ranked) {
      if (selected.length >= limit) { break; }
      selected.push(records.get(ref)!);
      if (countTokens(JSON.stringify(payload)) > maxTokens) { selected.pop(); }
    }
    payload.omittedByBudgetOrLimit = ranked.length - selected.length;
    return text(payload);
  });

  server.registerTool('product_evidence', { description: 'Ampliar un análisis funcional publicado; no devuelve código.', annotations: annotation,
    inputSchema: { repo: repoSchema, ref: z.string().regex(/^product:[a-f0-9]{64}$/), maxTokens: budget } },
  async ({ repo, ref, maxTokens }) => {
    const publication = await activePublication(pool, identity, repo);
    const row = await pool.query('SELECT record FROM repolead_products WHERE publication_id=$1 AND ref=$2', [publication.id, ref]);
    const payload = row.rowCount ? { repo, indexedAt: publication.indexed_at, record: row.rows[0].record, caveats } : { error: 'Referencia vencida o desconocida; consulta product_context.' };
    return text(countTokens(JSON.stringify(payload)) <= maxTokens ? payload : { error: 'Aumenta maxTokens para recuperar el análisis completo.' });
  });

  server.registerTool('product_investigate', { description: 'Investigar código capturado mediante un worker local autorizado. Iniciar o consultar un job; también consultar semanticJobId sin exponer sus vectores.', annotations: annotation,
    inputSchema: { action: z.enum(['start', 'status']).default('start'), repo: repoSchema, question: z.string().trim().min(1).max(2000).optional(),
      queries: z.array(z.string().trim().min(1).max(500)).min(1).max(6).optional(), refs: z.array(z.string().regex(/^product:[a-f0-9]{64}$/)).min(1).max(4).optional(),
      sourceRefs: z.array(z.string().regex(/^source:[a-f0-9]{64}$/)).min(1).max(6).optional(), jobId: z.string().regex(/^(?:research|embedding):[a-f0-9]{64}$/).optional(),
      depth: z.number().int().min(1).max(3).default(2), maxFiles: z.number().int().min(4).max(40).default(24), maxTokens: budget } },
  async ({ action, repo, question, queries, refs, sourceRefs, jobId, depth, maxFiles, maxTokens }) => {
    const publication = await activePublication(pool, identity, repo);
    let job;
    if (action === 'start') {
      if (!question || jobId) { return text({ error: 'start requiere question y no acepta jobId.' }); }
      if (refs?.length) {
        const found = await pool.query('SELECT ref FROM repolead_products WHERE publication_id=$1 AND ref=ANY($2::text[])', [publication.id, refs]);
        if (found.rowCount !== new Set(refs).size) { return text({ error: 'Referencia ajena o vencida.' }); }
      }
      job = await enqueue(pool, publication.id, identity.subject, 'research', { question, queries, refs, sourceRefs, depth, maxFiles });
    } else {
      if (!jobId) { return text({ error: 'status requiere jobId.' }); }
      const row = await pool.query('SELECT * FROM repolead_jobs WHERE id=$1 AND requested_by=$2', [jobId, identity.subject]);
      if (!row.rowCount) { return text({ error: 'Investigación desconocida para este usuario.' }); }
      job = row.rows[0];
      if (job.publication_id !== publication.id) { return text({ status: 'stale', message: 'La investigación pertenece a otra publicación; consulta la actual.' }); }
    }
    const payload = { repo, jobId: job.id, status: job.state, indexedAt: publication.indexed_at,
      ...(job.state === 'complete' && job.kind === 'research' ? { result: job.result } : {}),
      ...(job.state === 'complete' && job.kind === 'embedding' ? { message: 'Embeddings listos. Repite product_context.' } : {}),
      ...(job.error ? { error: job.error } : {}), ...(job.state === 'queued' || job.state === 'running' ? { pollAfterSeconds: 15,
        message: 'En espera del worker local o en ejecución; el contexto publicado sigue disponible.' } : {}) };
    return text(countTokens(JSON.stringify(payload)) <= maxTokens ? payload : { repo, jobId: job.id, status: job.state, message: 'Aumenta maxTokens para recuperar el resultado completo.' });
  });
  return server;
}
