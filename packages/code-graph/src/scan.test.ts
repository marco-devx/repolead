import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from '@rstest/core';

import { fileUri } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

import { scanRepository } from './scan';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function createFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'repolead-scan-'));
  mkdirSync(join(root, 'src'), { recursive: true });

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
  writeFileSync(
    join(root, 'src/service.ts'),
    `import { save } from './repo';

export class OrderService {
  place(order: Order): void {
    save(order);
  }
}
`,
  );
  writeFileSync(
    join(root, 'src/repo.ts'),
    `export function save(order: unknown): void {}
`,
  );
  writeFileSync(
    join(root, 'src/service.test.ts'),
    `import { OrderService } from './service';

test('places an order', () => {});
`,
  );

  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@repolead.dev');
  git(root, 'config', 'user.name', 'RepoLead Test');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'fixture');
  return root;
}

const fixtureRoot = createFixtureRepo();

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test('scanRepository indexa un repo TypeScript completo', async () => {
  const result = await scanRepository({ rootPath: fixtureRoot, dbPath: ':memory:', scip: false });

  expect(result.counts.files).toBe(4);
  expect(result.counts.symbols).toBeGreaterThanOrEqual(3);
  expect(result.counts.modules).toBe(1);
  expect(result.counts.tests).toBe(1);
  expect(result.counts.edges).toBeGreaterThanOrEqual(6);
  expect(result.counts.metrics).toBeGreaterThan(0);
});

test('el scan persiste símbolos consultables y edges correctos', async () => {
  const dbPath = join(fixtureRoot, 'scan-test.db');
  const result = await scanRepository({ rootPath: fixtureRoot, dbPath, repositoryName: 'fixture', scip: false });

  const store = await openStore(dbPath);
  const hits = store.searchSymbols(result.snapshotId, 'order service');
  expect(hits[0]?.symbol.qualifiedName).toBe('OrderService');

  const graph = store.loadGraph(result.snapshotId);
  const serviceFile = fileUri('fixture', 'src/service.ts');
  const testFile = fileUri('fixture', 'src/service.test.ts');

  const importEdges = graph.outgoing.get(serviceFile)?.filter((edge) => edge.edgeType === 'IMPORTS');
  expect(importEdges?.[0]?.targetId).toBe(fileUri('fixture', 'src/repo.ts'));

  const testedBy = graph.outgoing.get(serviceFile)?.filter((edge) => edge.edgeType === 'TESTED_BY');
  expect(testedBy?.[0]?.targetId).toBe(testFile);

  const symbolIds = [...graph.symbols.values()].map((symbol) => symbol.qualifiedName);
  expect(symbolIds).toContain('OrderService.place');

  store.close();
});

