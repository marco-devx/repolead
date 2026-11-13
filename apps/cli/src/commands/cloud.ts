import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { Command } from 'commander';
import { openStore } from '@repolead/knowledge-store';
import { cloudPool, importExistingVectors, migrateCloud, publicationInfo, publishRepository, runCloudWorker, startCloudHttp } from '@repolead/cloud';
import { PgVectorStore, QdrantRestClient, vectorBackend } from '@repolead/retrieval';

function required(name: string): string {
  const value = process.env[name]?.trim(); if (!value) { throw new Error(`Configura ${name} en el archivo de entorno cloud.`); } return value;
}
function database(role: 'PUBLISH' | 'READ' | 'WORKER') {
  const url = process.env[`REPOLEAD_PG_${role}_URL`] ?? required('DATABASE_URL');
  const policy = process.env['REPOLEAD_PG_TLS'];
  if (policy && !['disable', 'verify-full'].includes(policy)) { throw new Error('REPOLEAD_PG_TLS debe ser verify-full o disable.'); }
  return cloudPool(url, { tls: policy as 'disable' | 'verify-full' | undefined, caFile: process.env['REPOLEAD_PG_CA_FILE'] });
}
function repositories(options: { dir: string; only?: string; reposFile?: string; availableOnly?: boolean }) {
  const allowed: unknown = options.reposFile ? JSON.parse(readFileSync(options.reposFile, 'utf8')) : options.only?.split(',').map((name) => name.trim());
  if (!Array.isArray(allowed) || !allowed.length || allowed.some((name) => typeof name !== 'string' || !name || /[/\\]/.test(name))) {
    throw new Error('Publicar requiere --only repo1,repo2 o --repos-file con aliases explícitos.');
  }
  const root = resolve(options.dir);
  const candidates = [root, ...readdirSync(root).map((entry) => join(root, entry))];
  return [...new Set(allowed as string[])].flatMap((name) => {
    const path = candidates.find((candidate) => basename(candidate) === name && existsSync(join(candidate, '.repolead', 'repolead.db')));
    if (!path && options.availableOnly) { console.log(JSON.stringify({ repository: name, skipped: true, reason: 'No local database; run the normal refresh to generate it.' })); return []; }
    if (!path) { throw new Error(`No hay base local para ${name}.`); }
    return [{ name, db: join(path, '.repolead', 'repolead.db') }];
  });
}

