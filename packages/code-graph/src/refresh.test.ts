import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from '@rstest/core';
import { fileUri } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

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
  expect(dirty.scan?.parsing).toEqual({ parsedFiles: 1, reusedFiles: 1 });
  expect((await refreshRepository({ rootPath: fixtureRoot, dbPath, scip: false })).upToDate).toBe(true);

  // Los símbolos de repo.ts no fueron invalidados.
  const { openStore } = await import('@repolead/knowledge-store');
  const store = await openStore(dbPath);
  const unchanged = store
    .listSymbols(dirty.scan!.snapshotId)
    .filter((symbol) => symbol.path === 'src/repo.ts');
  expect(unchanged.every((symbol) => !dirty.changedSymbolIds.includes(symbol.id))).toBe(true);
  store.close();
});

test('renames and deletions invalidate their files and dependencies without reparsing unchanged callers', async () => {
  const root = createFixtureRepo();
  const database = join(root, 'renames.db');
  try {
    writeFileSync(join(root, 'src/service.ts'), "import { save } from './repo';\nexport function place() { save(null); }\n");
    writeFileSync(join(root, '.repolead.yaml'), 'modules:\n  - name: services\n    path: src\n');
    const first = await scanRepository({ rootPath: root, dbPath: database, repositoryName: 'rename', scip: false });
    git(root, 'mv', 'src/repo.ts', 'src/storage.ts');
    const renamed = await refreshRepository({ rootPath: root, dbPath: database, scip: false });
    expect(renamed.changedFiles).toEqual(['src/repo.ts', 'src/storage.ts']);
    expect(renamed.removedSymbolIds).toHaveLength(1);
    expect(renamed.scan?.parsing).toEqual({ parsedFiles: 1, reusedFiles: 1 });
    const store = await openStore(database);
    try {
      const oldImports = store.loadGraph(first.snapshotId).outgoing.get(fileUri('rename', 'src/service.ts')) ?? [];
      expect(oldImports.some((edge) => edge.edgeType === 'IMPORTS')).toBe(true);
      const newImports = store.loadGraph(renamed.scan!.snapshotId).outgoing.get(fileUri('rename', 'src/service.ts')) ?? [];
      expect(newImports.some((edge) => edge.edgeType === 'IMPORTS')).toBe(false);
    } finally { store.close(); }
    rmSync(join(root, 'src/storage.ts'));
    const deleted = await refreshRepository({ rootPath: root, dbPath: database, scip: false });
    expect(deleted.changedFiles).toEqual(['src/storage.ts']);
    expect(deleted.scan?.parsing).toEqual({ parsedFiles: 0, reusedFiles: 1 });
    expect(deleted.affectedModules).toContain('services');
    expect((await refreshRepository({ rootPath: root, dbPath: database, scip: false })).upToDate).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local module configuration preserves repo identity, owns nested JS files and invalidates refresh', async () => {
  const root = createFixtureRepo();
  const database = join(root, 'configured.db');
  try {
    mkdirSync(join(root, 'src/ui'), { recursive: true });
    writeFileSync(join(root, 'src/ui/view.jsx'), "import { label } from './labels';\nexport const View = () => <div>{label()}</div>;\n");
    writeFileSync(join(root, 'src/ui/labels.js'), "export function label() { return 'Orders'; }\n");
    git(root, 'add', 'src/ui');
    git(root, 'commit', '-m', 'JavaScript UI');
    // Configuration need not be committed to apply to indexing.
    writeFileSync(join(root, '.repolead.yaml'), 'modules:\n  - name: service\n    path: src/\n  - name: interface\n    path: src/ui/\n');
    const first = await scanRepository({ rootPath: root, dbPath: database, repositoryName: 'Custom name', scip: false });
    const store = await openStore(database);
    try {
      expect(store.listSymbols(first.snapshotId).map((symbol) => symbol.qualifiedName)).toContain('View');
      expect(store.listSymbols(first.snapshotId).map((symbol) => symbol.qualifiedName)).toContain('label');
      const graph = store.loadGraph(first.snapshotId);
      const ui = store.listModules(first.snapshotId).find((module) => module.name === 'interface')!;
      expect(ui.path).toBe('src/ui');
      expect(graph.outgoing.get(ui.id)?.map((edge) => edge.targetId)).toContain(fileUri('Custom name', 'src/ui/view.jsx'));
      expect(graph.outgoing.get(fileUri('Custom name', 'src/ui/view.jsx'))?.find((edge) => edge.edgeType === 'IMPORTS')?.targetId)
        .toBe(fileUri('Custom name', 'src/ui/labels.js'));
    } finally { store.close(); }
    expect((await refreshRepository({ rootPath: root, dbPath: database, scip: false })).upToDate).toBe(true);
    writeFileSync(join(root, '.repolead.yaml'), 'modules:\n  - name: frontend\n    path: src/ui\n');
    const changed = await refreshRepository({ rootPath: root, dbPath: database, scip: false });
    expect(changed.upToDate).toBe(false);
    expect(changed.scan?.repositoryName).toBe('Custom name');
    expect(changed.changedSymbolIds).toEqual([]);
    expect((await refreshRepository({ rootPath: root, dbPath: database, scip: false })).upToDate).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