test('a failed snapshot never replaces the last complete indexed state', async () => {
  const dbPath = join(fixtureRoot, 'rollback.db');
  const first = await scanRepository({ rootPath: fixtureRoot, dbPath, scip: false });
  const store = await openStore(dbPath);
  try {
    store.db.exec("CREATE TRIGGER fail_files BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    await expect(scanRepository({ rootPath: fixtureRoot, dbPath, scip: false })).rejects.toThrow('fixture failure');
    expect(store.getLatestSnapshot()?.id).toBe(first.snapshotId);
    expect(store.getCounts(first.snapshotId).files).toBe(4);
  } finally { store.close(); }
});

test('tracked documentation and explicit code links are persisted and scoped by configuration', async () => {
  const root = createFixtureRepo();
  const database = join(root, 'docs.db');
  try {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# Orders\nThe service places orders.');
    writeFileSync(join(root, 'docs/product.md'), '# Product\nManagers approve orders.\n[Storage](../src/repo.ts#L1)\n[External](https://example.test/source.ts)');
    writeFileSync(join(root, 'private-notes.md'), '# Unselected\nNot part of configured product knowledge.');
    writeFileSync(join(root, 'docs/local.md'), '# Not tracked\nLocal notes are not ingested.');
    git(root, 'add', 'README.md', 'docs/product.md', 'private-notes.md');
    const result = await scanRepository({ rootPath: root, dbPath: database, repositoryName: 'docs', scip: false });
    const store = await openStore(database);
    try {
      expect(store.listDocuments(result.snapshotId).map((document) => document.path)).toEqual(['README.md', 'docs/product.md']);
      expect(store.searchDocuments(result.snapshotId, 'Managers')[0]?.document.path).toBe('docs/product.md');
      const save = store.listSymbols(result.snapshotId).find((symbol) => symbol.qualifiedName === 'save')!;
      const link = store.loadGraph(result.snapshotId).outgoing.get(save.id)?.find((edge) => edge.edgeType === 'DOCUMENTED_BY');
      expect(link?.targetId).toBe('repo://docs/docs/product.md#document');
      expect(link?.evidence).toEqual({ path: 'docs/product.md', line: 3, targetPath: 'src/repo.ts', targetLine: 1 });
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('external dependency imports, CommonJS and reexports remain visible to architecture policies', async () => {
  const root = createFixtureRepo();
  const database = join(root, 'imports.db');
  try {
    writeFileSync(join(root, 'src/core.js'), "const prisma = require('@prisma/client');\nexport { save } from './repo';\nexport function connect() { return prisma; }\n");
    git(root, 'add', 'src/core.js');
    const result = await scanRepository({ rootPath: root, dbPath: database, repositoryName: 'imports', scip: false });
    const store = await openStore(database);
    try {
      const edges = store.loadGraph(result.snapshotId).outgoing.get(fileUri('imports', 'src/core.js')) ?? [];
      const imports = edges.filter((edge) => edge.edgeType === 'IMPORTS');
      expect(imports.map((edge) => edge.targetId).sort()).toEqual(['external://npm/%40prisma%2Fclient', fileUri('imports', 'src/repo.ts')]);
      expect(imports.find((edge) => edge.targetId.startsWith('external:'))?.evidence)
        .toEqual({ path: 'src/core.js', line: 1, specifier: '@prisma/client' });
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exports, routes, exact spans and complete tests survive SQLite and incremental reuse', async () => {
  const root = createFixtureRepo();
  const database = join(root, 'facts.db');
  try {
    mkdirSync(join(root, 'src/api'), { recursive: true });
    writeFileSync(join(root, 'src/api/controller.ts'), `import { Controller, Get } from '@nestjs/common';
@Controller('orders')
export class Orders {
  @Get(':id')
  find(id: string) { return id; }
}
export function standalone() { return '🧠'; } export function neighbor() { return 2; }
`);
    writeFileSync(join(root, 'src/api/index.ts'), "export { Orders as PublicOrders } from './controller';\n");
    writeFileSync(join(root, 'src/api/order.test.ts'), "test('same name', () => { expect('firstbodymarker').toBeTruthy(); });\ntest('same name', () => { expect('secondbodymarker').toBeTruthy(); });\n");
    git(root, 'add', 'src/api');
    const scan = await scanRepository({ rootPath: root, dbPath: database, scip: false });
    const store = await openStore(database);
    try {
      const exports = store.listExports(scan.snapshotId, 'src/api/controller.ts');
      expect(exports.map((entry) => entry.exportedName)).toEqual(['Orders', 'neighbor', 'standalone']);
      expect(exports.every((entry) => entry.symbolId !== null)).toBe(true);
      const barrel = store.listExports(scan.snapshotId, 'src/api/index.ts')[0]!;
      expect(barrel.exportedName).toBe('PublicOrders');
      expect(barrel.sourceModule).toBe('./controller');
      expect(barrel.symbolId).toBe(exports.find((entry) => entry.exportedName === 'Orders')?.symbolId);
      expect(store.listModules(scan.snapshotId).some((module) => module.path === 'src/api')).toBe(true);
      const route = store.listSymbols(scan.snapshotId).find((symbol) => symbol.qualifiedName === 'GET /orders/:id')!;
      const handler = store.listSymbols(scan.snapshotId).find((symbol) => symbol.qualifiedName === 'Orders.find')!;
      expect(route.route?.framework).toBe('nest');
      expect(store.loadGraph(scan.snapshotId).outgoing.get(route.id)?.some((edge) => edge.targetId === handler.id && edge.analyzer === 'route-binding')).toBe(true);
      const standalone = store.listKnowledgeItems(scan.snapshotId).find((item) => item.title === 'standalone')!;
      expect(standalone.sourceComplete).toBe(true);
      expect(standalone.text).toContain('🧠');
      expect(standalone.text).not.toContain('function neighbor');
      const test = store.searchKnowledge(scan.snapshotId, 'secondbodymarker', 5, { entityKinds: ['test'] })[0]!.item;
      expect(test.sourceComplete).toBe(true);
      expect(test.text).not.toContain('firstbodymarker');
      expect(store.listTests(scan.snapshotId).filter((entry) => entry.path === 'src/api/order.test.ts')).toHaveLength(2);
      const repeat = await scanRepository({ rootPath: root, dbPath: database, scip: false, previousSnapshotId: scan.snapshotId });
      expect(repeat.parsing.parsedFiles).toBe(0);
      expect(store.listExports(repeat.snapshotId).map((entry) => entry.id)).toEqual(store.listExports(scan.snapshotId).map((entry) => entry.id));
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
