import { expect, test } from '@rstest/core';
import { contentHash } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';
import { countTokens } from '@repolead/retrieval';

import type { HierarchicalPack } from './hierarchy';
import type { TechLeadModel } from './model';
import { analyzeProductContext, buildDocumentPacks } from './product';

class ProductModel implements TechLeadModel {
  name = 'product-fixture';
  packs: HierarchicalPack[] = [];
  unsupportedImplementation = false;
  fabricatedSymbol = false;
  complete(request: { prompt: string; schema: Record<string, unknown> }): ReturnType<TechLeadModel['complete']> {
    const pack = JSON.parse(request.prompt.split('Evidence pack:\n')[1]!.split('\n\nReturn ')[0]!) as HierarchicalPack;
    this.packs.push(pack);
    const evidenceIds = pack.evidence.map((entry) => entry.id);
    const feature = { claim: 'A customer can request an invoice', evidenceIds: evidenceIds.slice(0, 1),
      basis: this.unsupportedImplementation ? 'implemented' : pack.evidence[0]?.kind === 'document' ? 'documented' : 'inferred',
      symbolIds: this.fabricatedSymbol ? ['sym_not_supplied'] : [] };
    return Promise.resolve({ json: {
      [pack.subject.level === 'product' ? 'objective' : 'purpose']: 'Invoicing product context',
      goals: [], features: evidenceIds.length ? [feature] : [], roles: [], userFlows: [], businessRules: [], decisions: [],
      evidenceIds, unknowns: [],
    }, inputTokens: 10, outputTokens: 5 });
  }
}

async function fixture(content = '# Invoicing\nCustomers can request invoices.\n') {
  const store = await openStore(':memory:');
  const repository = store.upsertRepository({ name: 'invoices', rootPath: '/not-mounted' });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'initial' });
  const document = { id: 'repo://invoices/docs/product.md#document', snapshotId: snapshot.id, repositoryId: repository.id,
    path: 'docs/product.md', title: 'Invoicing', content, contentHash: contentHash(content) };
  store.insertDocuments([document]);
  return { store, repository, snapshot, document };
}

test('product context is generated from SQLite documents, cited, and reused without model calls', async () => {
  const { store, snapshot, document } = await fixture();
  try {
    const model = new ProductModel();
    const first = await analyzeProductContext({ store, snapshotId: snapshot.id, model });
    expect(first.documentsAnalyzed).toBe(1);
    expect(first.productCached).toBe(false);
    expect(model.packs).toHaveLength(2);
    expect(JSON.stringify(model.packs[0])).toContain('Customers can request invoices.');
    const brief = store.listSummaries(snapshot.id, 'product')[0]!;
    const content = JSON.parse(brief.contentJson) as { features: { basis: string }[]; unknowns: string[] };
    expect(content.features[0]?.basis).toBe('documented');
    expect(content.unknowns.some((entry) => entry.includes('not proof'))).toBe(true);
    expect(store.searchDocuments(snapshot.id, 'invoices')[0]?.document.id).toBe(document.id);
    const repeat = await analyzeProductContext({ store, snapshotId: snapshot.id, model });
    expect(repeat.inputTokens).toBe(0);
    expect(repeat.productCached).toBe(true);
    expect(model.packs).toHaveLength(2);
    for (const record of store.getSummaryEvidence(brief.id)) {
      for (const id of record.parentIds) { expect(store.getEvidenceRecord(id)).not.toBeNull(); }
    }
  } finally { store.close(); }
});

test('all documentation lines are analyzed in bounded sections, including the final business rule', async () => {
  const content = ['# Rules', ...Array.from({ length: 80 }, (_, index) => `Rule ${index}: only the account owner can approve this transaction.`), 'FINAL RULE: refunds require approval.'].join('\n');
  const { store, snapshot, document } = await fixture(content);
  try {
    const packs = buildDocumentPacks(document, 700, 15);
    expect(packs.length).toBeGreaterThan(1);
    const covered = packs.flatMap((entry) => entry.evidence.flatMap((evidence) => Array.from({ length: evidence.endLine! - evidence.startLine! + 1 }, (_, index) => evidence.startLine! + index)));
    expect(covered).toEqual(Array.from({ length: 82 }, (_, index) => index + 1));
    for (const { pack } of packs) { expect(countTokens(JSON.stringify(pack))).toBeLessThanOrEqual(700); }
    const model = new ProductModel();
    await analyzeProductContext({ store, snapshotId: snapshot.id, model, budget: { maxTokens: 700, maxSourceLinesPerPack: 15 } });
    expect(JSON.stringify(model.packs)).toContain('FINAL RULE');
    expect(store.getSummary(snapshot.id, document.id, 'document')).not.toBeNull();
    const calls = model.packs.length;
    await analyzeProductContext({ store, snapshotId: snapshot.id, model, budget: { maxTokens: 700, maxSourceLinesPerPack: 15 } });
    expect(model.packs.length).toBe(calls);
  } finally { store.close(); }
});

