import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, test } from '@rstest/core';
import { refreshRepository, scanRepository } from '@repolead/code-graph';
import { openStore } from '@repolead/knowledge-store';

import { analyzeSnapshot } from './analyze';
import { planEntryPointAnalysis, selectProductEntryPoints } from './entrypoint-analysis';
import { analyzeProductContext } from './product';
import { ContractModel } from '../test-support/contract-model';
import { createChainFixture } from '../test-support/chain-fixture';

function fixture(multiple = true) {
  const f = createChainFixture();
  const put = (path: string, source: string) => { mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), source); };
  put('src/domain/orders.py', 'def validate_order(value):\n    return value > 0\n');
  put('src/application/use_cases/create_order.py', 'from src.domain.orders import validate_order\n\nclass CreateOrderUseCase:\n    def execute(self, value):\n        if not validate_order(value):\n            raise ValueError("approval required")\n        return value\n');
  put('src/application/use_cases/mappers.py', 'def map_order(value):\n    return value\n');
  put('src/application/dtos/order.py', 'class OrderDTO:\n    value: int\n');
  put('src/pages/orders/OrdersPage.tsx', 'export function OrdersPage() { return <main>Orders require approval</main>; }\n');
  put('src/pages/orders/OrderForm.tsx', 'export function OrderForm() { return <form>Order form</form>; }\n');
  put('src/pages/orders/HiddenPanel.tsx', 'export function HiddenPanel() { return <aside>Auxiliary</aside>; }\n');
  put('src/pages/orders/OrdersPage.test.tsx', 'export function OrdersPageTest() { return <div>test</div>; }\n');
  put('src/Router.tsx', 'import { OrdersPage } from "./pages/orders/OrdersPage";\nexport function Router() { return <OrdersPage />; }\n');
  if (multiple) { put('src/application/use_cases/decide_order.py', 'DEFAULT_STATE = "pending"\n\nclass ApproveOrderUseCase:\n    def execute(self):\n        return "approved"\n\nclass RejectOrderUseCase:\n    def execute(self):\n        return "rejected"\n'); }
  f.git('add', '.');
  return { ...f, put };
}

test('entrypoints analyzes each use case and page once, indexes other code and invalidates dependent cases only', async () => {
  const f = fixture();
  try {
    const scan = await scanRepository({ rootPath: f.root, scip: false }); const store = await openStore(scan.dbPath);
    try {
      const model = new ContractModel();
      const options = { store, snapshotId: scan.snapshotId, model, analysisMode: 'entrypoints' as const,
        budget: { maxTokens: 120000, maxReanalysisDepth: 1 } };
      const selection = selectProductEntryPoints(options);
      expect(selection.targets.map((target) => target.name).sort()).toEqual(['ApproveOrderUseCase', 'CreateOrderUseCase', 'OrdersPage', 'RejectOrderUseCase']);
      const progress: number[] = [];
      await analyzeSnapshot({ ...options, onProgress: (entry) => progress.push(entry.total) });
      expect(model.packs).toHaveLength(4); expect(progress).toEqual([4, 4, 4, 4]);
      expect(model.packs.every((pack) => pack.subject.level === 'file' && !pack.subject.id.includes('#synthesis'))).toBe(true);
      const approve = model.packs.find((pack) => pack.subject.name.includes('#ApproveOrderUseCase'))!;
      expect(JSON.stringify(approve)).toContain('approved'); expect(JSON.stringify(approve)).not.toContain('class RejectOrderUseCase');
      expect(JSON.stringify(approve)).toContain('DEFAULT_STATE');
      expect(store.listVisibleSummaries(scan.snapshotId)).toHaveLength(4);
      expect(store.listKnowledgeItems(scan.snapshotId).some((item) => item.path === 'src/application/dtos/order.py')).toBe(true);
      await analyzeProductContext(options);
      expect(model.packs).toHaveLength(4); expect(store.listSummaries(scan.snapshotId, 'product')).toHaveLength(0);
      expect(JSON.parse(store.getSnapshotMetadata(scan.snapshotId, 'technical_analysis')!)).toMatchObject({
        status: 'complete', usecases: 3, pages: 1, entrypoints: 4, selectionComplete: true, completeSourceCoverage: false,
      });
      await analyzeSnapshot(options); expect(model.packs).toHaveLength(4);
      f.put('src/domain/orders.py', 'def validate_order(value):\n    return value > 5\n');
      const refreshed = await refreshRepository({ rootPath: f.root, scip: false });
      expect(store.getSnapshotMetadata(refreshed.scan!.snapshotId, 'synthesis_mode')).toBe('entrypoints');
      await analyzeSnapshot({ ...options, snapshotId: refreshed.scan!.snapshotId });
      expect(model.packs).toHaveLength(5);
      expect(model.packs[4]!.subject.name).toContain('create_order.py');
    } finally { store.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('entrypoints reuses compatible whole-file cached analyses without regenerating unrelated files or groups', async () => {
  const f = fixture(false);
  try {
    const scan = await scanRepository({ rootPath: f.root, scip: false }); const store = await openStore(scan.dbPath);
    try {
      const model = new ContractModel(); const options = { store, snapshotId: scan.snapshotId, model, budget: { maxTokens: 120000 } };
      await analyzeSnapshot({ ...options, analysisMode: 'files' });
      const before = model.packs.length;
      const result = await analyzeSnapshot({ ...options, analysisMode: 'entrypoints' });
      expect(model.packs).toHaveLength(before); expect(result.filesCached).toBe(2);
      expect(store.listVisibleSummaries(scan.snapshotId)).toHaveLength(2);
      expect(store.listVisibleSummaries(scan.snapshotId).every((summary) => summary.level === 'file')).toBe(true);
    } finally { store.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('entrypoint planning refuses partial source instead of splitting one case into extra generations', async () => {
  const f = fixture(false);
  try {
    const scan = await scanRepository({ rootPath: f.root, scip: false }); const store = await openStore(scan.dbPath);
    try {
      const model = new ContractModel();
      expect(() => planEntryPointAnalysis({ store, snapshotId: scan.snapshotId, budget: { maxSourceLinesPerPack: 1 } })).toThrow('single-analysis');
      expect(model.packs).toHaveLength(0);
    } finally { store.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
