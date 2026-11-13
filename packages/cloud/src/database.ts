import type pg from 'pg';
import { createPgPool } from '@repolead/retrieval';
import { CLOUD_SCHEMA } from './schema';

export const cloudPool = createPgPool;

export async function migrateCloud(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('repolead-cloud-schema-v1'))");
    await client.query(CLOUD_SCHEMA);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export function pgVector(vector: number[]): string {
  if (!vector.length || vector.length > 16000 || vector.some((value) => !Number.isFinite(value))) { throw new Error('Invalid embedding vector.'); }
  return `[${vector.join(',')}]`;
}
