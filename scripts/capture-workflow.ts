import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { scanRepository } from '@repolead/code-graph';
import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { indexSnapshot, QdrantRestClient, TeiEmbeddingsClient } from '@repolead/retrieval';

/** Persistent, isolated application-source capture; never expose benchmark answers to either arm. */
export async function captureWorkflowRepository(project: string, scip = true, vectors = false) {
  const parent = join(project, '.repolead', 'acceptance'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'workflow-'));
  const manifest: { path: string; hash: string }[] = []; const excluded: string[] = [];
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: project, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of [...new Set(files)].sort()) {
    if (path.startsWith('benchmarks/') || /^scripts\/(?:verify-|capture-|acceptance)/.test(path) || path === 'docs/roadmap-status.json') { excluded.push(path); continue; }
    const from = join(project, path);
    if (!existsSync(from) || !lstatSync(from).isFile()) { continue; }
    mkdirSync(dirname(join(root, path)), { recursive: true }); copyFileSync(from, join(root, path));
    manifest.push({ path, hash: contentHash(readFileSync(from)) });
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Acceptance'); git('config', 'user.email', 'acceptance@example.invalid'); git('add', '.'); git('commit', '-m', 'Application source for matched workflow evaluation');
  const installStart = Date.now();
  if (scip) { execFileSync('bun', ['install', '--frozen-lockfile'], { cwd: root, stdio: 'pipe', timeout: 300000 }); }
  const installMs = scip ? Date.now() - installStart : 0;
  const scanned = await scanRepository({ rootPath: root, scip });
  const store = await openStore(scanned.dbPath); const vectorStarted = Date.now();
  let vectorIndex: unknown = null;
  try {
    if (vectors) {
      await indexSnapshot({ store, snapshotId: scanned.snapshotId, repositoryName: scanned.repositoryName,
        collection: `repolead-acceptance-${basename(root)}`, embeddings: new TeiEmbeddingsClient(process.env['REPOLEAD_TEI_URL'] ?? 'http://localhost:8082'),
        qdrant: new QdrantRestClient(process.env['REPOLEAD_QDRANT_URL'] ?? 'http://localhost:6333') });
      vectorIndex = JSON.parse(store.getSnapshotMetadata(scanned.snapshotId, 'vector_index')!);
    }
  } finally { store.close(); }
  const prepared = { root, manifest, excluded, scanned, installMs, vectorMs: vectors ? Date.now() - vectorStarted : 0, vectorIndex };
  writeFileSync(join(root, '.repolead', 'capture.json'), JSON.stringify(prepared, null, 2) + '\n');
  return prepared;
}
