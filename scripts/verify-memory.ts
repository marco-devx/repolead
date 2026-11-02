import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { refreshRepository, scanRepository } from '@repolead/code-graph';
import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { analyzeProductContext, analyzeSnapshot } from '@repolead/lead-analyzer';
import type { HierarchicalPack, TechLeadModel } from '@repolead/lead-analyzer';
import { parsePolicy, runPolicies } from '@repolead/policy-engine';

// This verifies integration/caching, not the factual quality or billing of a real model.
class ContractModel implements TechLeadModel {
  name = 'acceptance-contract-model-v1';
  calls = 0;
  complete(request: { prompt: string; schema: Record<string, unknown> }): ReturnType<TechLeadModel['complete']> {
    this.calls += 1;
    const pack = JSON.parse(request.prompt.split('Evidence pack:\n')[1]!.split('\n\nReturn ')[0]!) as HierarchicalPack;
    const empty = (schema: Record<string, unknown>): unknown => {
      if (schema['type'] === 'array') { return []; }
      if (schema['type'] === 'object') {
        return Object.fromEntries(Object.entries(schema['properties'] as Record<string, Record<string, unknown>>)
          .map(([key, value]) => [key, empty(value)]));
      }
      return 'Contract fixture: semantic quality not evaluated';
    };
    const json = empty(request.schema) as Record<string, unknown>;
    json['evidenceIds'] = pack.evidence.map((entry) => entry.id);
    return Promise.resolve({ json, inputTokens: 0, outputTokens: 0 });
  }
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'repolead-memory-acceptance-'));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
const init = (root: string) => {
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'RepoLead acceptance');
  git(root, 'config', 'user.email', 'acceptance@example.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Acceptance fixture');
};

