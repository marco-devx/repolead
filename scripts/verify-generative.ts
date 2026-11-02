import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { scanRepository, refreshRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';
import { AgentSdkTechLeadModel, OllamaTechLeadModel, analyzeSnapshot, analyzeProductContext } from '@repolead/lead-analyzer';
import type { TechLeadModel } from '@repolead/lead-analyzer';

if (!process.argv.includes('--real')) { throw new Error('Pass --real to run authenticated Claude Code and local Qwen generation.'); }
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resumed = Boolean(process.env['REPOLEAD_ACCEPTANCE_ROOT']);
const root = process.env['REPOLEAD_ACCEPTANCE_ROOT'] ?? mkdtempSync(join(tmpdir(), 'repolead-generative-'));
if (resumed) { assert.ok(basename(root).startsWith('repolead-generative-') && JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'invoice-acceptance', 'Resume only this acceptance fixture.'); }
const sources: Record<string, string> = {
  'src/domain/price.ts': 'export function price(amount: number) {\n  if (amount < 0) throw new RangeError("negative amount");\n  return amount * 1.18;\n}\n',
  'src/app/invoice.ts': 'import { price } from "../domain/price";\nexport function invoice(amount: number) { return { total: price(amount), currency: "PEN" }; }\n',
  'src/unrelated/format.ts': 'export function format(value: number) { return String(value); }\n',
  'docs/product.md': '# Invoice calculator\nA merchant enters an amount and receives an invoice total in PEN with an 18% surcharge. Negative amounts are rejected.\n[Calculation](../src/domain/price.ts#L1)\n[Invoice](../src/app/invoice.ts#L2)\nPDF export is planned, not implemented in this version.\n',
  'package.json': '{"name":"invoice-acceptance"}\n',
  'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"ES2022","module":"ESNext","moduleResolution":"Bundler"},"include":["src"]}\n',
  '.gitignore': '.repolead/\n',
  '.repolead.yaml': 'version: 1\nmodules:\n  - {name: pricing, path: src/domain}\n  - {name: application, path: src/app, critical: true}\n  - {name: formatting, path: src/unrelated}\nsymbol_selection: public-or-nontrivial\n',
};
for (const [path, source] of Object.entries(sources)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); }
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
if (!resumed) { git('init', '-b', 'main'); git('config', 'user.name', 'Acceptance'); git('config', 'user.email', 'acceptance@example.invalid'); git('add', '.'); git('commit', '-m', 'Known product behavior'); }
const scan = await scanRepository({ rootPath: root, scip: true });
const store = await openStore(scan.dbPath);
const calls: { phase: string; backend: string; subject: string; inputTokens: number; outputTokens: number; durationMs: number; telemetry: unknown }[] = [];
let phase = 'initial';
if (resumed) {
  const previous = [join(root, '.repolead', 'measured-calls.json'), join(root, 'measured-calls.json')].find((path) => existsSync(path));
  if (previous) { calls.push(...JSON.parse(readFileSync(previous, 'utf8'))); }
  assert.ok(calls.every((call) => call.phase === 'initial'), 'Only initial-phase retries are resumable; use a fresh fixture to measure a new changed-phase run.');
}
function measure(actual: TechLeadModel): TechLeadModel {
  return { name: actual.name, complete: async (request) => {
    if (calls.length >= 70) { throw new Error('Acceptance call ceiling'); }
    const pack = JSON.parse(request.prompt.split('Evidence pack:\n')[1]!.split('\n\nReturn ')[0]!);
    console.log(`${phase} ${actual.name.startsWith('ollama') ? 'local' : 'primary'} ${pack.subject.level}: ${pack.subject.name}`);
    const start = Date.now(); const result = await actual.complete(request);
    writeFileSync(join(root, '.repolead', `completion-${calls.length}.json`), JSON.stringify({ subject: pack.subject, json: result.json, inputTokens: result.inputTokens, outputTokens: result.outputTokens, telemetry: result.telemetry }, null, 2));
    calls.push({ phase, backend: actual.name, subject: pack.subject.id, inputTokens: result.inputTokens,
      outputTokens: result.outputTokens, durationMs: Date.now() - start, telemetry: result.telemetry });
    writeFileSync(join(root, '.repolead', 'measured-calls.json'), JSON.stringify(calls, null, 2));
    console.log(`completed ${pack.subject.name}: ${result.inputTokens} in / ${result.outputTokens} out · ${Date.now() - start} ms`);
    return result;
  } };
}
try {
  const local = await OllamaTechLeadModel.connect();
  const model = measure(new AgentSdkTechLeadModel(process.env['REPOLEAD_ACCEPTANCE_MODEL'])); const leafModel = measure(local);
  const options = { store, snapshotId: scan.snapshotId, model, leafModel, criticalModulePaths: ['src/app'],
    symbolSelection: 'public-or-nontrivial' as const, budget: { maxTokens: 6000, maxReanalysisDepth: 3 } };
  const initialStart = Date.now(); const initial = await analyzeSnapshot(options); const product = await analyzeProductContext(options);
  const initialDurationMs = Date.now() - initialStart;
  const summaries = store.listSummaries(scan.snapshotId).map((entry) => ({ level: entry.level, subjectId: entry.subjectId, model: entry.model, content: JSON.parse(entry.contentJson) }));
  const symbols = store.listSymbols(scan.snapshotId);
  const price = symbols.find((symbol) => symbol.qualifiedName === 'price')!;
  const format = symbols.find((symbol) => symbol.qualifiedName === 'format')!;
  const invoice = symbols.find((symbol) => symbol.qualifiedName === 'invoice')!;
  const card = store.getSummary(scan.snapshotId, price.id, 'symbol')!;
  assert.ok(!card.model.startsWith('ollama:')); assert.ok(store.getSummary(scan.snapshotId, format.id, 'symbol')!.model.startsWith('ollama:')); assert.ok(!store.getSummary(scan.snapshotId, invoice.id, 'symbol')!.model.startsWith('ollama:'));
  assert.match(card.contentJson, /1\.18|18\s*%/); assert.match(card.contentJson, /negative|negativ/i); assert.match(card.contentJson, /RangeError/);
  const literalClaims = JSON.parse(card.contentJson) as { unknowns: string[] };
  const { unknowns: _unknowns, ...affirmations } = literalClaims;
  assert.ok(!/\btax\b|\bimpuesto\b/i.test(JSON.stringify(affirmations)), 'Affirmations must not invent tax semantics; explicitly unknown meaning is allowed.');
  assert.ok(!(JSON.parse(card.contentJson).dependencies as string[]).some((value) => /invoice/.test(value)), 'Incoming consumer must not become a dependency.');
  const productSummary = summaries.find((entry) => entry.level === 'product')!;
  assert.match(JSON.stringify(productSummary.content), /PEN/);
  const claims = Object.values(productSummary.content).flat().filter((item: unknown) => item && typeof item === 'object' && 'basis' in item) as { claim: string; basis: string }[];
  assert.ok(!claims.some((claim) => /PDF/i.test(claim.claim) && claim.basis === 'implemented'), 'Planned PDF export must not be promoted to implemented.');
  const firstCalls = calls.length; phase = 'repeat'; await analyzeSnapshot(options); await analyzeProductContext(options);
  assert.equal(calls.length, firstCalls);
  phase = 'changed'; writeFileSync(join(root, price.path), sources[price.path]!.replace('1.18', '1.20'));
  const refreshStart = Date.now(); const refreshed = await refreshRepository({ rootPath: root, scip: true }); const refreshDurationMs = Date.now() - refreshStart;
  const snapshot = store.getLatestSnapshot()!;
  const changedStart = Date.now(); const changed = await analyzeSnapshot({ ...options, snapshotId: snapshot.id });
  await analyzeProductContext({ ...options, snapshotId: snapshot.id }); const changedDurationMs = Date.now() - changedStart;
  assert.ok(!calls.filter((call) => call.phase === 'changed').some((call) => call.subject === format.id));
  assert.match(store.getSummary(snapshot.id, price.id, 'symbol')!.contentJson, /1\.2(?:0)?|20\s*%/);
  assert.equal(refreshed.scan?.parsing.parsedFiles, 1);
  const changedSummaries = store.listSummaries(snapshot.id).map((entry) => ({ level: entry.level, subjectId: entry.subjectId, model: entry.model, content: JSON.parse(entry.contentJson) }));
  const updatedProduct = changedSummaries.find((entry) => entry.level === 'product')!;
  assert.match(JSON.stringify(updatedProduct.content), /1\.2(?:0)?|20\s*%/);
  assert.match(JSON.stringify(updatedProduct.content), /1\.18|18\s*%/);
  assert.ok((updatedProduct.content.unknowns as string[]).some((entry) => /discrepanc|conflict|contradic/i.test(entry)));
  const report = { generatedAt: new Date().toISOString(), resumed, fixtureRoot: root, dbPath: scan.dbPath, sources,
    modelDigest: local.digest, initial, product, changed, initialDurationMs, refreshDurationMs, changedDurationMs,
    calls, summaries, changedSummaries, newCallsOnRepeat: 0, checks: ['Exact Qwen weights recorded', 'Critical symbol, arithmetic/branching logic and all upper levels use primary; scalar conversion uses local',
      'Price card preserves multiplier, rejection and error type', 'Product preserves currency and planned PDF status',
      'All persisted outputs pass schema and evidence validation', 'Unchanged repeat zero calls', 'One body edit reparses one file and reuses unrelated symbol', 'Updated product preserves both conflicting multipliers and flags the discrepancy'],
    limits: ['Single authored fixture, not general semantic accuracy. If resumed, initial wall duration is the successful process only; failed calls without provider usage are not included in preparation totals.', 'SDK totals include cached input and harness overhead; local tokens are not remote billing.',
      'The documented 18% rule intentionally disagrees with the refreshed 20% code; inspect product uncertainty before use.'], passed: true };
  writeFileSync(join(projectRoot, 'benchmarks/generative-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, calls: calls.length, firstCalls, root, dbPath: scan.dbPath, initialDurationMs, refreshDurationMs, changedDurationMs }));
} finally {
  writeFileSync(join(root, '.repolead', 'measured-calls.json'), JSON.stringify(calls, null, 2));
  store.close();
  console.log(`Preserved acceptance fixture: ${root}`);
}
