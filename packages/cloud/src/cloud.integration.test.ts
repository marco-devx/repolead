import { afterAll, beforeAll, expect, test } from '@rstest/core';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import { PgVectorStore, indexSnapshot } from '@repolead/retrieval';
import type { QdrantPoint, QdrantSearcher } from '@repolead/retrieval';
import { scanRepository } from '../../code-graph/src/index';
import { analyzeEntryPoints, analyzeProductContext } from '../../lead-analyzer/src/index';
import { ContractModel } from '../../lead-analyzer/test-support/contract-model';
import { cloudPool, migrateCloud } from './database';
import { publishRepository } from './publish';
import { importExistingVectors } from './import-vectors';
import { materializePublication, runCloudWorker } from './worker';
import { startCloudHttp } from './http';
import { enqueue, claimJob, finishJob } from './jobs';

const integration = process.env['REPOLEAD_TEST_PG_URL'] ? test : test.skip;
const MODEL = contentHash('cloud-integration-embedding-model');
const vector = [1, ...Array<number>(2559).fill(0)];
class MemoryVectors implements QdrantSearcher {
  points = new Map<string, QdrantPoint>(); reads = 0;
  async ensureCollection() {}
  async upsert(_name: string, points: QdrantPoint[]) { points.forEach((point) => this.points.set(point.id, point)); }
  async retrieve(_name: string, ids: string[]) { this.reads++; return ids.flatMap((id) => this.points.get(id) ?? []); }
  async search() { return []; }
  async updatePayloads(_name: string, updates: { ids: string[]; payload: Record<string, unknown> }[]) {
    for (const update of updates) { for (const id of update.ids) { const point = this.points.get(id); if (point) { point.payload = { ...point.payload, ...update.payload }; } } }
  }
  async prune(_name: string, repository: string, generation: string) {
    for (const [id, point] of this.points) { if (point.payload['repository'] === repository && point.payload['index_generation'] !== generation) { this.points.delete(id); } }
  }
}
let directory: string; let pool: pg.Pool; let admin: pg.Pool; let store: KnowledgeStore;
let databaseName: string; let source: MemoryVectors; let native: PgVectorStore;
let first: Awaited<ReturnType<typeof publishRepository>>;
const fixtureModel = new ContractModel();
const embeddings = { cacheKey: async () => MODEL, embed: async (texts: string[]) => texts.map(() => vector), embedQuery: async () => vector };

async function indexFixture() {
  const scan = await scanRepository({ rootPath: directory, repositoryName: 'cloud-demo', scip: false });
  if (store) { store.close(); }
  store = await openStore(scan.dbPath);
  const options = { store, snapshotId: scan.snapshotId, model: fixtureModel, analysisMode: 'entrypoints' as const };
  await analyzeEntryPoints(options); await analyzeProductContext(options);
  await indexSnapshot({ ...options, repositoryName: 'cloud-demo', collection: 'fixture', embeddings, qdrant: source });
}