try {
  const root = join(tempRoot, 'memory');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'package.json'), '{"name":"acceptance"}');
  writeFileSync(join(root, 'src/invoice.ts'), 'export function invoice(amount: number) { return amount * 1.18; }\n');
  writeFileSync(join(root, 'src/view.jsx'), 'export const View = () => <div>Invoice</div>;\n');
  writeFileSync(join(root, 'docs/product.md'), '# Invoice product\nA customer requests an invoice.\n[Calculation](../src/invoice.ts#L1)\n');
  writeFileSync(join(root, '.gitignore'), '.repolead/\n');
  init(root);
  const scanned = await scanRepository({ rootPath: root, repositoryName: 'Invoices / Perú', scip: false });
  const store = await openStore(scanned.dbPath);
  const model = new ContractModel();
  let firstCalls = 0;
  let summaryCount = 0;
  let judgeCalls = 0;
  let cachedJudgments = 0;
  try {
    const options = { store, snapshotId: scanned.snapshotId, model, budget: { maxTokens: 4000 } };
    await analyzeSnapshot(options);
    await analyzeProductContext(options);
    firstCalls = model.calls;
    await analyzeSnapshot(options);
    await analyzeProductContext(options);
    assert.equal(model.calls, firstCalls, 'Repeated analysis must make zero additional calls');
    const levels = new Set(store.listSummaries(scanned.snapshotId).map((summary) => summary.level));
    assert.deepEqual([...levels].sort(), ['document', 'file', 'module', 'product', 'repository', 'symbol']);
    summaryCount = store.listSummaries(scanned.snapshotId).length;
    const judge: TechLeadModel = { name: 'contract-judge', complete: async () => {
      judgeCalls += 1;
      return { json: { verdicts: [{ index: 0, confirmed: true, confidence: 0.8, reasoning: 'Contract fixture only' }] }, inputTokens: 0, outputTokens: 0 };
    } };
    const policy = parsePolicy('id: ACCEPTANCE-TEST-LINKS\nversion: 1\nseverity: medium\nrequired_evidence: [location, test_links]\ncandidate_detectors:\n  - name: untested_module\n    params:\n      minSymbols: 1\n', 'acceptance.yaml');
    const auditOptions = { store, snapshotId: scanned.snapshotId, policies: [policy], model: judge };
    const firstAudit = await runPolicies(auditOptions);
    const secondAudit = await runPolicies(auditOptions);
    assert.equal(judgeCalls, 1);
    assert.equal(secondAudit.cachedJudgments, 1);
    assert.equal(secondAudit.confirmed[0]?.id, firstAudit.confirmed[0]?.id);
    assert.equal(store.getFindings(scanned.snapshotId, 'confirmed').length, 1);
    assert.equal((store.db.prepare('SELECT policy_version FROM finding_judgments').get() as { policy_version: string }).policy_version, '1');
    cachedJudgments = secondAudit.cachedJudgments;
  } finally { store.close(); }

  const cli = join(projectRoot, 'apps/cli/dist/index.cjs');
  const brief = JSON.parse(execFileSync(process.execPath, [cli, 'brief', '--db', scanned.dbPath, '--product', '--json'], { cwd: root, encoding: 'utf8' })) as { evidenceIds: string[] };
  assert.ok(brief.evidenceIds.length);
  const client = new Client({ name: 'repolead-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [cli, 'serve', '--db', scanned.dbPath, '--no-source'], cwd: root, stderr: 'pipe' });
  const serverErrors: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => serverErrors.push(chunk.toString()));
  let resourcesRead = 0;
  try {
    await client.connect(transport);
    const resources = (await client.listResources()).resources;
    assert.equal(resources.length, summaryCount);
    for (const resource of resources) {
      const response = await client.readResource({ uri: resource.uri });
      const content = JSON.parse((response.contents[0] as { text: string }).text) as { snapshotId: string; evidence: unknown[] };
      assert.equal(content.snapshotId, scanned.snapshotId);
      assert.ok(content.evidence.length);
      resourcesRead += 1;
    }
    const overview = await client.callTool({ name: 'repo_overview', arguments: { audience: 'product' } });
    const payload = JSON.parse((overview.content as { text: string }[])[0]!.text) as { audience: string; resource: string };
    assert.equal(payload.audience, 'product');
    assert.ok(payload.resource.includes('/product/'));
    const source = await client.callTool({ name: 'get_evidence', arguments: { path: 'src/invoice.ts', startLine: 1, endLine: 1 } });
    const sourceText = JSON.stringify(source);
    assert.ok(!sourceText.includes('return amount * 1.18'));
    writeFileSync(join(root, 'src/invoice.ts'), 'export function invoice(amount: number) { return amount * 1.20; }\n');
    const refreshed = await refreshRepository({ rootPath: root, scip: false });
    assert.deepEqual(refreshed.scan?.parsing, { parsedFiles: 1, reusedFiles: 1 });
    assert.equal((await client.listResources()).resources.length, 0, 'Resources must never return a previous snapshot dossier');
    assert.equal((await refreshRepository({ rootPath: root, scip: false })).upToDate, true);
  } catch (error) { throw new Error(`${String(error)}\nMCP stderr: ${serverErrors.join('')}`, { cause: error }); }
  finally { await client.close(); }

  const large = join(tempRoot, 'performance');
  mkdirSync(join(large, 'src'), { recursive: true });
  writeFileSync(join(large, 'package.json'), '{"name":"performance"}');
  writeFileSync(join(large, '.gitignore'), '.repolead/\n');
  for (let index = 0; index < 1000; index += 1) {
    writeFileSync(join(large, 'src', `file-${index}.ts`), `export function value${index}(input: number): number { return input + ${index}; }\n`);
  }
  init(large);
  const baseline = await scanRepository({ rootPath: large, scip: false });
  assert.equal(baseline.counts.files, 1002);
  assert.equal(baseline.counts.symbols, 1000);
  assert.ok(baseline.durationMs < 600000);
  writeFileSync(join(large, 'src/file-0.ts'), 'export function value0(input: number): number { return input * 2; }\n');
  const refresh = await refreshRepository({ rootPath: large, scip: false });
  assert.deepEqual(refresh.scan?.parsing, { parsedFiles: 1, reusedFiles: 999 });
  assert.ok(refresh.durationMs < 30000);
  const report = {
    generatedAt: new Date().toISOString(), runtime: { bun: process.versions.bun, platform: process.platform },
    fixture: 'Synthetic TS/JSX + linked product documentation; separate 1000-function performance repository',
    generation: { model: model.name, firstCalls, repeatedCalls: model.calls - firstCalls, summaries: summaryCount },
    audit: { judgeCalls, cachedJudgments, duplicateFindings: 0, realModel: false },
    mcp: { transport: 'real stdio subprocess using compiled CLI', resourcesRead, audiences: ['technical', 'product'], sourceDisabled: true, freshnessVerified: true },
    performance: { files: baseline.counts.files, symbols: baseline.counts.symbols, scanMs: baseline.durationMs,
      refreshMs: refresh.durationMs, ...refresh.scan!.parsing, scip: false },
    limitations: ['No real generative model, semantic-answer evaluation or provider billing measured.',
      'No TEI/Qdrant calls; semantic retrieval acceptance is separate.', 'Synthetic performance fixture; SCIP disabled.'],
    scriptHash: contentHash(readFileSync(fileURLToPath(import.meta.url))),
  };
  const reportPath = join(projectRoot, 'benchmarks/memory-acceptance.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { rmSync(tempRoot, { recursive: true, force: true }); }
