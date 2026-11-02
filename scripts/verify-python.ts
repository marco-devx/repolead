import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { traceFlow } from '@repolead/change-analysis';
import { collectQuality, scanRepository } from '@repolead/code-graph';
import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'repolead-python-'));
const write = (path: string, source: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
try {
  write('.gitignore', '.repolead/\n');
  write('pyproject.toml', '[project]\nname="python-acceptance"\nversion="0.1.0"\n');
  write('pyrightconfig.json', JSON.stringify({ include: ['app', 'tests'], pythonVersion: '3.11', stubPath: 'typings' }));
  write('typings/fastapi/__init__.pyi', 'from typing import Callable, Any\nclass FastAPI:\n    def post(self, path: str) -> Callable[[Any], Any]: ...\n');
  write('app/__init__.py', '');
  write('app/storage.py', `def persist(value: str) -> str:\n    return value\n\nclass Repository:\n    def save(self, value: str) -> str:\n        return persist(value)\n\nclass Child(Repository):\n    pass\n`);
  write('app/service.py', `from .storage import Repository as Store\n\ndef checkout(value: str) -> str:\n    return Store().save(value)\n\ndef callback():\n    return Store().save\n\ndef recur(value: int) -> int:\n    return recur(value - 1) if value else 0\n\ndef unicode_call() -> int:\n    label = "😀"; return recur(2)\n`);
  write('app/api.py', `from fastapi import FastAPI\nfrom .service import checkout as place\napp = FastAPI()\n\n@app.post('/orders')\ndef create_order(value: str) -> str:\n    return place(value)\n`);
  write('tests/test_orders.py', `from app.api import create_order\n\ndef test_order():\n    assert create_order('x') == 'x'\n`);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Python acceptance'); git('config', 'user.email', 'python@example.invalid'); git('add', '.'); git('commit', '-m', 'Python fixture');
  const scanned = await scanRepository({ rootPath: root });
  const store = await openStore(scanned.dbPath);
  let refsCount = 0; let verifiedRelations = 0; let recurId = '';
  let metrics: Awaited<ReturnType<typeof collectQuality>>;
  try {
    const diagnostics = JSON.parse(store.getSnapshotMetadata(scanned.snapshotId, 'scip_diagnostics')!);
    assert.equal(diagnostics.indexers.find((entry: { tool: string }) => entry.tool === 'scip-python')?.status, 'complete', JSON.stringify(diagnostics.indexers));
    const graph = store.loadGraph(scanned.snapshotId);
    const byName = new Map([...graph.symbols.values()].map((symbol) => [symbol.qualifiedName, symbol]));
    for (const name of ['persist', 'Repository', 'Repository.save', 'Child', 'checkout', 'callback', 'recur', 'unicode_call', 'create_order', 'POST /orders']) {
      assert.ok(byName.has(name), `Missing Python symbol ${name}; actual: ${[...byName.keys()]}`);
    }
    const relation = (from: string, to: string, type: string) => (graph.outgoing.get(byName.get(from)!.id) ?? [])
      .some((edge) => edge.targetId === byName.get(to)!.id && edge.edgeType === type);
    for (const [from, to, type] of [
      ['Repository.save', 'persist', 'CALLS'], ['checkout', 'Repository.save', 'CALLS'], ['callback', 'Repository.save', 'DEPENDS_ON'],
      ['Child', 'Repository', 'EXTENDS'], ['recur', 'recur', 'CALLS'], ['unicode_call', 'recur', 'CALLS'],
      ['create_order', 'checkout', 'CALLS'], ['POST /orders', 'create_order', 'CALLS'],
    ]) { assert.ok(relation(from!, to!, type!), `${from} ${type} ${to}`); verifiedRelations += 1; }
    assert.equal(relation('callback', 'Repository.save', 'CALLS'), false);
    const expected = [
      { target: 'persist', path: 'app/storage.py', line: 6, token: 'persist', call: true },
      { target: 'Repository.save', path: 'app/service.py', line: 4, token: 'save', call: true },
      { target: 'Repository.save', path: 'app/service.py', line: 7, token: 'save', call: false },
      { target: 'recur', path: 'app/service.py', line: 10, token: 'recur', call: true },
      { target: 'recur', path: 'app/service.py', line: 13, token: 'recur', call: true },
      { target: 'checkout', path: 'app/api.py', line: 7, token: 'place', call: true },
      { target: 'create_order', path: 'tests/test_orders.py', line: 4, token: 'create_order', call: true },
    ];
    for (const entry of expected) {
      const line = readFileSync(join(root, entry.path), 'utf8').split('\n')[entry.line - 1]!;
      const column = line.indexOf(entry.token);
      const refs = store.getReferences(scanned.snapshotId, byName.get(entry.target)!.id);
      assert.ok(refs.some((ref) => ref.path === entry.path && ref.startLine === entry.line && ref.startColumn === column
        && ref.endColumn === column + entry.token.length && ref.isCall === entry.call), `Missing exact UTF-16 reference ${JSON.stringify(entry)}; refs=${JSON.stringify(refs)}`);
      refsCount += 1;
    }
    assert.ok(store.listTests(scanned.snapshotId).some((entry) => entry.name === 'test_order'));
    const flow = traceFlow(store, scanned.snapshotId, { from: 'POST /orders', to: 'persist' });
    assert.ok(!('error' in flow));
    assert.deepEqual(flow.paths[0]!.nodes.map((node) => node.name), ['POST /orders', 'create_order', 'checkout', 'Repository.save', 'persist']);
    metrics = await collectQuality({ store, snapshotId: scanned.snapshotId, tools: ['ruff', 'radon'] });
    assert.equal(metrics.tools.ruff?.status, 'complete'); assert.equal(metrics.tools.radon?.status, 'complete');
    assert.ok(store.listMetrics(scanned.snapshotId).some((metric) => metric.analyzer === 'quality:radon'));
    recurId = byName.get('recur')!.id;
  } finally { store.close(); }
  const cli = join(project, 'apps/cli/dist/index.cjs');
  const client = new Client({ name: 'python-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command: 'node', args: [cli, 'serve', '--db', scanned.dbPath, '--no-source'], cwd: root, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: 'find_references', arguments: { symbol: recurId, limit: 1 } });
    assert.ok(!response.isError); const payload = JSON.parse((response.content as { text: string }[])[0]!.text);
    assert.ok(JSON.stringify(payload).includes('app/service.py'));
  } finally { await client.close(); }
  const report = { generatedAt: new Date().toISOString(), indexer: '@sourcegraph/scip-python 0.6.6 (actual execution)',
    verifiedRelations, exactUtf16References: refsCount, routeFlow: ['POST /orders', 'create_order', 'checkout', 'Repository.save', 'persist'],
    verified: ['import aliases', 'method call versus reference-only callback', 'class inheritance', 'recursion', 'Unicode columns', 'pytest extraction', 'FastAPI declared route', 'MCP reference delivery'],
    metrics: metrics!.tools,
    limits: ['FastAPI typing uses a fixture stub; no FastAPI server or target tests executed.',
      'Seven specified occurrences and eight relations are a finite semantic fixture, not full Python/dynamic dispatch conformance.'],
    scriptHash: contentHash(readFileSync(fileURLToPath(import.meta.url))) };
  writeFileSync(join(project, 'benchmarks/python-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
