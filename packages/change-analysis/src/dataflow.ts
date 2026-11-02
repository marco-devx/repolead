import { contentHash } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';
import { readSnapshotSource } from '@repolead/retrieval';
import { runJoern } from '@repolead/adapter-joern';

export interface DataFlowQuery { sourceMethod: string; sinkCall: string; language?: 'javascript' | 'python' }
function key(query: DataFlowQuery) { return `joern:${contentHash(JSON.stringify([query.sourceMethod, query.sinkCall, query.language ?? 'javascript']))}`; }

export async function analyzeDataFlow(store: KnowledgeStore, snapshotId: string, options: DataFlowQuery & { maxPaths?: number; timeoutMs?: number }) {
  const snapshot = store.getSnapshot(snapshotId); const repository = snapshot && store.getRepository(snapshot.repositoryId);
  if (!repository || store.getLatestSnapshot()?.id !== snapshotId) { throw new Error('Data flow requires the current snapshot.'); }
  const language = options.language ?? 'javascript';
  const files = (store.db.prepare('SELECT path, language, content_hash FROM files WHERE snapshot_id = ? ORDER BY path').all(snapshotId) as { path: string; language: string; content_hash: string }[])
    .filter((file) => language === 'python' ? file.language === 'python' : ['typescript', 'javascript'].includes(file.language));
  const captured = files.map((file) => ({ path: file.path, source: readSnapshotSource(store, snapshotId, repository.rootPath, file.path) }));
  const report = await runJoern({ ...options, language, files: captured });
  if (store.getLatestSnapshot()?.id !== snapshotId) { throw new Error('Snapshot changed during Joern analysis; result not published.'); }
  const result = { status: 'reported' as const, snapshotId, language, ...report,
    analyzedFiles: files.map((file) => ({ path: file.path, sourceHash: file.content_hash })), createdAt: new Date().toISOString() };
  store.setSnapshotMetadata(snapshotId, key(options), JSON.stringify(result));
  return result;
}

export function dataFlowResults(store: KnowledgeStore, snapshotId: string, query: DataFlowQuery, maxPaths = 10) {
  if (!Number.isInteger(maxPaths) || maxPaths < 1 || maxPaths > 100) { throw new Error('maxPaths must be 1–100.'); }
  const raw = store.getSnapshotMetadata(snapshotId, key(query));
  if (!raw) { return { status: 'not_available' as const, snapshotId, query,
    message: 'No Joern analysis for this query in the current snapshot. Run repolead dataflow with --run first.' }; }
  const report = JSON.parse(raw) as Awaited<ReturnType<typeof analyzeDataFlow>>;
  return { ...report, paths: report.paths.slice(0, maxPaths), truncated: report.truncated || report.paths.length > maxPaths,
    returnedPaths: Math.min(report.paths.length, maxPaths) };
}
