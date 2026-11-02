import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';
import { AgentSdkTechLeadModel, analyzeSubject, BatchedTechLeadModel, buildDependencyIndex, buildSymbolPack,
  forAnalysisBatches, listSourceFiles, summarySchema } from '@repolead/lead-analyzer';
import type { TechLeadModel } from '@repolead/lead-analyzer';
import { modelEvidence } from '../packages/lead-analyzer/src/model-evidence';
import { countTokens } from '@repolead/retrieval';

if (!process.argv.includes('--real')) { throw new Error('Pass --real to measure actual model calls.'); }
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = join(project, '.repolead', 'acceptance'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'analysis-batch-'));
const sources = {
  'scale.ts': 'export function scale(amount: number, rate: number) {\n  if (amount < 0) throw new RangeError("negative amount");\n  return amount * (1 + rate);\n}\n',
  'canEdit.ts': 'export function canEdit(role: string, enabled: boolean) {\n  if (!enabled) return false;\n  return role === "editor";\n}\n',
  'normalize.ts': 'export function normalize(value: string) {\n  return value.trim().toLowerCase();\n}\n',
  'parsePort.ts': 'export function parsePort(text: string) {\n  const value = Number(text);\n  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new RangeError("port");\n  return value;\n}\n',
};
for (const [path, source] of Object.entries(sources)) { writeFileSync(join(root, path), source); }
writeFileSync(join(root, '.gitignore'), '.repolead/\n');
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
git('init', '-b', 'main'); git('config', 'user.name', 'Acceptance'); git('config', 'user.email', 'acceptance@example.invalid');
git('add', '.'); git('commit', '-m', 'Independent behavioral contracts');
const scan = await scanRepository({ rootPath: root, scip: false });
const store = await openStore(scan.dbPath);
const graph = store.loadGraph(scan.snapshotId); const dependencies = buildDependencyIndex(store, scan.snapshotId, graph, listSourceFiles(store, scan.snapshotId));
const packed = store.listSymbols(scan.snapshotId).filter((symbol) => symbol.kind === 'function').map((symbol) => buildSymbolPack(store, scan.snapshotId, root, symbol, 4000, 1200, graph, dependencies));
assert.equal(packed.length, 4);
assert.ok(packed.every((input) => input.pack.truncation.omittedSourceLines === 0));
const actual = new AgentSdkTechLeadModel(process.env['REPOLEAD_ACCEPTANCE_MODEL'] ?? 'haiku');
const calls: { arm: string; inputTokens: number; outputTokens: number; telemetry: unknown }[] = [];
const results: Record<string, unknown> = {};
try {
  for (const size of [1, 4]) {
    const arm = size === 1 ? 'individual' : 'batch';
    const measured: TechLeadModel = { name: actual.name, complete: async (request) => {
      console.log(`${arm}: provider request`);
      const result = await actual.complete(request);
      calls.push({ arm, inputTokens: result.inputTokens, outputTokens: result.outputTokens, telemetry: result.telemetry });
      writeFileSync(join(root, `provider-${calls.length}.json`), JSON.stringify(result, null, 2));
      writeFileSync(join(root, 'calls.json'), JSON.stringify(calls, null, 2));
      return result;
    } };
    const model = size === 1 ? measured : new BatchedTechLeadModel(measured, size);
    const cards: Record<string, unknown> = {}; let inputTokens = 0; let outputTokens = 0;
    const run = async (input: typeof packed[number]) => {
      const result = await analyzeSubject({ store, snapshotId: scan.snapshotId, model }, input.pack, input.evidence, input.cacheBinding);
      cards[input.pack.subject.name] = JSON.parse(result.summary.contentJson);
      inputTokens += result.inputTokens; outputTokens += result.outputTokens;
    };
    await forAnalysisBatches(packed, size, run);
    const before = calls.length;
    await forAnalysisBatches(packed, size, run);
    assert.equal(calls.length, before, 'Repeated analysis must reuse every individual cached card.');
    const checks = {
      scale: /1\s*\+\s*rate|one plus.{0,15}rate/i.test(JSON.stringify(cards['scale'])) && /negative|<\s*0/i.test(JSON.stringify(cards['scale'])) && /RangeError/.test(JSON.stringify(cards['scale'])),
      editor: /editor/.test(JSON.stringify(cards['canEdit'])) && /disabled|false|!enabled|not enabled/i.test(JSON.stringify(cards['canEdit'])),
      normalization: /trim/i.test(JSON.stringify(cards['normalize'])) && /lowercase|lower.case|toLowerCase/i.test(JSON.stringify(cards['normalize'])),
      port: /65535/.test(JSON.stringify(cards['parsePort'])) && /integer/i.test(JSON.stringify(cards['parsePort'])) && /RangeError/.test(JSON.stringify(cards['parsePort'])),
    };
    const provider = calls.filter((call) => call.arm === arm);
    assert.equal(inputTokens, provider.reduce((sum, call) => sum + call.inputTokens, 0));
    assert.equal(outputTokens, provider.reduce((sum, call) => sum + call.outputTokens, 0));
    results[arm] = { inputTokens, outputTokens, calls: provider.length, newCallsOnRepeat: 0, checks, cards };
    writeFileSync(join(root, `${arm}.json`), JSON.stringify(results[arm], null, 2));
  }
  const single = results['individual'] as { inputTokens: number; outputTokens: number; checks: Record<string, boolean> };
  const batch = results['batch'] as typeof single;
  const report = { generatedAt: new Date().toISOString(), root, dbPath: scan.dbPath, sources, model: actual.name,
    preparationScope: 'Four complete independent symbol cards, same snapshot and underlying model; no generated parent dossiers in this comparison.',
    transport: packed.map(({ pack }) => ({ name: pack.subject.name, storedTokens: countTokens(JSON.stringify(pack)),
      modelTokens: countTokens(JSON.stringify(modelEvidence(pack, summarySchema('symbol')).pack)) })),
    results, calls, reductionPercent: (1 - (batch.inputTokens + batch.outputTokens) / (single.inputTokens + single.outputTokens)) * 100,
    passed: [...Object.values(single.checks), ...Object.values(batch.checks)].every(Boolean),
    limits: ['Finite fixtures; not proof of arbitrary batch semantic quality.', 'SDK totals include cache, auxiliary work and formatting retries, not invoices.',
      'This measures preparation, not the roadmap MCP architectural-query target. Per-card usage inside a batch is allocated by a tokenizer proxy; batch/provider totals match exactly.'] };
  writeFileSync(join(project, 'benchmarks/analysis-batching-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, reductionPercent: report.reductionPercent, results: Object.fromEntries(Object.entries(results).map(([key, value]) => {
    const { cards: _cards, ...counts } = value as Record<string, unknown>; return [key, counts];
  })) }));
  assert.ok(report.passed, 'Both modes must preserve the behavioral checks.');
} finally { store.close(); }
