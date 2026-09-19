import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { contentHash } from '@repolead/domain';
import type { KnowledgeStore } from '@repolead/knowledge-store';

/** Source is only evidence if it is indexed, inside the repo, and matches the snapshot. */
export function readIndexedSource(store: KnowledgeStore, snapshotId: string, rootPath: string, path: string): string {
  const root = realpathSync(rootPath);
  const target = realpathSync(resolve(root, path));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error('source path is outside the repository');
  }
  const canonical = relative(root, resolve(root, path)).replaceAll('\\', '/');
  const file = store.db.prepare('SELECT content_hash FROM files WHERE snapshot_id = ? AND path = ?')
    .get(snapshotId, canonical) as { content_hash: string } | undefined;
  if (!file) {
    throw new Error('source file is not indexed');
  }
  if (statSync(target).size > 1024 * 1024) {
    throw new Error('source file exceeds 1 MiB');
  }
  const source = readFileSync(target);
  if (contentHash(source) !== file.content_hash) {
    throw new Error('source changed since indexing; run repolead refresh');
  }
  return source.toString('utf8');
}
