import { rmSync } from 'node:fs';

import { expect, rstest, test } from '@rstest/core';
import { Command } from 'commander';
import { scanRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';

import { ContractModel } from '../../../../packages/lead-analyzer/test-support/contract-model';
import { createChainFixture } from '../../../../packages/lead-analyzer/test-support/chain-fixture';
import { registerRefresh } from './refresh';
import { registerOnboard } from './onboard';

test('refresh --analyze prepares and resumes both audiences even when indexed bytes are unchanged', async () => {
  const { root } = createChainFixture();
  const log = rstest.spyOn(console, 'log').mockImplementation(() => undefined);
  rstest.stubEnv('REPOLEAD_TEI_URL', 'http://127.0.0.1:1');
  rstest.stubEnv('REPOLEAD_QDRANT_URL', 'http://127.0.0.1:1');
  try {
    const initial = await scanRepository({ rootPath: root, scip: false });
    const model = new ContractModel();
    const invoke = async (...args: string[]) => {
      const program = new Command().exitOverride();
      registerRefresh(program, async () => model);
      await program.parseAsync(['node', 'repolead', 'refresh', root, '--no-scip', ...args]);
    };
    await invoke();
    expect(model.packs).toHaveLength(0);
    await invoke('--analyze', '--no-product');
    const technicalCalls = model.packs.length;
    expect(technicalCalls).toBeGreaterThan(0);
    expect(model.packs.some((pack) => pack.subject.level === 'product')).toBe(false);
    expect(model.packs.some((pack) => pack.subject.level === 'symbol')).toBe(false);
    expect(model.packs.some((pack) => pack.subject.level === 'file' && JSON.stringify(pack).includes('"maxDepth":1'))).toBe(true);
    await invoke('--analyze');
    expect(model.packs.slice(technicalCalls).every((pack) => ['document', 'product'].includes(pack.subject.level))).toBe(true);
    const total = model.packs.length;
    await invoke('--analyze');
    expect(model.packs).toHaveLength(total);
    const store = await openStore(initial.dbPath);
    try {
      expect(store.getLatestSnapshot()?.id).toBe(initial.snapshotId);
      expect(store.listSummaries(initial.snapshotId, 'product')).toHaveLength(0);
      expect(JSON.parse(store.getSnapshotMetadata(initial.snapshotId, 'product_analysis')!)).toMatchObject({
        synthesisMode: 'first-round', status: 'complete', globalSummarySkipped: true,
      });
      expect(JSON.parse(store.getSnapshotMetadata(initial.snapshotId, 'technical_analysis')!).maxReanalysisDepth).toBe(1);
    } finally { store.close(); }
  } finally {
    log.mockRestore(); rstest.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
}, 120000);

test('refresh and onboard can defer vectors without contacting embedding services', async () => {
  const { root } = createChainFixture();
  const log = rstest.spyOn(console, 'log').mockImplementation(() => undefined);
  const fetch = rstest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network expected'));
  try {
    const program = new Command().exitOverride();
    registerOnboard(program);
    await program.parseAsync(['node', 'repolead', 'onboard', root, '--no-scip', '--no-analyze', '--no-product', '--no-audit', '--no-vectors']);
    expect(fetch).not.toHaveBeenCalled();
    const model = new ContractModel();
    const refresh = new Command().exitOverride();
    registerRefresh(refresh, async () => model);
    await refresh.parseAsync(['node', 'repolead', 'refresh', root, '--analyze', '--no-scip', '--no-vectors']);
    expect(fetch).not.toHaveBeenCalled();
    const store = await openStore(`${root}/.repolead/repolead.db`);
    try {
      const snapshot = store.getLatestSnapshot()!;
      expect(store.getSnapshotMetadata(snapshot.id, 'vector_refresh_pending')).toBe('true');
      expect(store.listSummaries(snapshot.id, 'product')).toHaveLength(0);
      expect(JSON.parse(store.getSnapshotMetadata(snapshot.id, 'product_analysis')!).status).toBe('complete');
    } finally { store.close(); }
  } finally { fetch.mockRestore(); log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
