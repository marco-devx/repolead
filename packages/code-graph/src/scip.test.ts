import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from '@rstest/core';

import { openStore } from '@repolead/knowledge-store';

import { scanRepository } from './scan';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function createFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'repolead-scip-fixture-'));
  mkdirSync(join(root, 'src'), { recursive: true });

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'scip-fixture' }));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: false, module: 'esnext', moduleResolution: 'bundler' }, include: ['src'] }),
  );
  writeFileSync(
    join(root, 'src/ports.ts'),
    `export interface OrderRepository {
  save(order: string): void;
}
`,
  );
  writeFileSync(
    join(root, 'src/repo.ts'),
    `import { OrderRepository } from './ports';

export class SqlOrderRepository implements OrderRepository {
  save(order: string): void {}
}
`,
  );
  writeFileSync(
    join(root, 'src/service.ts'),
    `import { SqlOrderRepository } from './repo';

export class OrderService {
  private readonly repo = new SqlOrderRepository();

  place(order: string): void {
    this.repo.save(order);
  }
}

export function checkout(service: OrderService): void {
  service.place('order-1');
}
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

test(
  'SCIP resuelve referencias: CALLS, IMPLEMENTS y find-references',
  async () => {
    const dbPath = join(fixtureRoot, 'scip-test.db');
    const result = await scanRepository({ rootPath: fixtureRoot, dbPath, repositoryName: 'scip-fixture' });

    expect(result.referencesResolved).not.toBeNull();
    expect(result.referencesResolved ?? 0).toBeGreaterThan(0);

    const store = await openStore(dbPath);
    const graph = store.loadGraph(result.snapshotId);
    const byName = new Map([...graph.symbols.values()].map((symbol) => [symbol.qualifiedName, symbol]));

    const save = byName.get('SqlOrderRepository.save');
    const place = byName.get('OrderService.place');
    const checkout = byName.get('checkout');
    const sqlRepo = byName.get('SqlOrderRepository');
    const port = byName.get('OrderRepository');
    expect(save && place && checkout && sqlRepo && port).toBeTruthy();

    const scipEdges = (id: string) =>
      (graph.incoming.get(id) ?? []).filter((edge) => edge.analyzer === 'scip');

    // find-references de save: su único caller es OrderService.place.
    const saveCallers = scipEdges(save!.id).filter((edge) => edge.edgeType === 'CALLS');
    expect(saveCallers.map((edge) => edge.sourceId)).toEqual([place!.id]);

    // find-references de place: llamado desde checkout.
    const placeCallers = scipEdges(place!.id).filter((edge) => edge.edgeType === 'CALLS');
    expect(placeCallers.map((edge) => edge.sourceId)).toEqual([checkout!.id]);

    // SqlOrderRepository IMPLEMENTS OrderRepository.
    const implementations = scipEdges(port!.id).filter((edge) => edge.edgeType === 'IMPLEMENTS');
    expect(implementations.map((edge) => edge.sourceId)).toContain(sqlRepo!.id);

    store.close();
  },
  120_000,
);
