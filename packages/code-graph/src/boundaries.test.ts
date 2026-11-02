import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';

import { openStore } from '@repolead/knowledge-store';
import { DETECTORS, loadPolicies } from '@repolead/policy-engine';

import { policyFixture } from '../test-support/policy-fixture';
import { scanRepository } from './scan';

test('indexed contracts and three-module cycle witnesses reach policies with exact source evidence', async () => {
  const { root, write } = policyFixture();
  // This test checks deterministic facts without requiring optional Python tools.
  write('.repolead.yaml', 'modules:\n  - {name: sales, path: cycles/sales}\n  - {name: billing, path: cycles/billing}\n  - {name: inventory, path: cycles/inventory}\n  - {name: types-left, path: types/left}\n  - {name: types-right, path: types/right}\n');
  const scan = await scanRepository({ rootPath: root, scip: false });
  const store = await openStore(scan.dbPath);
  try {
    const cycles = DETECTORS['module_cycle']!(store, scan.snapshotId, {});
    expect(cycles).toHaveLength(2);
    expect(cycles.map((candidate) => candidate.evidence.length).sort()).toEqual([2, 3]);
    expect(cycles.find((candidate) => candidate.claim.includes('types/'))?.evidence.every((entry) => entry.excerpt?.includes('import type'))).toBe(true);
    const leaks = DETECTORS['framework_type_leak']!(store, scan.snapshotId, {});
    expect(leaks.map((candidate) => candidate.evidence[0]!.path).sort()).toEqual(['domain/checkout.ts', 'domain/checkout.ts', 'domain/request.test.ts']);
    expect(leaks.every((candidate) => store.getSymbol(scan.snapshotId, candidate.facts!['source_symbol'] as string))).toBe(true);
    expect(leaks.some((candidate) => candidate.evidence.some((entry) => entry.excerpt?.includes('authorize(request: HttpRequest): HttpResponse')))).toBe(true);
    const policies = loadPolicies(join(process.cwd(), 'policies'));
    for (const policy of policies) { for (const detector of policy.detectors) { expect(DETECTORS[detector.name]).toBeDefined(); } }
    expect(DETECTORS['graph_dependency_direction']!(store, scan.snapshotId, {}).some((candidate) => candidate.evidence.some((entry) => entry.excerpt?.includes('database.invoice.update')))).toBe(true);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
