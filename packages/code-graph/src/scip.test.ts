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

test('SCIP preserves recursion and same-line callers, distinguishes callbacks, extends and implements-class', async () => {
  const root = createFixtureRepo();
  try {
    writeFileSync(join(root, 'src/inheritance.ts'), `export class Base { act(value: number) { return value; } }
export class Child extends Base { act(value: number) { return super.act(value); } }
export class ImplementsClass implements Base { act(value: number) { return value; } }
export function recur(value: number): number { return value ? recur(value - 1) : 0; }
export function left() { return recur(2); } export function right() { const emoji = '🧠'; return recur(3); }
export const callback = recur;
`);
    git(root, 'add', 'src/inheritance.ts');
    const result = await scanRepository({ rootPath: root, dbPath: join(root, 'details.db') });
    const store = await openStore(join(root, 'details.db'));
    try {
      const symbols = store.listSymbols(result.snapshotId);
      const byName = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol]));
      const graph = store.loadGraph(result.snapshotId);
      const relation = (from: string, to: string, type: string) => (graph.outgoing.get(byName.get(from)!.id) ?? []).some((edge) => edge.targetId === byName.get(to)!.id && edge.edgeType === type);
      expect(relation('Child', 'Base', 'EXTENDS')).toBe(true);
      expect(relation('ImplementsClass', 'Base', 'IMPLEMENTS')).toBe(true);
      expect(relation('ImplementsClass', 'Base', 'EXTENDS')).toBe(false);
      expect(relation('recur', 'recur', 'CALLS')).toBe(true);
      expect(relation('left', 'recur', 'CALLS')).toBe(true);
      expect(relation('right', 'recur', 'CALLS')).toBe(true);
      expect(relation('callback', 'recur', 'CALLS')).toBe(false);
      expect(relation('callback', 'recur', 'DEPENDS_ON')).toBe(true);
      const refs = store.getReferences(result.snapshotId, byName.get('recur')!.id);
      expect(refs.filter((entry) => entry.isCall)).toHaveLength(3);
      expect(refs.filter((entry) => !entry.isCall)).toHaveLength(1);
      expect(refs.filter((entry) => entry.startLine === 5).map((entry) => entry.sourceId)).toEqual([byName.get('left')!.id, byName.get('right')!.id]);
      expect(JSON.parse(store.getSnapshotMetadata(result.snapshotId, 'scip_diagnostics')!).indexers[0].status).toBe('complete');
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120000);

test('SCIP binds imported route aliases and never confuses a shadowed handler parameter with a module function', async () => {
  const root = createFixtureRepo();
  try {
    writeFileSync(join(root, 'src/handlers.ts'), 'export function actualHandler() { return 1; }\n');
    writeFileSync(join(root, 'src/routes.ts'), `import { actualHandler as registered } from './handlers';
declare const router: { post(path: string, handler: () => unknown): void };
function handler() { return 'unrelated'; }
router.post('/payments', registered);
export function install(handler: () => unknown) { router.post('/shadowed', handler); }
export class Visibility { run() {} private hidden() {} protected extend() {} #secret() {} }
`);
    git(root, 'add', 'src');
    const result = await scanRepository({ rootPath: root, dbPath: join(root, 'routes.db') });
    const store = await openStore(join(root, 'routes.db'));
    try {
      const graph = store.loadGraph(result.snapshotId);
      const byName = new Map([...graph.symbols.values()].map((symbol) => [symbol.qualifiedName, symbol]));
      const route = byName.get('POST /payments')!;
      expect((graph.outgoing.get(route.id) ?? []).some((edge) => edge.edgeType === 'CALLS' && edge.targetId === byName.get('actualHandler')!.id && edge.analyzer === 'route-binding-scip')).toBe(true);
      const shadowed = byName.get('POST /shadowed')!;
      expect((graph.outgoing.get(shadowed.id) ?? []).some((edge) => edge.edgeType === 'CALLS' && edge.targetId === byName.get('handler')!.id)).toBe(false);
      expect(byName.get('Visibility.run')!.visibility).toBe('public');
      expect(byName.get('Visibility.hidden')!.visibility).toBe('private');
      expect(byName.get('Visibility.extend')!.visibility).toBe('protected');
      expect(byName.get('Visibility.#secret')!.visibility).toBe('private');
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120000);
