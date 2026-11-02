import { expect, test } from '@rstest/core';
import { countTokens } from '@repolead/retrieval';
import { evidenceEntry, fitHierarchyPack, summaryEntries } from './hierarchy';
import { modelEvidence } from './model-evidence';
import { summarySchema, validateSummary } from './prompts';

test('short citations reduce repeated output tokens and restore exact persistent provenance without mutating facts', () => {
  const entries = Array.from({ length: 12 }, (_, index) => evidenceEntry('source', `${index}.ts`, { source: 'const businessCode = "E1";' }));
  const { pack } = fitHierarchyPack({ id: 'subject', name: 'subject', level: 'symbol' }, entries, 6000);
  const schema = summarySchema('symbol'); const supplied = modelEvidence(pack, schema);
  expect(supplied.pack.evidence.map((entry) => entry.id)).toEqual(entries.map((_, index) => `RLE${index + 1}`));
  expect(supplied.pack.evidence[0]!.facts).toEqual(entries[0]!.facts);
  expect(pack.evidence[0]!.id).toBe(entries[0]!.record.id);
  expect(schema['$defs']).toBeUndefined();
  expect(supplied.schema['$defs']).toEqual({ evidenceId: { type: 'string', enum: entries.map((_, index) => `RLE${index + 1}`) } });
  const short = { purpose: 'Returns business code E1.', inputs: [], outputs: [], sideEffects: [], dependencies: [], invariants: [], errorBehavior: [], tests: [], unknowns: [],
    evidenceIds: supplied.pack.evidence.map((entry) => entry.id) };
  const expanded = supplied.expand(short);
  expect(supplied.expand({ text: 'See RLE1, business code E1.' })).toEqual({ text: `See ${entries[0]!.record.id}, business code E1.` });
  expect(validateSummary('symbol', expanded, new Set(entries.map((entry) => entry.record.id)))).toEqual({ ...short, evidenceIds: entries.map((entry) => entry.record.id) });
  expect(countTokens(JSON.stringify(short))).toBeLessThan(countTokens(JSON.stringify(expanded)) / 2);
  expect(() => validateSummary('symbol', supplied.expand({ ...short, evidenceIds: ['E999'] }), new Set(entries.map((entry) => entry.record.id)))).toThrow();
});

test('child claims retain their own evidence parents while nested citation strings are removed from model-facing facts', () => {
  const content = { features: [{ claim: 'Documented export', basis: 'documented', evidenceIds: ['ev_doc'], symbolIds: [] },
    { claim: 'Implemented math', basis: 'implemented', evidenceIds: ['ev_source'], symbolIds: ['sym_math'] }], evidenceIds: ['ev_doc', 'ev_source'], unknowns: [] };
  const entries = summaryEntries([{ path: 'docs/product.md', summary: { id: 's', snapshotId: 'snap', subjectId: 'doc', level: 'document',
    contentJson: JSON.stringify(content), model: 'test', promptVersion: '7', contentHash: 'hash', createdAt: 'now' } }]);
  expect(entries[0]!.record.parentIds).toEqual(['ev_doc']); expect(entries[1]!.record.parentIds).toEqual(['ev_source']);
  expect(JSON.stringify(entries.map((entry) => entry.facts))).not.toContain('evidenceIds');
  expect(JSON.stringify(entries.map((entry) => entry.facts))).toContain('sym_math');
  const { pack } = fitHierarchyPack({ id: 'product', name: 'product', level: 'product' }, entries, 4000);
  const supplied = modelEvidence(pack, summarySchema('product'));
  expect((supplied.schema['$defs'] as Record<string, unknown>)['symbolId']).toEqual({ type: 'string', enum: ['sym_math'] });
  const withoutSymbols = modelEvidence({ ...pack, evidence: [] }, summarySchema('product'));
  expect(JSON.stringify(withoutSymbols.schema)).toContain('"maxItems":0');
});

test('model transport omits cache hashes while preserving literal source, domain values and isolated citations', () => {
  const hash = 'a'.repeat(64);
  const facts = { source: 'const contentHash = "business-value";', contentHash: hash, fingerprint: hash,
    domain: { contentHash: 'business-value', fingerprint: 'customer-fingerprint' },
    dependencyScope: { fingerprint: hash, maxDepth: 3, unresolvedTargets: 1, beyondDepth: 2,
      dependencies: [{ id: 'sym_dependency', name: 'charge', path: 'payment.ts', distance: 1, contentHash: hash }] } };
  const entry = evidenceEntry('source', 'app.ts', facts);
  const { pack } = fitHierarchyPack({ id: 'first', name: 'first', level: 'symbol' }, [entry], 4000);
  const before = JSON.stringify(pack);
  const first = modelEvidence(pack, summarySchema('symbol'), 'first');
  const second = modelEvidence(pack, summarySchema('symbol'), 'second');
  expect(JSON.stringify(pack)).toBe(before);
  expect(JSON.stringify(first.pack)).not.toContain(hash);
  expect(JSON.stringify(first.pack)).toContain('customer-fingerprint');
  expect(JSON.stringify(first.pack)).toContain('business-value');
  expect(JSON.stringify(first.pack)).toContain('"beyondDepth":2');
  expect(countTokens(JSON.stringify(first.pack))).toBeLessThan(countTokens(before));
  expect(first.pack.evidence[0]!.id).not.toBe(second.pack.evidence[0]!.id);
  const valid = { purpose: 'Supported', inputs: [], outputs: [], sideEffects: [], dependencies: [], invariants: [], errorBehavior: [], tests: [], unknowns: [],
    evidenceIds: [first.pack.evidence[0]!.id] };
  expect(() => validateSummary('symbol', first.expand(valid), new Set([entry.record.id]))).not.toThrow();
  expect(() => validateSummary('symbol', first.expand({ ...valid, evidenceIds: [second.pack.evidence[0]!.id] }), new Set([entry.record.id]))).toThrow('Unknown');
});
