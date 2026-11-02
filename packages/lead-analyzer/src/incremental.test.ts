import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';
import { refreshRepository, scanRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';

import { analyzeSnapshot } from './analyze';
import { analyzeProductContext } from './product';
import { buildDependencyIndex } from './dependencies';
import { listSourceFiles } from './hierarchy';
import { ContractModel } from '../test-support/contract-model';
import { createChainFixture } from '../test-support/chain-fixture';

test('moving unchanged source rebinds cached symbol evidence without generative leaf calls or rewriting historical coordinates', async () => {
  const { root } = createChainFixture();
  try {
    const first = await scanRepository({ rootPath: root }); const store = await openStore(first.dbPath);
    try {
      const model = new ContractModel('coordinate-cache-contract');
      await analyzeSnapshot({ store, snapshotId: first.snapshotId, model, budget: { maxTokens: 6000 } });
      const price = store.listSymbols(first.snapshotId).find((symbol) => symbol.qualifiedName === 'price')!;
      const old = store.getSummary(first.snapshotId, price.id, 'symbol')!;
      const oldSource = store.getSummaryEvidence(old.id).find((entry) => entry.kind === 'source')!;
      const path = join(root, price.path); const original = readFileSync(path, 'utf8');
      writeFileSync(path, '\n\n\n' + original);
      const refreshed = await refreshRepository({ rootPath: root });
      model.packs.length = 0;
      const result = await analyzeSnapshot({ store, snapshotId: refreshed.scan!.snapshotId, model, budget: { maxTokens: 6000 } });
      expect(result.symbolsAnalyzed).toBe(0); expect(result.symbolsCached).toBeGreaterThan(0);
      expect(model.packs.filter((pack) => pack.subject.level === 'symbol')).toHaveLength(0);
      const moved = store.getSummary(refreshed.scan!.snapshotId, price.id, 'symbol')!;
      const newSource = store.getSummaryEvidence(moved.id).find((entry) => entry.kind === 'source')!;
      expect(newSource.startLine).toBe(oldSource.startLine! + 3);
      expect(newSource.id).not.toBe(oldSource.id);
      expect(moved.contentJson).toContain(newSource.id); expect(moved.contentJson).not.toContain(oldSource.id);
      expect(store.getSummaryEvidence(old.id).find((entry) => entry.id === oldSource.id)!.startLine).toBe(oldSource.startLine);
      const calls = model.packs.length;
      await analyzeSnapshot({ store, snapshotId: refreshed.scan!.snapshotId, model, budget: { maxTokens: 6000 } });
      expect(model.packs).toHaveLength(calls);
      // Prose that quotes absolute coordinates must be regenerated, not merely rebound.
      const located = JSON.parse(moved.contentJson) as { purpose: string };
      located.purpose = 'See lines 4 and 5 for behavior.';
      store.db.prepare('UPDATE summaries SET content_json = ? WHERE id = ?').run(JSON.stringify(located), moved.id);
      writeFileSync(path, '\n\n\n\n' + original);
      const relocatedAgain = await refreshRepository({ rootPath: root }); model.packs.length = 0;
      await analyzeSnapshot({ store, snapshotId: relocatedAgain.scan!.snapshotId, model, budget: { maxTokens: 6000 } });
      expect(model.packs.some((pack) => pack.subject.level === 'symbol' && pack.subject.name === 'price')).toBe(true);
      writeFileSync(path, '\n\n\n' + original.replace('* 2', '* 3'));
      const edited = await refreshRepository({ rootPath: root }); model.packs.length = 0;
      await analyzeSnapshot({ store, snapshotId: edited.scan!.snapshotId, model, budget: { maxTokens: 6000 } });
      expect(model.packs.some((pack) => pack.subject.level === 'symbol' && pack.subject.name === 'price')).toBe(true);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120000);

test('dependency depth controls selective reanalysis, preserves other dossiers and updates linked product context', async () => {
  const { root } = createChainFixture();
  try {
    const first = await scanRepository({ rootPath: root });
    const store = await openStore(first.dbPath);
    try {
      const cases = [0, 1, 2].map((depth) => ({ depth, model: new ContractModel(`contract-depth-${depth}`) }));
      for (const { depth, model } of cases) {
        const options = { store, snapshotId: first.snapshotId, model, budget: { maxTokens: 6000, maxReanalysisDepth: depth } };
        await analyzeSnapshot(options); await analyzeProductContext(options);
        const files = model.packs.filter((pack) => pack.subject.level === 'file');
        const byName = new Map(files.map((pack) => [pack.subject.name, pack]));
        expect(JSON.stringify(byName.get('src/public/index.ts'))).toContain('export { checkout }');
        expect(JSON.stringify(byName.get('src/start.ts'))).toContain('console.log(checkout(10))');
        expect(JSON.stringify(byName.get('config/runtime.json'))).toContain('retryLimit');
        expect(byName.get('src/leaf/price.ts')?.evidence.filter((entry) => entry.kind === 'source')
          .some((entry) => JSON.stringify(entry.facts).includes('return value * 2'))).toBe(false);
        const count = model.packs.length;
        await analyzeSnapshot(options); await analyzeProductContext(options);
        expect(model.packs).toHaveLength(count);
        model.packs.length = 0;
      }
      const path = join(root, 'src/leaf/price.ts');
      writeFileSync(path, readFileSync(path, 'utf8').replace('* 2', '* 3'));
      const refreshed = await refreshRepository({ rootPath: root });
      expect(refreshed.changedFiles).toEqual(['src/leaf/price.ts']);
      expect(refreshed.scan?.parsing).toEqual({ parsedFiles: 1, reusedFiles: 5 });
      expect(refreshed.affectedModules).toEqual(['leaf', 'wrapper']);
      for (const { depth, model } of cases) {
        const options = { store, snapshotId: refreshed.scan!.snapshotId, model, budget: { maxTokens: 6000, maxReanalysisDepth: depth } };
        await analyzeSnapshot(options); await analyzeProductContext(options);
        const analyzed = model.packs.filter((pack) => pack.subject.level === 'symbol').map((pack) => pack.subject.name).sort();
        expect(analyzed).toEqual(depth === 0 ? ['price'] : depth === 1 ? ['invoice', 'price'] : ['checkout', 'invoice', 'price']);
        expect(model.packs.filter((pack) => pack.subject.level === 'file').map((pack) => pack.subject.name).sort())
          .toEqual(depth === 0 ? ['src/leaf/price.ts'] : depth === 1 ? ['src/leaf/price.ts', 'src/wrapper/invoice.ts']
            : ['src/consumer/checkout.ts', 'src/leaf/price.ts', 'src/wrapper/invoice.ts']);
        expect(model.packs.some((pack) => pack.subject.name === 'docs/support.md')).toBe(false);
        expect(model.packs.some((pack) => pack.subject.name === 'docs/invoices.md')).toBe(depth > 0);
        expect(model.packs.some((pack) => pack.subject.level === 'product')).toBe(true);
        const count = model.packs.length;
        await analyzeSnapshot(options); await analyzeProductContext(options);
        expect(model.packs).toHaveLength(count);
      }
      // A caller-only edit must not regenerate its unchanged callee.
      const consumerPath = join(root, 'src/consumer/checkout.ts');
      writeFileSync(consumerPath, readFileSync(consumerPath, 'utf8').replace('invoice(value)', 'invoice(value) + 1'));
      const callerChanged = await refreshRepository({ rootPath: root });
      const model = cases[1]!.model; model.packs.length = 0;
      await analyzeSnapshot({ store, snapshotId: callerChanged.scan!.snapshotId, model, budget: { maxTokens: 6000, maxReanalysisDepth: 1 } });
      expect(model.packs.filter((pack) => pack.subject.level === 'symbol').map((pack) => pack.subject.name)).toEqual(['checkout']);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120000);

test('dependency traversal terminates cycles and uses explicit file-import fallback without SCIP', async () => {
  const { root } = createChainFixture();
  try {
    const first = await scanRepository({ rootPath: root, scip: false });
    const store = await openStore(first.dbPath);
    try {
      const symbols = store.listSymbols(first.snapshotId);
      const graph = store.loadGraph(first.snapshotId);
      const context = buildDependencyIndex(store, first.snapshotId, graph, listSourceFiles(store, first.snapshotId));
      const invoice = symbols.find((symbol) => symbol.qualifiedName === 'invoice')!;
      const scope = context.forSubjects([invoice.id], 1);
      expect(scope.resolution).toBe('file-import-fallback');
      expect(scope.dependencies.map((entry) => entry.path)).toEqual(['src/leaf/price.ts']);
      expect(() => context.forSubjects([invoice.id], -1)).toThrow('maxReanalysisDepth');
      const price = symbols.find((symbol) => symbol.qualifiedName === 'price')!;
      const edge = { snapshotId: first.snapshotId, sourceId: price.id, targetId: invoice.id,
        edgeType: 'CALLS' as const, analyzer: 'cycle-fixture', confidence: 1, evidence: null };
      store.insertEdges([edge, { ...edge, sourceId: invoice.id, targetId: price.id }]);
      const cyclic = buildDependencyIndex(store, first.snapshotId, store.loadGraph(first.snapshotId), listSourceFiles(store, first.snapshotId));
      const result = cyclic.forSubjects([price.id], 32);
      expect(result.dependencies.some((entry) => entry.id === invoice.id)).toBe(true);
      expect(result.dependencies.some((entry) => entry.id === price.id)).toBe(false);
      expect(new Set(result.dependencies.map((entry) => entry.id)).size).toBe(result.dependencies.length);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
