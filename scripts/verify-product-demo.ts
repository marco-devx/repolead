import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const credentials = JSON.parse(readFileSync(process.argv[2] ?? '.repolead/product-demo/credentials.json', 'utf8')) as { url: string; token: string };
const client = new Client({ name: 'repolead-product-demo-verification', version: '1' });
const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), endpoint: credentials.url };
const call = async (name: string, args: Record<string, unknown>) => {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, `Product call failed: ${name}`);
  return JSON.parse((response.content as { text: string }[])[0]!.text) as Record<string, unknown>;
};
try {
  assert.equal((await fetch(credentials.url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(credentials.url.replace(/\/mcp$/, '/'))).status, 404);
  await client.connect(new StreamableHTTPClientTransport(new URL(credentials.url), {
    requestInit: { headers: { Authorization: `Bearer ${credentials.token}` } },
  }));
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['product_catalog', 'product_context', 'product_evidence', 'product_investigate']);
  assert.equal((await client.callTool({ name: 'get_evidence', arguments: { path: '../source.py' } })).isError, true);
  await assert.rejects(client.readResource({ uri: 'repolead://knowledge/access-service/file/c291cmNl' }));
  const catalog = await call('product_catalog', {});
  const repos = catalog['repositories'] as { repo: string; status: string; analyses: number; categories: string[]; indexedAt: string; omittedAnalyses: number }[];
  const results: Record<string, unknown>[] = [];
  for (const repo of repos.filter((entry) => entry.status === 'ready' && entry.analyses > 0)) {
    const topics = await call('product_catalog', { repo: repo.repo, limit: 1 });
    const first = (topics['topics'] as { ref: string; title: string }[])[0];
    assert.ok(first);
    const started = performance.now();
    const context = await call('product_context', { repo: repo.repo, queries: [first.title], limit: 3, maxTokens: 12000 });
    const records = context['records'] as { ref: string; rules: string[]; facts: unknown[]; omittedFields: number }[];
    assert.ok(records.length > 0, `No context retrieved in ${repo.repo}`);
    const evidence = await call('product_evidence', { repo: repo.repo, ref: records[0]!.ref });
    assert.equal((evidence['record'] as { ref: string }).ref, records[0]!.ref);
    results.push({ repo: repo.repo, analyses: repo.analyses, omittedAnalyses: repo.omittedAnalyses,
      indexedAt: repo.indexedAt, availableCategories: repo.categories, testedTopic: first.title,
      retrieved: records.length, rules: records.reduce((n, record) => n + record.rules.length, 0),
      facts: records.reduce((n, record) => n + record.facts.length, 0),
      missingCategories: context['missingCategories'], retrieval: context['retrieval'],
      publicQueryAndEvidenceMs: Math.round(performance.now() - started) });
  }
  Object.assign(report, { authenticatedHttps: true, unauthenticatedRejected: true, sourceToolsUnavailable: true,
    rawResourcesUnavailable: true, ready: results, pending: repos.filter((entry) => entry.status !== 'ready').map((entry) => entry.repo),
    noGeneratedAnalyses: repos.filter((entry) => entry.status === 'ready' && entry.analyses === 0).map((entry) => entry.repo),
    limitation: 'Verifies public retrieval and isolation, not semantic correctness, PRD quality or Cowork installation.' });
  writeFileSync('.repolead/product-demo/verification.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ readyRepositoriesTested: results.length,
    analysesAvailable: results.reduce((n, row) => n + Number(row['analyses']), 0),
    unauthenticatedRejected: true, sourceToolsUnavailable: true,
    report: '.repolead/product-demo/verification.json' }, null, 2));
} finally { await client.close(); }
