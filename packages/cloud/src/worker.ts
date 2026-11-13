import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import type { KnowledgeStore, SqlValue } from '@repolead/knowledge-store';
import { ProductResearchHub, productView } from '@repolead/mcp-server';
import { TeiEmbeddingsClient } from '@repolead/retrieval';
import type { EmbeddingsClient } from '@repolead/retrieval';
import type { TechLeadModel } from '@repolead/lead-analyzer';
import { pgVector } from './database';
import { claimJob, finishJob } from './jobs';
import { MIRROR_TABLES } from './schema';
import { tryGpuLock } from './gpu-lock';

/** Native PG rows restore a private, disposable LOCAL index for the existing source investigator. */
export async function materializePublication(pool: pg.Pool, publicationId: string, cacheDir: string): Promise<KnowledgeStore> {
  if (!/^pub_[a-f0-9]{64}$/.test(publicationId)) { throw new Error('Invalid publication ID'); }
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const path = join(cacheDir, `${publicationId}.db`);
  if (existsSync(path)) { return openStore(path, { readonly: true }); }
  const publication = (await pool.query("SELECT snapshot_id FROM repolead_publications WHERE id=$1 AND state='ready'", [publicationId])).rows[0];
  if (!publication) { throw new Error('Publication is not ready'); }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const store = await openStore(temporary);
  let closed = false;
  try {
    store.db.exec('PRAGMA foreign_keys=OFF');
    for (const table of MIRROR_TABLES) {
      const columns = store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      let after = -1;
      for (;;) {
        const page = await pool.query(`SELECT r.ordinal,b.payload FROM repolead_rows r JOIN repolead_blobs b ON b.hash=r.blob_hash
          WHERE r.publication_id=$1 AND r.table_name=$2 AND r.ordinal>$3 ORDER BY r.ordinal LIMIT 128`, [publicationId, table, after]);
        if (!page.rowCount) { break; }
        store.db.transaction(() => {
          for (const record of page.rows) {
            const row = record.payload as Record<string, SqlValue>;
            if (Object.keys(row).some((name) => !columns.some((column) => column.name === name))) { throw new Error('Mirror schema differs; use the same RepoLead version on publisher and worker.'); }
            if (columns.some((column) => column.name === 'snapshot_id')) { row['snapshot_id'] = publication.snapshot_id as string; }
            const names = columns.map((column) => column.name).filter((name) => name in row);
            if (names.some((name) => !/^[a-z_]+$/.test(name))) { throw new Error('Invalid mirror columns'); }
            store.db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((name) => row[name]!));
          }
        })();
        after = page.rows[page.rows.length - 1].ordinal as number;
      }
    }
    if (store.getLatestSnapshot()?.id !== publication.snapshot_id) { throw new Error('Mirrored snapshot mismatch'); }
    store.db.exec('PRAGMA foreign_keys=ON');
    store.close(); closed = true; renameSync(temporary, path);
    return openStore(path, { readonly: true });
  } catch (error) { if (!closed) { store.close(); } rmSync(temporary, { force: true }); throw error; }
}

export async function runCloudWorker(pool: pg.Pool, options: {
  cacheDir: string; embeddings?: EmbeddingsClient; signal?: AbortSignal; once?: boolean;
  modelFactory?: () => Promise<TechLeadModel>;
  gpuLockPath?: string;
  onProgress?: (message: string) => void;
}) {
  const owner = randomUUID();
  const embeddings = options.embeddings ?? new TeiEmbeddingsClient(process.env['REPOLEAD_TEI_URL'] ?? 'http://127.0.0.1:8082');
  const pause = (ms: number) => new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms); options.signal?.addEventListener('abort', finish, { once: true });
  });
  while (!options.signal?.aborted) {
    let releaseGpu: (() => void) | null = null;
    if (options.gpuLockPath) {
      const pending = await pool.query("SELECT 1 FROM repolead_jobs WHERE state='queued' OR (state='running' AND lease_until<now()) LIMIT 1");
      if (!pending.rowCount) { if (options.once) { return; } await pause(2000); continue; }
      releaseGpu = await tryGpuLock(options.gpuLockPath);
      if (!releaseGpu) { if (options.once) { return; } await pause(2000); continue; }
    }
    let job;
    try { job = await claimJob(pool, owner); } catch (error) { releaseGpu?.(); throw error; }
    if (!job) { releaseGpu?.(); if (options.once) { return; } await pause(2000); continue; }
    const heartbeat = setInterval(() => { void pool.query(`UPDATE repolead_jobs SET lease_until=now()+interval '90 seconds'
      WHERE id=$1 AND lease_owner=$2 AND state='running'`, [job.id, owner]).catch(() => {}); }, 20000);
    try {
      const publication = (await pool.query(`SELECT p.*,r.active_publication FROM repolead_publications p
        JOIN repolead_repositories r ON r.name=p.repository WHERE p.id=$1`, [job.publication_id])).rows[0];
      if (!publication || publication.active_publication !== job.publication_id) { throw new Error('Publication superseded'); }
      if (job.kind === 'embedding') {
        if (await embeddings.cacheKey?.() !== publication.model_key) { throw new Error('Embedding model identity differs from published vectors'); }
        for (const query of job.input['queries'] as string[]) {
          const cached = await pool.query('SELECT 1 FROM repolead_query_vectors WHERE model_key=$1 AND query_hash=$2', [publication.model_key, contentHash(query)]);
          if (cached.rowCount) { continue; }
          const vector = embeddings.embedQuery ? await embeddings.embedQuery(query) : (await embeddings.embed([query]))[0]!;
          if (vector.length !== publication.dimensions) { throw new Error('Embedding dimensions differ from published vectors'); }
          await pool.query('INSERT INTO repolead_query_vectors(model_key,query_hash,embedding) VALUES($1,$2,$3::vector) ON CONFLICT DO NOTHING', [publication.model_key, contentHash(query), pgVector(vector)]);
        }
        await finishJob(pool, owner, job.id, { message: 'Query embeddings ready' });
      } else {
        const store = await materializePublication(pool, job.publication_id, options.cacheDir);
        try {
          const hub = new ProductResearchHub([{ name: publication.repository as string, store }], productView, options.modelFactory);
          const input = job.input as { question: string; queries?: string[]; refs?: string[]; sourceRefs?: string[]; depth?: number; maxFiles?: number };
          let result = hub.start(publication.repository as string, input, 120000);
          const id = result['jobId'];
          if (!id) { throw new Error('No source investigation could be started'); }
          while (['queued', 'running'].includes(String(result['status']))) {
            await pause(1000); result = hub.status(publication.repository as string, String(id), 120000);
          }
          if (result['status'] !== 'complete') { throw new Error('Local source investigation did not complete'); }
          await finishJob(pool, owner, job.id, result['result'] as Record<string, unknown>);
        } finally { store.close(); }
      }
      options.onProgress?.(`Completed ${job.kind} job ${job.id}`);
    } catch {
      await finishJob(pool, owner, job.id, null, 'El worker no pudo completar el trabajo. Comprueba modelo, conectividad y vigencia de la publicación; puedes reintentar.').catch(() => {});
      options.onProgress?.(`Failed ${job.kind} job ${job.id}; published knowledge was retained.`);
    } finally { clearInterval(heartbeat); releaseGpu?.(); }
    if (options.once) { return; }
  }
}
