import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { refreshRepository, scanRepository } from '@repolead/code-graph';
import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { analyzeProductContext, analyzeSnapshot } from '@repolead/lead-analyzer';

import { ContractModel } from '../packages/lead-analyzer/test-support/contract-model';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'repolead-mcp-http-'));
const token = randomUUID();
const origin = 'https://product.example';
const fixtures: { root: string; dbPath: string; alias: string; snapshotId: string; documentId: string; symbolId: string; moduleId: string; sourceMarker: string; documentMarker: string }[] = [];
const payload = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;
};
const cli = join(projectRoot, 'apps/cli/dist/index.cjs');
const model = new ContractModel();
try {
  for (const [index, alias] of ['Producto Perú', 'Billing'].entries()) {
    const root = join(tempRoot, alias);
    const sourceMarker = `SOURCE_PRIVATE_${index}`;
    const documentMarker = `PRODUCT_DOCUMENT_${index}`;
    mkdirSync(join(root, 'src/payment'), { recursive: true });
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, '.gitignore'), '.repolead/\n');
    writeFileSync(join(root, 'package.json'), '{"name":"shared-project"}\n');
    writeFileSync(join(root, '.repolead.yaml'), 'modules:\n  - name: payment\n    path: src/payment\n');
    writeFileSync(join(root, 'src/payment/checkout.ts'), `export function checkout() { return "${sourceMarker}"; }\n`);
    writeFileSync(join(root, 'docs/product.md'), `# Product\n${documentMarker}\n[Checkout](../src/payment/checkout.ts#L1)\n`);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init', '-b', 'main'); git('config', 'user.name', 'RepoLead acceptance');
    git('config', 'user.email', 'acceptance@example.invalid'); git('add', '.'); git('commit', '-m', 'Fixture');
    // Same declared repository name deliberately gives the databases overlapping subject IDs.
    const scanned = await scanRepository({ rootPath: root, repositoryName: 'shared-project', scip: false });
    const store = await openStore(scanned.dbPath);
    try {
      const options = { store, snapshotId: scanned.snapshotId, model, budget: { maxTokens: 4000 } };
      await analyzeSnapshot(options); await analyzeProductContext(options);
      const symbol = store.listSymbols(scanned.snapshotId).find((entry) => entry.qualifiedName === 'checkout')!;
      const module = store.listModules(scanned.snapshotId).find((entry) => entry.name === 'payment')!;
      const document = store.listDocuments(scanned.snapshotId)[0]!;
      const snapshot = store.getLatestSnapshot()!;
      store.insertFinding({ id: 'shared-finding', repositoryId: snapshot.repositoryId, snapshotId: snapshot.id,
        ruleId: 'HTTP-ACCEPTANCE', severity: 'low', confidence: 1, claim: 'Persisted excerpt fixture',
        recommendation: null, module: module.id, status: 'confirmed', supersededBy: null, createdAt: new Date().toISOString() },
      [{ id: 'shared-evidence', ownerId: 'shared-finding', ownerKind: 'finding', path: symbol.path, startLine: 1, endLine: 1,
        excerpt: `Stored finding excerpt ${index}` }]);
      fixtures.push({ root, dbPath: scanned.dbPath, alias, snapshotId: scanned.snapshotId,
        documentId: document.id, symbolId: symbol.id, moduleId: module.id, sourceMarker, documentMarker });
    } finally { store.close(); }
  }
  assert.equal(fixtures[0]!.symbolId, fixtures[1]!.symbolId);
  let resourcesRead = 0; let verifiedToolCalls = 0;
  const child = spawn(process.execPath, [cli, 'serve', '--dir', tempRoot, '--http', '--port', '0', '--allow-origin', origin, '--no-source'],
    { cwd: tempRoot, env: { ...process.env, REPOLEAD_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  let stderr = '';
  const client = new Client({ name: 'repolead-http-acceptance', version: '1' });
  const observer = new Client({ name: 'repolead-second-http-client', version: '1' });
  let protocolVersion: string | undefined;
  try {
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timeout = setTimeout(() => reject(new Error(`HTTP CLI startup timed out: ${stderr}`)), 15000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`HTTP CLI exited ${code}: ${stderr}`)); });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(stderr);
        if (match) { clearTimeout(timeout); resolveUrl(match[0]); }
      });
    });
    const headers = { authorization: `Bearer ${token}`, origin };
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://denied.example' } })).status, 403);
    const fetchWithProtocolCapture: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (typeof init?.body === 'string' && init.body.includes('"method":"initialize"')) {
        const initialized = await response.clone().json() as { result: { protocolVersion: string } };
        protocolVersion = initialized.result.protocolVersion;
      }
      return response;
    };
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers }, fetch: fetchWithProtocolCapture }));
    await observer.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    assert.equal(protocolVersion, '2025-11-25');
    assert.ok(client.getInstructions()?.includes('audience=product'));
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes('context_pack') && tools.includes('repo_overview'));
    const overview = await payload(client, 'repo_overview');
    assert.deepEqual((overview['repos'] as { repo: string }[]).map((entry) => entry.repo).sort(), fixtures.map((entry) => entry.alias).sort());
    const resources = (await client.listResources()).resources;
    assert.ok(resources.length >= 12);
    assert.equal(new Set(resources.map((entry) => entry.uri)).size, resources.length);
    for (const resource of resources) {
      const response = await client.readResource({ uri: resource.uri });
      const memory = JSON.parse((response.contents[0] as { text: string }).text) as { repo: string; snapshotId: string };
      const fixture = fixtures.find((entry) => entry.alias === memory.repo)!;
      assert.equal(memory.snapshotId, fixture.snapshotId);
      for (const entry of fixtures) { assert.ok(!JSON.stringify(response).includes(entry.sourceMarker)); }
      resourcesRead += 1;
    }
    for (const [name, args] of [
      ['symbol_context', { symbol: 'checkout' }], ['module_context', { module: 'payment' }],
      ['get_evidence', { documentId: fixtures[0]!.documentId }], ['get_evidence', { findingId: 'shared-finding' }],
    ] as const) {
      assert.match(String((await payload(client, name, args))['error']), /ambigu/);
      verifiedToolCalls += 1;
    }
    for (const fixture of fixtures) {
      const repo = fixture.alias;
      const calls = [
        ['repo_overview', { repo, audience: 'product' }],
        ['repo_overview', { repo, audience: 'technical' }],
        ['symbol_context', { repo, symbol: fixture.symbolId }],
        ['module_context', { repo, module: fixture.moduleId }],
        ['search', { repo, query: 'checkout', limit: 10 }],
        ['architecture_findings', { repo }],
        ['get_evidence', { repo, findingId: 'shared-finding' }],
        ['get_evidence', { repo, path: 'src/payment/checkout.ts' }],
      ] as const;
      for (const [name, args] of calls) {
        const value = await payload(client, name, args);
        for (const entry of fixtures) { assert.ok(!JSON.stringify(value).includes(entry.sourceMarker), `${name} must honor no-source`); }
        verifiedToolCalls += 1;
      }
      const document = await payload(client, 'get_evidence', { repo, documentId: fixture.documentId });
      assert.equal(document['repo'], repo);
      assert.ok(String(document['text']).includes(fixture.documentMarker));
      assert.ok(!String(document['text']).includes(fixtures.find((entry) => entry.alias !== repo)!.documentMarker));
      const context = await client.callTool({ name: 'context_pack', arguments: { repo, symbols: ['checkout'], includeSource: true, maxTokens: 2000 } });
      for (const entry of fixtures) { assert.ok(!JSON.stringify(context).includes(entry.sourceMarker)); }
      verifiedToolCalls += 2;
    }
    const first = fixtures[0]!;
    const firstResources = resources.filter((entry) => entry.uri.includes(encodeURIComponent(first.alias)));
    assert.ok(firstResources.length > 0);
    writeFileSync(join(first.root, 'src/payment/checkout.ts'), 'export function checkout() { return "CHANGED_SOURCE_PRIVATE"; }\n');
    const refreshed = await refreshRepository({ rootPath: first.root, scip: false });
    assert.equal(refreshed.upToDate, false);
    // Both already-connected clients must observe the new snapshot, without prior dossier fallback.
    for (const activeClient of [client, observer]) {
      const current = await payload(activeClient, 'repo_overview', { repo: first.alias, audience: 'product' });
      assert.equal(current['resource'], null);
      assert.notEqual(current['snapshotId'], first.snapshotId);
      const remaining = (await activeClient.listResources()).resources;
      assert.equal(remaining.length, resources.length - firstResources.length);
      await assert.rejects(() => activeClient.readResource({ uri: firstResources[0]!.uri }), /current snapshot/);
      assert.ok((await payload(activeClient, 'get_evidence', { repo: first.alias, findingId: 'shared-finding' }))['error']);
    }
    const store = await openStore(first.dbPath);
    try {
      const options = { store, snapshotId: store.getLatestSnapshot()!.id, model, budget: { maxTokens: 4000 } };
      await analyzeSnapshot(options); await analyzeProductContext(options);
    } finally { store.close(); }
    for (const activeClient of [client, observer]) {
      const updated = await payload(activeClient, 'repo_overview', { repo: first.alias, audience: 'product' });
      assert.ok(updated['resource']);
      const memory = await activeClient.readResource({ uri: String(updated['resource']) });
      const result = JSON.parse((memory.contents[0] as { text: string }).text) as { snapshotId: string };
      assert.equal(result.snapshotId, updated['snapshotId']);
      const untouched = await payload(activeClient, 'repo_overview', { repo: fixtures[1]!.alias });
      assert.equal(untouched['snapshotId'], fixtures[1]!.snapshotId);
    }
    const report = { generatedAt: new Date().toISOString(), runtime: { bun: process.versions.bun, platform: process.platform },
      transport: 'real HTTP subprocess using compiled CLI and official MCP SDK clients', protocolVersion,
      repositories: fixtures.map((entry) => entry.alias), simultaneousClients: 2, resourcesRead, verifiedToolCalls,
      verified: ['CLI discovery and ephemeral localhost port', 'Bearer authentication and browser Origin allowlist',
        'technical/product memory resources with encoded repository aliases', 'overlapping subject IDs require explicit repository',
        'no-source across tools/resources while persisted product documents remain available',
        'refresh is visible to connected clients without historical summary/finding fallback',
        'regenerated memory becomes available and the other repository stays unchanged'],
      limits: ['Contract model only; no semantic answer evaluation, provider token saving or real customer authorization measured.',
        'One bearer token grants access to all served repositories; repository selection is not per-user authorization.',
        'Stateless Streamable HTTP, protocol 2025-11-25; no claim of 2026 transport compatibility.'],
      scriptHash: contentHash(readFileSync(fileURLToPath(import.meta.url))) };
    writeFileSync(join(projectRoot, 'benchmarks/mcp-http-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close(); await observer.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); }
    await exited;
  }
} finally { rmSync(tempRoot, { recursive: true, force: true }); }
