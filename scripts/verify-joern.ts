import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { scanRepository, refreshRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';
import { analyzeDataFlow, dataFlowResults } from '@repolead/change-analysis';
import { contentHash } from '@repolead/domain';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const root = mkdtempSync(join(tmpdir(), 'repolead-joern-acceptance-'));
const source = 'function entry(value) {\n  const copy = value;\n  sink(copy);\n}\nfunction safe(value) { sink("constant"); }\nfunction sink(input) { return input; }\nentry("test");\n';
try {
  writeFileSync(join(root, 'flow.js'), source); writeFileSync(join(root, '.gitignore'), '.repolead/\n');
  writeFileSync(join(root, 'flow.py'), 'def entry(value):\n    copy = value\n    sink(copy)\n\ndef sink(item):\n    return item\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Acceptance'); git('config', 'user.email', 'acceptance@example.invalid'); git('add', '.'); git('commit', '-m', 'Known data flow');
  const scan = await scanRepository({ rootPath: root, scip: false }); const store = await openStore(scan.dbPath);
  try {
    const query = { sourceMethod: 'entry', sinkCall: 'sink' };
    assert.equal(dataFlowResults(store, scan.snapshotId, query).status, 'not_available');
    const positive = await analyzeDataFlow(store, scan.snapshotId, query);
    assert.ok(positive.paths.length > 0); assert.ok(positive.paths.some((path) => path.some((node) => node.line === 3)));
    assert.ok(positive.paths.flat().every((node) => node.path === 'flow.js' && node.sourceHash === contentHash(source)));
    const negative = await analyzeDataFlow(store, scan.snapshotId, { sourceMethod: 'safe', sinkCall: 'sink' });
    assert.equal(negative.paths.length, 0);
    const python = await analyzeDataFlow(store, scan.snapshotId, { ...query, language: 'python' });
    assert.ok(python.paths.length > 0); assert.ok(python.paths.flat().every((node) => node.path === 'flow.py'));
    const cli = join(project, 'apps/cli/dist/index.cjs');
    const cliResult = JSON.parse(execFileSync('node', [cli, 'dataflow', 'entry', 'sink', '--db', scan.dbPath], { encoding: 'utf8' }));
    assert.equal(cliResult.status, 'reported');
    const client = new Client({ name: 'joern-acceptance', version: '1' });
    const transport = new StdioClientTransport({ command: 'node', args: [cli, 'serve', '--db', scan.dbPath, '--no-source'], stderr: 'pipe' });
    try {
      await client.connect(transport);
      const response = await client.callTool({ name: 'trace_flow', arguments: { engine: 'joern', from: 'entry', to: 'sink' } });
      const text = (response.content as { text: string }[])[0]!.text;
      assert.equal(JSON.parse(text).status, 'reported'); assert.ok(!text.includes('sink(copy)'));
      writeFileSync(join(root, 'flow.js'), source.replace('sink(copy)', 'sink("constant")'));
      await refreshRepository({ rootPath: root, scip: false });
      const latest = store.getLatestSnapshot()!;
      assert.equal(dataFlowResults(store, latest.id, query).status, 'not_available');
      const fresh = await client.callTool({ name: 'trace_flow', arguments: { engine: 'joern', from: 'entry', to: 'sink' } });
      assert.equal(JSON.parse((fresh.content as { text: string }[])[0]!.text).status, 'not_available');
    } finally { await client.close(); }
    const report = { generatedAt: new Date().toISOString(), passed: true, distribution: { engine: positive.engine, version: positive.engineVersion, identity: 'Installed x2cpg core JAR filename; installer must verify release checksums independently' },
      scriptHash: contentHash(readFileSync(import.meta.filename, 'utf8')), positive, negative, python,
      checks: ['Real JavaScript and Python frontend/dataflow execution', 'Literal sink counterexample has zero observed flows',
        'Source and line hashes verified', 'Compiled Node CLI and no-source MCP', 'Refresh withholds previous report'],
      limits: ['Finite fixtures, default OSS semantics; not runtime proof or security precision/recall.'] };
    writeFileSync(join(project, 'benchmarks/joern-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: true, jsPaths: positive.paths.length, pythonPaths: python.paths.length, negativePaths: negative.paths.length }));
  } finally { store.close(); }
} finally { rmSync(root, { recursive: true, force: true }); }