test('documentation alone cannot be classified as implemented and invented symbol links are rejected', async () => {
  const { store, snapshot } = await fixture();
  try {
    const model = new ProductModel();
    model.unsupportedImplementation = true;
    await expect(analyzeProductContext({ store, snapshotId: snapshot.id, model, validationRetries: 1 })).rejects.toThrow('requires source evidence');
    expect(model.packs).toHaveLength(2);
    expect(store.listSummaries(snapshot.id)).toHaveLength(0);
    model.unsupportedImplementation = false;
    model.fabricatedSymbol = true;
    await expect(analyzeProductContext({ store, snapshotId: snapshot.id, model, validationRetries: 0 })).rejects.toThrow('not supplied');
  } finally { store.close(); }
});

test('changed and deleted documentation rebuilds product context without resurrecting old claims', async () => {
  const { store, snapshot, document, repository } = await fixture();
  try {
    const model = new ProductModel();
    await analyzeProductContext({ store, snapshotId: snapshot.id, model });
    const next = store.createSnapshot({ repositoryId: repository.id, commitSha: 'changed' });
    store.insertDocuments([{ ...document, snapshotId: next.id, content: '# Changed requirements\nInvoices require manager approval.', contentHash: 'changed' }]);
    const result = await analyzeProductContext({ store, snapshotId: next.id, model });
    expect(result.documentsAnalyzed).toBe(1);
    expect(result.productCached).toBe(false);
    const empty = store.createSnapshot({ repositoryId: repository.id, commitSha: 'deleted' });
    await analyzeProductContext({ store, snapshotId: empty.id, model });
    const last = model.packs.at(-1)!;
    expect(JSON.stringify(last.evidence)).not.toContain('manager approval');
    expect(last.unknowns.some((entry) => entry.includes('No product documentation'))).toBe(true);
  } finally { store.close(); }
});

test('a document linked to a source-backed technical card retains the link and caches its synthesis', async () => {
  const { store, snapshot, document, repository } = await fixture();
  try {
    const symbol = { id: 'sym_real_implementation', repositoryId: repository.id, snapshotId: snapshot.id,
      path: 'src/invoice.ts', qualifiedName: 'invoice', kind: 'function' as const, signature: '()',
      startLine: 1, endLine: 1, contentHash: 'source', source: 'fixture' };
    store.insertSymbols([symbol]);
    store.insertEdges([{ snapshotId: snapshot.id, sourceId: symbol.id, targetId: document.id,
      edgeType: 'DOCUMENTED_BY', confidence: 1, analyzer: 'markdown-link', evidence: { path: document.path, line: 3, targetPath: symbol.path, targetLine: 1 } }]);
    const evidence = { id: 'ev_implementation', kind: 'source' as const, path: symbol.path, startLine: 1, endLine: 1, contentHash: 'source', parentIds: [] };
    store.insertSummary({ id: 'card', snapshotId: snapshot.id, subjectId: symbol.id, level: 'symbol',
      contentJson: JSON.stringify({ purpose: 'Create invoice', evidenceIds: [evidence.id], unknowns: [] }), model: 'fixture',
      promptVersion: '3', contentHash: 'card-hash', createdAt: new Date().toISOString() }, [evidence]);
    const model = new ProductModel();
    const progress: number[] = [];
    await analyzeProductContext({ store, snapshotId: snapshot.id, model, onProgress: (entry) => progress.push(entry.total) });
    expect(model.packs).toHaveLength(3);
    expect(progress).toEqual([3, 3, 3]);
    expect(JSON.stringify(model.packs[1])).toContain(symbol.id);
    expect(model.packs[0]!.subject.id).not.toBe(document.id);
    expect(model.packs[1]!.subject.id).toBe(document.id);
    const cached = await analyzeProductContext({ store, snapshotId: snapshot.id, model });
    expect(cached.inputTokens).toBe(0);
    expect(model.packs).toHaveLength(3);
    const next = store.createSnapshot({ repositoryId: repository.id, commitSha: 'same-doc-no-implementation' });
    store.insertDocuments([{ ...document, snapshotId: next.id }]);
    const changed = await analyzeProductContext({ store, snapshotId: next.id, model });
    expect(changed.productCached).toBe(false);
  } finally { store.close(); }
});