export function registerCloud(program: Command): void {
  const cloud = program.command('cloud').description('Publicar contexto local en PostgreSQL/pgvector y servir MCP con SSO')
    .option('--env-file <path>', 'archivo de configuración y secretos, cargado solo en este proceso')
    .hook('preAction', () => {
      const path = cloud.opts<{ envFile?: string }>().envFile;
      if (path) { for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) { process.env[key] ??= value; } }
    });

  cloud.command('migrate').description('Crear tablas/índices cloud; requiere rol propietario y extensión pgvector disponible')
    .action(async () => { const pool = database('PUBLISH'); try { await migrateCloud(pool); console.log('Esquema PostgreSQL/pgvector listo.'); } finally { await pool.end(); } });

  cloud.command('publish').description('Publicar análisis, fuente capturada, grafo, índices y vectores existentes; sin llamadas generativas')
    .option('--dir <path>', 'directorio padre de repositorios', process.cwd()).option('--only <names>', 'aliases separados por comas')
    .option('--repos-file <path>', 'array JSON de repositorios autorizados').option('--dry-run', 'validar bases y mostrar publicación; no conecta a PostgreSQL ni Qdrant')
    .option('--available-only', 'omitir e informar bases ausentes o análisis/índices todavía incompletos')
    .action(async (options: { dir: string; only?: string; reposFile?: string; dryRun?: boolean; availableOnly?: boolean }) => {
      const repos = repositories(options); const pool = options.dryRun ? null : database('PUBLISH');
      const source = !options.dryRun && process.env['REPOLEAD_VECTOR_BACKEND'] === 'pgvector' ? await vectorBackend({ required: true }) : undefined;
      try {
        let completed = 0;
        for (const repo of repos) {
          const store = await openStore(repo.db, { readonly: true });
          try {
            let info;
            try { info = publicationInfo(repo.name, store); }
            catch (error) {
              if (!options.availableOnly) { throw error; }
              console.log(JSON.stringify({ repository: repo.name, skipped: true, reason: 'Finish current analysis/vector indexing; existing cloud publication is retained.' })); continue;
            }
            if (options.dryRun) {
              console.log(JSON.stringify({ repository: repo.name, publication: info.id, snapshot: info.snapshotId, indexedAt: info.indexedAt, products: info.metadata['products'] }));
            } else {
              console.log(JSON.stringify(await publishRepository(pool!, repo.name, store, { qdrant: source ?? undefined })));
            }
            completed++;
          } finally { store.close(); }
        }
        if (!completed) { throw new Error('No hay repositorios con análisis e índice completos para publicar.'); }
      } finally { await pool?.end(); }
    });

  cloud.command('import-vectors').description('Migración inicial Qdrant → PG local, sin regenerar embeddings ni análisis')
    .option('--dir <path>', 'directorio padre', process.cwd()).option('--only <names>', 'repositorios separados por comas')
    .option('--repos-file <path>', 'array JSON de repositorios seleccionados')
    .option('--available-only', 'omitir e informar bases ausentes o análisis/índices todavía incompletos')
    .action(async (options: { dir: string; only?: string; reposFile?: string; availableOnly?: boolean }) => {
      const pool = cloudPool(required('REPOLEAD_PG_LOCAL_URL'), { tls: process.env['REPOLEAD_LOCAL_PG_TLS'] as 'disable' | 'verify-full' | undefined });
      try {
        const target = new PgVectorStore(pool); await target.migrate();
        const source = new QdrantRestClient(process.env['REPOLEAD_QDRANT_URL'] ?? 'http://127.0.0.1:6333');
        let completed = 0;
        for (const repo of repositories(options)) {
          const store = await openStore(repo.db, { readonly: true });
          try {
            try { publicationInfo(repo.name, store); }
            catch (error) {
              if (!options.availableOnly) { throw error; }
              console.log(JSON.stringify({ repository: repo.name, skipped: true, reason: 'Finish current analysis/vector indexing before migrating.' })); continue;
            }
            console.log(JSON.stringify(await importExistingVectors(repo.name, store, source, target))); completed++;
          }
          finally { store.close(); }
        }
        if (!completed) { throw new Error('No hay repositorios con índice completo para migrar.'); }
      } finally { await pool.end(); }
    });

  cloud.command('grant <email>').description('Autorizar una cuenta SSO verificada; los cambios se aplican en la siguiente petición')
    .option('--repos <names>', 'repositorios separados por comas').option('--all', 'todos los repositorios publicados')
    .option('--subject <sub>', 'vincular también al sub estable de Keycloak').option('--revoke', 'deshabilitar acceso')
    .action(async (email: string, options: { repos?: string; all?: boolean; subject?: string; revoke?: boolean }) => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { throw new Error('Correo no válido.'); }
      const repos = options.all ? ['*'] : options.repos?.split(',').map((name) => name.trim()).filter(Boolean);
      if (!options.revoke && !repos?.length) { throw new Error('Especifica --repos o --all.'); }
      const pool = database('PUBLISH');
      try {
        const issuer = required('AUTH_OIDC_ISSUER_URL').replace(/\/+$/, '');
        if (options.revoke) { await pool.query('UPDATE repolead_readers SET enabled=false WHERE issuer=$1 AND email=$2', [issuer, email.toLowerCase()]); }
        else { await pool.query(`INSERT INTO repolead_readers(issuer,email,subject,repositories) VALUES($1,$2,$3,$4)
          ON CONFLICT(issuer,email) DO UPDATE SET subject=excluded.subject,repositories=excluded.repositories,enabled=true`, [issuer, email.toLowerCase(), options.subject ?? null, repos]); }
        console.log(options.revoke ? 'Acceso revocado.' : 'Acceso SSO autorizado.');
      } finally { await pool.end(); }
    });

  cloud.command('serve').description('MCP cloud: solo PostgreSQL, OAuth/OIDC corporativo obligatorio, sin token compartido')
    .option('--host <host>', 'interfaz local', '127.0.0.1').option('--port <port>', 'puerto', '3939')
    .action(async (options: { host: string; port: string }) => {
      const pool = database('READ');
      const server = await startCloudHttp(pool, { issuer: required('AUTH_OIDC_ISSUER_URL').replace(/\/+$/, ''),
        resource: `${required('BASE_URL').replace(/\/+$/, '')}/mcp`, host: options.host, port: Number(options.port),
        allowedOrigins: (process.env['REPOLEAD_ALLOWED_ORIGINS'] ?? 'https://claude.ai').split(',').map((origin) => origin.trim()) });
      server.once('close', () => { void pool.end(); });
      console.error('RepoLead cloud MCP con PostgreSQL y SSO listo.');
      const shutdown = () => { server.close(); };
      process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    });

  cloud.command('worker').description('Worker local de consultas semánticas y corroboración; no arranca ni detiene contenedores/modelos')
    .option('--cache-dir <path>', 'caché local privada de publicaciones', '.repolead/cloud/worker').option('--once', 'procesar un trabajo y terminar')
    .action(async (options: { cacheDir: string; once?: boolean }) => {
      const pool = database('WORKER'); const controller = new AbortController();
      const stop = () => { controller.abort(); };
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
      try { await runCloudWorker(pool, { cacheDir: resolve(options.cacheDir), once: options.once, signal: controller.signal,
        gpuLockPath: process.env['REPOLEAD_GPU_LOCK'] ?? join(tmpdir(), `repolead-gpu-${process.getuid?.() ?? 1000}.lock`), onProgress: console.error }); }
      finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); await pool.end(); }
    });

  cloud.command('refresh-workspace').description('Ejecutar el runner por fases del workspace con las variables cloud cargadas')
    .requiredOption('--dir <path>', 'workspace que contiene scripts/repolead-refresh.py')
    .action((options: { dir: string }) => {
      const root = resolve(options.dir); const runner = join(root, 'scripts', 'repolead-refresh.py');
      if (!existsSync(runner)) { throw new Error('Este workspace no tiene el runner de refresh por fases.'); }
      const result = spawnSync('python3', [runner, root], { env: process.env, stdio: 'inherit' });
      if (result.error) { throw new Error('No se pudo iniciar el runner de refresh.'); }
      process.exitCode = result.status ?? 1;
    });
}
