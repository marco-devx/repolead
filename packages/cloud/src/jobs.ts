import { contentHash } from '@repolead/domain';
import type pg from 'pg';

export interface CloudJob { id: string; publication_id: string; kind: 'research' | 'embedding'; requested_by: string;
  input: Record<string, unknown>; result: Record<string, unknown> | null; state: string; error: string | null }

export async function enqueue(pool: pg.Pool, publicationId: string, subject: string, kind: CloudJob['kind'], input: Record<string, unknown>) {
  const id = `${kind}:${contentHash(JSON.stringify(['cloud-job-v1', publicationId, subject, input]))}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`repolead-queue:${kind}`]);
    const existing = await client.query('SELECT * FROM repolead_jobs WHERE id=$1', [id]);
    if (existing.rowCount && existing.rows[0].state !== 'failed') { await client.query('COMMIT'); return existing.rows[0] as CloudJob; }
    const count = await client.query("SELECT count(*)::int AS n FROM repolead_jobs WHERE kind=$1 AND state IN ('queued','running')", [kind]);
    if (count.rows[0].n >= (kind === 'research' ? 4 : 100)) { throw new Error('Cloud work queue is full; retry existing jobs later.'); }
    const added = await client.query(`INSERT INTO repolead_jobs(id,publication_id,requested_by,kind,input) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET state='queued',error=NULL,result=NULL,lease_owner=NULL,lease_until=NULL,attempts=0,updated_at=now() RETURNING *`,
    [id, publicationId, subject, kind, input]);
    await client.query('COMMIT'); return added.rows[0] as CloudJob;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function claimJob(pool: pg.Pool, owner: string): Promise<CloudJob | null> {
  await pool.query("UPDATE repolead_jobs SET state='failed',error='Worker lease expired after three attempts',updated_at=now() WHERE state='running' AND lease_until<now() AND attempts>=3");
  const row = await pool.query(`WITH next AS (
    SELECT id FROM repolead_jobs WHERE (state='queued' OR (state='running' AND lease_until<now())) AND attempts<3
    ORDER BY CASE kind WHEN 'embedding' THEN 0 ELSE 1 END,created_at FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE repolead_jobs j SET state='running',lease_owner=$1,lease_until=now()+interval '90 seconds',attempts=attempts+1,updated_at=now()
    FROM next WHERE j.id=next.id RETURNING j.*`, [owner]);
  return row.rows[0] as CloudJob ?? null;
}

export async function finishJob(pool: pg.Pool, owner: string, id: string, result: Record<string, unknown> | null, error: string | null = null) {
  const updated = await pool.query(`UPDATE repolead_jobs SET state=$3,result=$4,error=$5,lease_until=NULL,updated_at=now()
    WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>now()`, [id, owner, error ? 'failed' : 'complete', result, error]);
  if (!updated.rowCount) { throw new Error('Worker lease lost; result was not published.'); }
}
