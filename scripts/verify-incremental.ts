import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { refreshRepository, scanRepository } from '@repolead/code-graph';
import { analysisBudget, loadConfig } from '@repolead/config';
import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { analyzeProductContext, analyzeSnapshot } from '@repolead/lead-analyzer';
import { ContractModel } from '../packages/lead-analyzer/test-support/contract-model';
import { createChainFixture } from '../packages/lead-analyzer/test-support/chain-fixture';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { root, git } = createChainFixture();
try {
  const first = await scanRepository({ rootPath: root, repositoryName: 'Incremental acceptance' });
  assert.ok(first.referencesResolved && first.referencesResolved > 0, 'Acceptance requires actual SCIP references');
  const store = await openStore(first.dbPath);
  const model = new ContractModel();
  const budget = analysisBudget(loadConfig(root).config);
  const cli = join(project, 'apps/cli/dist/index.cjs');
  const preview = execFileSync(process.execPath, [cli, 'analyze', '--db', first.dbPath, '--dry-run'], { encoding: 'utf8' });
  assert.ok(preview.includes('hasta 1 saltos'));
  const analyze = async (snapshotId: string) => {
    const start = Date.now();
    const before = model.packs.length;
    const options = { store, snapshotId, model, budget };
    const technical = await analyzeSnapshot(options);
    const product = await analyzeProductContext(options);
    const packs = model.packs.slice(before);
    return { durationMs: Date.now() - start, calls: packs.length, technical, product,
      subjects: packs.map((pack) => ({ level: pack.subject.level, name: pack.subject.name })) };
  };
  try {
    const baseline = await analyze(first.snapshotId);
    const repeat = await analyze(first.snapshotId);
    assert.equal(repeat.calls, 0);
    const preservedPaths = ['src/consumer/checkout.ts', 'src/unrelated/format.ts', 'config/runtime.json', 'src/public/index.ts'];
    const before = new Map(store.listSummaries(first.snapshotId).map((summary) => [`${summary.level}:${summary.subjectId}`, summary]));
    const changedPath = join(root, 'src/leaf/price.ts');
    writeFileSync(changedPath, readFileSync(changedPath, 'utf8').replace('* 2', '* 3'));
    const refresh = await refreshRepository({ rootPath: root });
    assert.equal(refresh.scan!.parsing.parsedFiles, 1);
    assert.equal(refresh.scan!.parsing.reusedFiles, 5);
    const incremental = await analyze(refresh.scan!.snapshotId);
    assert.deepEqual(incremental.subjects.filter((entry) => entry.level === 'symbol').map((entry) => entry.name).sort(), ['invoice', 'price']);
    assert.deepEqual(incremental.subjects.filter((entry) => entry.level === 'file').map((entry) => entry.name).sort(), ['src/leaf/price.ts', 'src/wrapper/invoice.ts']);
    assert.deepEqual(incremental.subjects.filter((entry) => entry.level === 'module').map((entry) => entry.name).sort(), ['leaf', 'wrapper']);
    assert.ok(incremental.subjects.some((entry) => entry.name === 'docs/invoices.md'));
    assert.ok(!incremental.subjects.some((entry) => entry.name.startsWith('docs/invoices.md:') || entry.name === 'docs/support.md'));
    const after = store.listSummaries(refresh.scan!.snapshotId);
    for (const path of preservedPaths) {
      const file = after.find((summary) => summary.level === 'file' && summary.subjectId.endsWith(`/${path}`))!;
      assert.ok(file);
      const previous = before.get(`file:${file.subjectId}`)!;
      assert.equal(file.contentHash, previous.contentHash);
      assert.equal(file.contentJson, previous.contentJson);
    }
    const repeatIncremental = await analyze(refresh.scan!.snapshotId);
    assert.equal(repeatIncremental.calls, 0);
    assert.ok(refresh.durationMs + incremental.durationMs < 30000);

    const client = new Client({ name: 'incremental-acceptance', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--db', first.dbPath, '--no-source'], stderr: 'pipe' });
    let resourcesRead = 0;
    try {
      await client.connect(transport);
      for (const resource of (await client.listResources()).resources) {
        const result = await client.readResource({ uri: resource.uri });
        const payload = JSON.parse((result.contents[0] as { text: string }).text) as { snapshotId: string };
        assert.equal(payload.snapshotId, refresh.scan!.snapshotId); resourcesRead += 1;
      }
      const oldPrice = store.listSymbols(refresh.scan!.snapshotId).find((symbol) => symbol.qualifiedName === 'price')!;
      git('mv', 'src/leaf/price.ts', 'src/leaf/pricing.ts');
      const rename = await refreshRepository({ rootPath: root });
      assert.ok(rename.removedSymbolIds.includes(oldPrice.id));
      assert.equal((await client.listResources()).resources.length, 0, 'No old dossier may leak into an unanalyzed snapshot');
      const renamed = await analyze(rename.scan!.snapshotId);
      assert.equal(store.getSummary(rename.scan!.snapshotId, oldPrice.id, 'symbol'), null);
      assert.equal((await analyze(rename.scan!.snapshotId)).calls, 0);
      const report = { generatedAt: new Date().toISOString(), scriptHash: contentHash(readFileSync(fileURLToPath(import.meta.url))),
        runtime: { bun: process.versions.bun }, model: model.name, maxReanalysisDepth: budget.maxReanalysisDepth,
        fixture: 'Compiler-resolved price → invoice → checkout chain, unrelated symbols, barrel, startup code, JSON config and two product documents',
        baseline, repeat, incremental, repeatIncremental,
        refresh: { durationMs: refresh.durationMs, parsing: refresh.scan!.parsing, changedSymbols: refresh.changedSymbolIds.length,
          affectedModules: refresh.affectedModules, scip: true },
        preservation: { unchangedFiles: preservedPaths, exactDossierContentPreserved: true, renamedSymbolRemoved: true, renameCalls: renamed.calls },
        mcp: { compiledStdio: true, noSource: true, resourcesRead, noStaleResources: true },
        compiledDryRun: true,
        limits: ['Contract model records real orchestration calls but does not evaluate semantic quality, real generation latency or provider tokens.',
          'The body edit preserves source lines; line-location-only cache rebinding is not implemented and relocated evidence may cause additional analysis calls.',
          'Depth is a directed dependency boundary; a lower value deliberately excludes farther body changes. Synthesis ancestors always follow their children.',
          'Selective vector update and physical purge have a separate real-services retrieval acceptance report.'] };
      writeFileSync(join(project, 'benchmarks/incremental-acceptance.json'), `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify({ initialCalls: baseline.calls, incrementalCalls: incremental.calls, repeatedCalls: repeatIncremental.calls,
        parsedFiles: refresh.scan!.parsing.parsedFiles, cachedFiles: refresh.scan!.parsing.reusedFiles,
        analyzed: incremental.subjects, report: 'benchmarks/incremental-acceptance.json' }, null, 2));
    } finally { await client.close(); }
  } finally { store.close(); }
} finally { rmSync(root, { recursive: true, force: true }); }