if (process.env['REPOLEAD_TEST_PG_URL']) {
  beforeAll(async () => {
    const url = new URL(process.env['REPOLEAD_TEST_PG_URL']!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { throw new Error('Integration tests require an explicitly local PostgreSQL server'); }
    admin = cloudPool(url.toString()); databaseName = `repolead_cloud_test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${databaseName}`); url.pathname = `/${databaseName}`;
    pool = cloudPool(url.toString());
    for (const role of ['repolead_app', 'repolead_worker']) {
      if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) { await admin.query(`CREATE ROLE ${role} NOLOGIN`); }
    }
    await migrateCloud(pool); native = new PgVectorStore(pool); await native.migrate();
    directory = mkdtempSync(join(tmpdir(), 'repolead-cloud-'));
    mkdirSync(join(directory, 'src/application/use_cases/site'), { recursive: true });
    mkdirSync(join(directory, 'src/application/services'), { recursive: true });
    writeFileSync(join(directory, '.gitignore'), '.repolead/\n');
    writeFileSync(join(directory, 'src/application/use_cases/site/create_site.py'), 'from src.application.services.unit_guard import check\nclass CreateSiteUseCase:\n    def execute(self, unit):\n        check(unit)\n        return unit.id\n');
    writeFileSync(join(directory, 'src/application/services/unit_guard.py'), 'def check(unit):\n    if not unit.is_active:\n        raise ValueError("inactive")\n');
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'RepoLead fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'Fixture']]) {
      execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore' });
    }
    source = new MemoryVectors(); await indexFixture();
  });
  afterAll(async () => {
    store?.close(); await pool?.end();
    if (databaseName) { await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`); }
    await admin?.end(); if (directory) { rmSync(directory, { recursive: true, force: true }); }
  });
}

integration('migrates existing 2560-dimensional vectors without model calls and publishes an immutable native-PG context', async () => {
  const packsBefore = fixtureModel.packs.length;
  const transferred = await importExistingVectors('cloud-demo', store, source, native);
  expect(transferred.modelCalls).toBe(0); expect(transferred.dimensions).toBe(2560);
  expect(fixtureModel.packs.length).toBe(packsBefore);
  first = await publishRepository(pool, 'cloud-demo', store, { qdrant: native });
  expect(first.unchanged).toBe(false); expect(first.uploadedVectors).toBe(0);
  const repeated = await publishRepository(pool, 'cloud-demo', store, { qdrant: native });
  expect(repeated.unchanged).toBe(true);
  const restored = await materializePublication(pool, first.publication, join(directory, 'worker-cache'));
  try {
    expect(restored.getSnapshotSource(restored.getLatestSnapshot()!.id, 'src/application/services/unit_guard.py')).toContain('not unit.is_active');
    expect(restored.listSymbols(restored.getLatestSnapshot()!.id).length).toBeGreaterThan(0);
  } finally { restored.close(); }
  expect((await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname LIKE 'repolead_ann_%'")).rows[0].indexdef).toContain('halfvec(2560)');
  expect((await pool.query("SELECT has_table_privilege('repolead_app','repolead_blobs','SELECT') AS allowed")).rows[0].allowed).toBe(false);
});

integration('publishes incremental vectors and retains the previous active context after a provenance failure', async () => {
  writeFileSync(join(directory, 'src/application/use_cases/site/create_site.py'), 'from src.application.services.unit_guard import check\nclass CreateSiteUseCase:\n    def execute(self, unit):\n        check(unit)\n        return {"id":unit.id,"active":True}\n');
  await indexFixture();
  const expected = source.points.size;
  const second = await publishRepository(pool, 'cloud-demo', store, { qdrant: source });
  expect(second.uploadedVectors).toBeLessThan(expected);
  writeFileSync(join(directory, 'src/application/use_cases/site/create_site.py'), 'from src.application.services.unit_guard import check\nclass CreateSiteUseCase:\n    def execute(self, unit):\n        check(unit)\n        return {"id":unit.id,"another":True}\n');
  await indexFixture();
  const bad: QdrantSearcher = { ...source, ensureCollection: async () => {}, upsert: async () => {}, search: async () => [],
    retrieve: async (collection, ids) => (await source.retrieve(collection, ids)).map((point) => ({ ...point, payload: { ...point.payload, embedding_hash: 'wrong' } })) };
  await expect(publishRepository(pool, 'cloud-demo', store, { qdrant: bad })).rejects.toThrow();
  expect((await pool.query('SELECT active_publication FROM repolead_repositories WHERE name=$1', ['cloud-demo'])).rows[0].active_publication).toBe(second.publication);
  await publishRepository(pool, 'cloud-demo', store, { qdrant: source });
});

integration('native PG reindex reuses embeddings and repository pruning preserves other projects', async () => {
  let generated = 0;
  const counted = { ...embeddings, embed: async (texts: string[]) => { generated += texts.length; return texts.map(() => vector); } };
  const snapshotId = store.getLatestSnapshot()!.id;
  await indexSnapshot({ store, snapshotId, repositoryName: 'cloud-demo', collection: 'fixture', embeddings: counted, qdrant: native });
  const firstCount = generated;
  await indexSnapshot({ store, snapshotId, repositoryName: 'cloud-demo', collection: 'fixture', embeddings: counted, qdrant: native });
  expect(generated).toBe(firstCount);
  const original = [...source.points.values()][0]!;
  await native.upsert('fixture', [{ ...original, id: 'other-project', payload: { ...original.payload, repository: 'other-project' } }]);
  await native.prune('fixture', 'cloud-demo', 'another-generation');
  expect((await native.retrieve('fixture', ['other-project']))).toHaveLength(1);
  await expect(native.ensureCollection('fixture', 3)).rejects.toThrow();
});

integration('SSO validates identity/audience/expiry, current grants and source isolation; worker supplies semantic search and corroboration', async () => {
  const keys = await generateKeyPair('RS256'); const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256' };
  let issuer = '';
  const provider = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/.well-known/openid-configuration')) { response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/certs` })); }
    else { response.end(JSON.stringify({ keys: [jwk] })); }
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/realms/wlt`;
  const resource = 'https://context.example.invalid/mcp';
  const server = await startCloudHttp(pool, { issuer, resource, allowHttpLoopback: true, port: 0 });
  const location = server.address(); const url = new URL(`http://127.0.0.1:${typeof location === 'object' && location ? location.port : 0}/mcp`);
  const token = (audience = resource, expiry = '5m') => new SignJWT({ typ: 'Bearer', scope: 'openid profile email', email: 'product@example.invalid', email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer).setAudience(audience).setSubject('product-user').setIssuedAt().setExpirationTime(expiry).sign(keys.privateKey);
  const post = async (jwt?: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) }, body: '{}' });
  const client = new Client({ name: 'cloud-test', version: '1' });
  try {
    const noToken = await post(); expect(noToken.status).toBe(401); expect(noToken.headers.get('www-authenticate')).toContain('oauth-protected-resource/mcp');
    expect((await (await fetch(new URL('/.well-known/oauth-protected-resource/mcp', url))).json() as { resource: string }).resource).toBe(resource);
    expect((await post(await token('tickets-portal'))).status).toBe(401);
    expect((await post(await token(resource, '-1h'))).status).toBe(401);
    const valid = await token(); expect((await post(valid)).status).toBe(403);
    await pool.query('INSERT INTO repolead_readers(issuer,email,subject,repositories) VALUES($1,$2,$3,$4)', [issuer, 'product@example.invalid', 'product-user', ['cloud-demo']]);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${valid}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args }); expect(response.isError).not.toBe(true);
      return JSON.parse((response.content as { text: string }[])[0]!.text) as Record<string, unknown>;
    };
    expect((await client.listTools()).tools).toHaveLength(4);
    expect((await client.callTool({ name: 'get_evidence', arguments: { path: 'src/application/services/unit_guard.py' } })).isError).toBe(true);
    const catalog = await call('product_catalog', {}); expect((catalog['repositories'] as unknown[]).length).toBe(1);
    const initial = await call('product_context', { repo: 'cloud-demo', queries: ['site'] });
    expect(initial['semanticJobId']).toBeDefined();
    await runCloudWorker(pool, { once: true, cacheDir: join(directory, 'worker-cache'), embeddings, gpuLockPath: join(directory, 'test-gpu.lock') });
    const semantic = await call('product_context', { repo: 'cloud-demo', queries: ['site'] });
    expect((semantic['retrieval'] as { semantic: boolean }).semantic).toBe(true);
    const topic = (semantic['records'] as { ref: string }[])[0]!;
    const research = await call('product_investigate', { repo: 'cloud-demo', question: 'Check inactive units', refs: [topic.ref] });
    await runCloudWorker(pool, { once: true, cacheDir: join(directory, 'worker-cache'), embeddings, modelFactory: async () => ({ name: 'local-contract', locality: 'local',
      complete: async (request) => {
        const prompt = JSON.parse(request.prompt) as { sources: { ref: string; path: string }[] };
        const guard = prompt.sources.find((item) => item.path.endsWith('unit_guard.py'))!;
        return { inputTokens: 0, outputTokens: 0, json: { findings: [{ statement: 'Se rechazan unidades inactivas.', basis: 'supported-in-reviewed-code', evidenceKind: 'explicit-behavior', explanation: 'El validador contiene esa condición.', citations: [{ ref: guard.ref, firstLine: 1, lastLine: 3 }] }], unknowns: [], nextChecks: [] } };
      } }) });
    const done = await call('product_investigate', { action: 'status', repo: 'cloud-demo', jobId: research['jobId'] });
    expect(done['status']).toBe('complete'); expect(JSON.stringify(done)).toContain('unidades inactivas'); expect(JSON.stringify(done)).not.toContain('numberedSource');
    await pool.query('UPDATE repolead_readers SET enabled=false WHERE email=$1', ['product@example.invalid']);
    expect((await post(valid)).status).toBe(403);
  } finally {
    await client.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

integration('expired workers cannot publish results and exhausted jobs can be explicitly retried', async () => {
  const publication = (await pool.query('SELECT active_publication FROM repolead_repositories WHERE name=$1', ['cloud-demo'])).rows[0].active_publication as string;
  const input = { question: 'Lease recovery fixture' };
  const job = await enqueue(pool, publication, 'lease-user', 'research', input);
  expect((await claimJob(pool, 'first-worker'))?.id).toBe(job.id);
  expect(await claimJob(pool, 'other-worker')).toBe(null);
  await pool.query("UPDATE repolead_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
  await expect(finishJob(pool, 'first-worker', job.id, { stale: true })).rejects.toThrow();
  expect((await claimJob(pool, 'other-worker'))?.id).toBe(job.id);
  await expect(finishJob(pool, 'first-worker', job.id, { stale: true })).rejects.toThrow();
  await pool.query("UPDATE repolead_jobs SET attempts=3,lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
  expect(await claimJob(pool, 'last-worker')).toBe(null);
  expect((await pool.query('SELECT state FROM repolead_jobs WHERE id=$1', [job.id])).rows[0].state).toBe('failed');
  await enqueue(pool, publication, 'lease-user', 'research', input);
  expect((await claimJob(pool, 'retry-worker'))?.id).toBe(job.id);
  await finishJob(pool, 'retry-worker', job.id, { recovered: true });
});
