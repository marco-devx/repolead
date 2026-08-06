import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from '@rstest/core';

import { refreshRepository } from './refresh';
import { scanRepository } from './scan';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function createFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'repolead-refresh-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
  writeFileSync(join(root, 'src/service.ts'), `export function place(order: string): void {}\n`);
  writeFileSync(join(root, 'src/repo.ts'), `export function save(order: unknown): void {}\n`);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@repolead.dev');
  git(root, 'config', 'user.name', 'RepoLead Test');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'fixture');
  return root;
}

const fixtureRoot = createFixtureRepo();
const dbPath = join(fixtureRoot, 'refresh-test.db');

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test('refresh detecta "sin cambios" y luego invalida solo lo tocado', async () => {
  await scanRepository({ rootPath: fixtureRoot, dbPath, scip: false, repositoryName: 'fixture' });

  const clean = await refreshRepository({ rootPath: fixtureRoot, dbPath, scip: false, repositoryName: 'fixture' });
  expect(clean.upToDate).toBe(true);
  expect(clean.changedSymbolIds).toEqual([]);

  // Cambio en un solo archivo: nueva función en service.ts.
  appendFileSync(join(fixtureRoot, 'src/service.ts'), `export function cancel(id: string): void {}\n`);

  const dirty = await refreshRepository({ rootPath: fixtureRoot, dbPath, scip: false, repositoryName: 'fixture' });
  expect(dirty.upToDate).toBe(false);
  expect(dirty.changedFiles).toEqual(['src/service.ts']);
  // place cambió de hash (el archivo cambió) o al menos cancel es nuevo; save intacto.
  expect(dirty.changedSymbolIds.length).toBeGreaterThanOrEqual(1);
  expect(dirty.affectedModules).toEqual(['fixture']);
  expect(dirty.removedSymbolIds).toEqual([]);

  // Los símbolos de repo.ts no fueron invalidados.
  const { openStore } = await import('@repolead/knowledge-store');
  const store = await openStore(dbPath);
  const unchanged = store
    .listSymbols(dirty.scan!.snapshotId)
    .filter((symbol) => symbol.path === 'src/repo.ts');
  expect(unchanged.every((symbol) => !dirty.changedSymbolIds.includes(symbol.id))).toBe(true);
  store.close();
});
