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
