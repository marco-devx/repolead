import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const MAX_BUFFER = 32 * 1024 * 1024;
const HISTORY_COMMIT_LIMIT = 500;
/** Commits que tocan más archivos que esto no aportan señal de co-cambio. */
const CO_CHANGE_MAX_FILES_PER_COMMIT = 30;
const CO_CHANGE_MIN_COUNT = 3;
const CO_CHANGE_TOP_PAIRS = 50;

const COMMIT_MARK = '\u0001';
const FIELD_MARK = '\u0002';

async function git(rootPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', rootPath, ...args], { maxBuffer: MAX_BUFFER });
  return stdout;
}

export async function gitHead(rootPath: string): Promise<string> {
  return (await git(rootPath, ['rev-parse', 'HEAD'])).trim();
}

export async function listTrackedFiles(rootPath: string): Promise<string[]> {
  const output = await git(rootPath, ['ls-files', '-z']);
  return output.split('\0').filter(Boolean);
}

/**
 * Archivos cambiados desde un commit (committed + working tree). Los
 * untracked se excluyen a propósito: el scan solo indexa archivos
 * trackeados, así que no pueden invalidar nada.
 */
export async function changedFilesSince(rootPath: string, commitSha: string): Promise<string[]> {
  const diff = await git(rootPath, ['diff', '--name-only', commitSha]);
  return [
    ...new Set(
      diff
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export interface FileHistory {
  path: string;
  commitCount: number;
  lastAuthor: string;
  lastCommitAt: string;
  firstCommitAt: string;
}

export interface CoChangePair {
  a: string;
  b: string;
  count: number;
}

export interface RepositoryHistory {
  files: Map<string, FileHistory>;
  coChanges: CoChangePair[];
}

/**
 * Dimensión temporal del repositorio: frecuencia de cambios, autoría y
 * co-cambios (archivos que cambian juntos sin dependencia declarada),
 * sobre los últimos N commits.
 */
export async function collectHistory(rootPath: string): Promise<RepositoryHistory> {
  const output = await git(rootPath, [
    'log',
    `-n${HISTORY_COMMIT_LIMIT}`,
    '--name-only',
    '--no-renames',
    `--format=${COMMIT_MARK}%an${FIELD_MARK}%aI`,
  ]);

  const files = new Map<string, FileHistory>();
  const pairCounts = new Map<string, number>();

  for (const block of output.split(COMMIT_MARK)) {
    if (!block.trim()) {
      continue;
    }
    const newlineIndex = block.indexOf('\n');
    const header = newlineIndex === -1 ? block : block.slice(0, newlineIndex);
    const body = newlineIndex === -1 ? '' : block.slice(newlineIndex + 1);
    const [author, date] = header.split(FIELD_MARK);
    if (!author || !date) {
      continue;
    }
    const changed = body
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const path of changed) {
      const existing = files.get(path);
      if (existing) {
        existing.commitCount += 1;
        existing.firstCommitAt = date;
      } else {
        // git log va de más reciente a más antiguo: el primer avistamiento es el último commit.
        files.set(path, {
          path,
          commitCount: 1,
          lastAuthor: author,
          lastCommitAt: date,
          firstCommitAt: date,
        });
      }
    }

    if (changed.length >= 2 && changed.length <= CO_CHANGE_MAX_FILES_PER_COMMIT) {
      const sorted = [...changed].sort();
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          const key = `${sorted[i]}\n${sorted[j]}`;
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const coChanges = [...pairCounts.entries()]
    .filter(([, count]) => count >= CO_CHANGE_MIN_COUNT)
    .sort((left, right) => right[1] - left[1])
    .slice(0, CO_CHANGE_TOP_PAIRS)
    .map(([key, count]) => {
      const [a = '', b = ''] = key.split('\n');
      return { a, b, count };
    });

  return { files, coChanges };
}
