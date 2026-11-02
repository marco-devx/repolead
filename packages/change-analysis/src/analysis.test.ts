import { expect, test } from '@rstest/core';

import type { CodeSymbol, Edge, EdgeType, SourceFile } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

import { impactAnalysis } from './impact';
import { traceFlow } from './flow';

async function fixture() {
  const store = await openStore(':memory:');
  const repository = store.upsertRepository({ name: 'analysis-fixture', rootPath: '/not-mounted' });
  const snapshot = store.createSnapshot({ repositoryId: repository.id, commitSha: 'fixture' });
  const files: SourceFile[] = ['src/api/routes.ts', 'src/domain/service.ts', 'src/storage/repository.ts', 'src/storage/repository.test.ts', 'migrations/001.sql'].map((path) => ({
    id: path, path, repositoryId: repository.id, snapshotId: snapshot.id, contentHash: `hash:${path}`,
    lineCount: 30, language: path.endsWith('.sql') ? 'sql' : 'typescript', lastAuthor: null, lastCommitAt: null,
  }));
  store.insertFiles(files);
  store.insertModules(['api', 'domain', 'storage'].map((name) => ({ id: `module:${name}`, name, path: `src/${name}`, repositoryId: repository.id, snapshotId: snapshot.id })));
  const definitions: [string, string, string, CodeSymbol['kind'], CodeSymbol['visibility']?][] = [
    ['endpoint', 'POST /payments', files[0]!.path, 'endpoint'], ['handler', 'handlePayment', files[0]!.path, 'function'],
    ['left', 'primary', files[1]!.path, 'function'], ['right', 'fallback', files[1]!.path, 'function'],
    ['loop', 'loop', files[1]!.path, 'function'], ['reference', 'saveCallback', files[1]!.path, 'variable'],
    ['unused', 'unrelated', files[0]!.path, 'function'], ['repository', 'Repository', files[2]!.path, 'class'],
    ['save', 'Repository.save', files[2]!.path, 'method', 'public'], ['private', 'Repository.hidden', files[2]!.path, 'method', 'private'],
  ];
  const symbols = definitions.map(([id, qualifiedName, path, kind, visibility], index): CodeSymbol => ({
    id, qualifiedName, path, kind, visibility, repositoryId: repository.id, snapshotId: snapshot.id,
    signature: kind === 'method' ? '()' : null, startLine: index + 1, endLine: index + 1,
    source: 'fixture', contentHash: `body:${id}`,
  }));
  store.insertSymbols(symbols);
  const edges: Edge[] = [];
  const edge = (from: string, to: string, type: EdgeType = 'CALLS', analyzer = 'fixture-scip') => {
    const source = symbols.find((symbol) => symbol.id === from);
    edges.push({ snapshotId: snapshot.id, sourceId: from, targetId: to, edgeType: type,
      analyzer, confidence: analyzer === 'fixture-scip' ? 0.95 : 0.8,
      evidence: { path: source?.path ?? from, line: source?.startLine ?? 1, source: 'PRIVATE_BODY_MARKER' } });
  };
  for (const symbol of symbols) { edge(symbol.kind === 'method' ? 'repository' : symbol.path, symbol.id, 'CONTAINS'); }
  edge('endpoint', 'handler'); edge('handler', 'left'); edge('handler', 'right');
  edge('left', 'save'); edge('right', 'save'); edge('left', 'loop'); edge('loop', 'left');
  edge('left', 'save', 'CALLS', 'second-analyzer');
  edge('reference', 'save', 'DEPENDS_ON'); edge(files[0]!.path, files[2]!.path, 'IMPORTS');
  edge(files[0]!.path, 'handler', 'DEPENDS_ON'); // An import reference does not make every function in the importing file a caller.
  edge('save', 'resource://orders', 'WRITES_TO'); edge('save', 'event://paid', 'EMITS');
  edge(files[2]!.path, files[3]!.path, 'TESTED_BY');
  store.insertEdges(edges);
  store.insertTests([1, 2].map((line) => ({ id: `test:${line}`, snapshotId: snapshot.id, path: files[3]!.path,
    name: `payment test ${line}`, startLine: line, endLine: line })));
  store.insertExports([{ id: 'export:repository', snapshotId: snapshot.id, path: files[2]!.path, exportedName: 'Repository',
    localName: 'Repository', sourceModule: null, typeOnly: false, startLine: 1, symbolId: 'repository' }]);
  store.insertReferences(symbols.filter((symbol) => symbol.kind !== 'endpoint').map((symbol) => ({ snapshotId: snapshot.id, targetId: symbol.id, sourceId: symbol.id,
    path: symbol.path, startLine: symbol.startLine, endLine: symbol.endLine, startColumn: 0, endColumn: 1,
    isDefinition: true, isCall: false, analyzer: 'fixture-scip', scipSymbol: symbol.id })));
  store.setSnapshotMetadata(snapshot.id, 'scip_diagnostics', JSON.stringify({ indexers: [{ status: 'complete', source: 'unit fixture only' }] }));
  return { store, snapshot, files, symbols, edges };
}

test('flow returns both shortest call paths, preserves analyzer evidence, ignores reference-only shortcuts and terminates cycles', async () => {
  const { store, snapshot, edges } = await fixture();
  try {
    const result = traceFlow(store, snapshot.id, { from: 'POST /payments', to: 'Repository.save' });
    if ('error' in result) { throw new Error(result.error); }
    expect(result.paths.map((path) => path.nodes.map((node) => node.id).join('/')).sort()).toEqual(['endpoint/handler/left/save', 'endpoint/handler/right/save']);
    expect(result.paths.every((path) => new Set(path.nodes.map((node) => node.id)).size === path.nodes.length)).toBe(true);
    for (const path of result.paths) {
      for (const hop of path.edges) { expect(edges.some((edge) => edge.sourceId === hop.sourceId && edge.targetId === hop.targetId && edge.edgeType === hop.type)).toBe(true); }
    }
    const duplicated = result.paths.flatMap((path) => path.edges).find((edge) => edge.sourceId === 'left' && edge.targetId === 'save')!;
    expect(duplicated.provenance).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_BODY_MARKER');
    const callerChange = impactAnalysis(store, snapshot.id, { symbols: ['endpoint'] });
    if ('error' in callerChange) { throw new Error(callerChange.error); }
    expect(callerChange.affectedSymbols.items.map((entry) => entry.id)).toEqual(['endpoint']);
    expect(callerChange.sideEffects.total).toBe(2); // Effects in unchanged callees still matter.
    const callback = traceFlow(store, snapshot.id, { from: 'saveCallback', to: 'Repository.save' });
    if ('error' in callback) { throw new Error(callback.error); }
    expect(callback.paths).toHaveLength(0);
    expect(callback.unknowns.join(' ')).toContain('not proof');
  } finally { store.close(); }
});

test('effect mode ends on actual recorded effects and explicit limits never report a complete traversal', async () => {
  const { store, snapshot } = await fixture();
  try {
    const effect = traceFlow(store, snapshot.id, { from: 'POST /payments' });
    if ('error' in effect) { throw new Error(effect.error); }
    expect(effect.paths).toHaveLength(4);
    expect(new Set(effect.paths.map((path) => path.edges.at(-1)!.type))).toEqual(new Set(['WRITES_TO', 'EMITS']));
    for (const [options, flag] of [
      [{ maxDepth: 2 }, 'depthLimitReached'], [{ maxNodes: 2 }, 'nodeLimitReached'],
      [{ maxEdges: 1 }, 'edgeLimitReached'], [{ maxPaths: 1 }, 'pathsTruncated'],
    ] as const) {
      const limited = traceFlow(store, snapshot.id, { from: 'POST /payments', to: 'Repository.save', ...options });
      if ('error' in limited) { throw new Error(limited.error); }
      expect(limited.limits[flag]).toBe(true);
      expect(limited.unknowns.join(' ')).toContain('bounded');
    }
  } finally { store.close(); }
});

test('impact finds callers, references, routes and relevant tests without including an unrelated function from the same importing file', async () => {
  const { store, snapshot } = await fixture();
  try {
    const result = impactAnalysis(store, snapshot.id, { change: 'Add retry behavior to Repository.save' });
    if ('error' in result) { throw new Error(result.error); }
    expect(result.selection.roots.map((node) => node.id)).toEqual(['save']);
    expect(result.affectedSymbols.items.map((node) => node.id).sort()).toEqual(['endpoint', 'handler', 'left', 'loop', 'reference', 'right', 'save']);
    expect(result.relevantTests.items.map((entry) => entry.id)).toEqual(['test:1', 'test:2']);
    expect(result.publicContracts.items.map((entry) => entry.id).sort()).toEqual(['endpoint', 'save']);
    expect(result.sideEffects.total).toBe(2);
    expect(result.score.factors.reduce((sum, factor) => sum + factor.weight, 0)).toBe(100);
    expect(result.score.factors.find((factor) => factor.id === 'persistence')?.status).toBe('observed');
    expect(result.score.factors.find((factor) => factor.id === 'authorization')?.points).toBeNull();
    expect(result.score.range.maximum).toBeGreaterThan(result.score.observed);
    expect(result.recommendedWorkflow.provisional).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_BODY_MARKER');
  } finally { store.close(); }
});

test('unknown coverage is not zero risk; verified affected-file coverage is weighted without demanding coverage of test files', async () => {
  const { store, snapshot, files } = await fixture();
  try {
    const unknown = impactAnalysis(store, snapshot.id, { symbols: ['save'] });
    if ('error' in unknown) { throw new Error(unknown.error); }
    expect(unknown.score.factors.find((factor) => factor.id === 'coverage_gap')?.points).toBeNull();
    for (const file of files.slice(0, 3)) {
      store.insertCoverage([{ snapshotId: snapshot.id, path: file.path, sourceHash: file.contentHash, analyzer: 'lcov-fixture',
        lineRate: 0.5, branchRate: null, lines: [{ line: 1, hits: 1 }, { line: 2, hits: 0 }], provenance: { sourceBinding: 'reported-lines-verified' } }]);
    }
    const covered = impactAnalysis(store, snapshot.id, { symbols: ['save'] });
    if ('error' in covered) { throw new Error(covered.error); }
    const factor = covered.score.factors.find((entry) => entry.id === 'coverage_gap')!;
    expect(factor.status).toBe('reported'); expect(factor.value).toBe(0.5);
    expect(covered.score.range.maximum).toBeLessThan(unknown.score.range.maximum);
    store.db.prepare('UPDATE coverage SET source_hash = ? WHERE path = ?').run('stale', files[0]!.path);
    const stale = impactAnalysis(store, snapshot.id, { symbols: ['save'] });
    if ('error' in stale) { throw new Error(stale.error); }
    expect(stale.score.factors.find((entry) => entry.id === 'coverage_gap')?.status).toBe('unknown');
  } finally { store.close(); }
});

test('member visibility, directly selected declarations and supplied change facts remain distinct from observed risk', async () => {
  const { store, snapshot } = await fixture();
  try {
    const hidden = impactAnalysis(store, snapshot.id, { symbols: ['Repository.hidden'] });
    if ('error' in hidden) { throw new Error(hidden.error); }
    expect(hidden.publicContracts.total).toBe(0);
    const container = impactAnalysis(store, snapshot.id, { symbols: ['Repository'], facts: { schemaChange: true, reversible: false, authorizationChange: true, concurrencyChange: true } });
    if ('error' in container) { throw new Error(container.error); }
    expect(container.affectedSymbols.items.some((node) => node.id === 'private')).toBe(true);
    expect(container.publicContracts.items.some((node) => node.id === 'private')).toBe(false);
    expect(container.score.factors.find((factor) => factor.id === 'schema')?.status).toBe('provided');
    expect(container.recommendedWorkflow.tier).toBe('cross-cutting');
    expect(container.recommendedWorkflow.specificationRequired).toBe(true);
    expect(container.recommendedWorkflow.note).toContain('no agents');
    const schema = impactAnalysis(store, snapshot.id, { paths: ['migrations/001.sql'] });
    if ('error' in schema) { throw new Error(schema.error); }
    expect(schema.score.factors.find((factor) => factor.id === 'schema')?.status).toBe('observed');
  } finally { store.close(); }
});

test('fallback imports, pagination, bounds and snapshot isolation are explicit', async () => {
  const { store, snapshot } = await fixture();
  try {
    store.db.prepare('DELETE FROM symbol_references WHERE snapshot_id = ?').run(snapshot.id);
    const fallback = impactAnalysis(store, snapshot.id, { symbols: ['save'], limit: 2 });
    if ('error' in fallback) { throw new Error(fallback.error); }
    expect(fallback.unknowns.join(' ')).toContain('conservative');
    expect(fallback.affectedSymbols.total).toBeGreaterThan(2);
    expect(fallback.affectedSymbols.nextOffset).toBe(2);
    const next = impactAnalysis(store, snapshot.id, { symbols: ['save'], limit: 2, offset: 2 });
    if ('error' in next) { throw new Error(next.error); }
    expect(next.affectedSymbols.items.some((entry) => fallback.affectedSymbols.items.some((previous) => previous.id === entry.id))).toBe(false);
    expect(next.score).toEqual(fallback.score);
    const bounded = impactAnalysis(store, snapshot.id, { symbols: ['save'], maxNodes: 1 });
    if ('error' in bounded) { throw new Error(bounded.error); }
    expect(bounded.limits.nodeLimitReached).toBe(true);
    expect(bounded.unknowns.join(' ')).toContain('lower bounds');
    const latest = store.createSnapshot({ repositoryId: snapshot.repositoryId, commitSha: 'empty' });
    expect('error' in impactAnalysis(store, latest.id, { symbols: ['save'] })).toBe(true);
    expect('error' in traceFlow(store, latest.id, { from: 'POST /payments' })).toBe(true);
  } finally { store.close(); }
});

test('ambiguous/unknown selections and invalid options never silently choose a target', async () => {
  const { store, snapshot, symbols } = await fixture();
  try {
    store.insertSymbols([{ ...symbols.find((symbol) => symbol.id === 'save')!, id: 'other-save', path: 'src/other.ts' }]);
    const duplicate = impactAnalysis(store, snapshot.id, { change: 'Change Repository.save behavior' });
    expect('error' in duplicate && duplicate.candidates.length).toBe(2);
    const exact = traceFlow(store, snapshot.id, { from: 'endpoint', to: 'save' });
    expect('error' in exact).toBe(false);
    const unknown = impactAnalysis(store, snapshot.id, { change: 'unidentifiable feature request' });
    expect('error' in unknown).toBe(true);
    expect('error' in impactAnalysis(store, snapshot.id, { paths: ['../outside'] })).toBe(true);
    expect(() => traceFlow(store, snapshot.id, { from: 'save', maxDepth: -1 })).toThrow('maxDepth');
    expect(() => impactAnalysis(store, snapshot.id, { symbols: ['save'], limit: 0 })).toThrow('limit');
    expect(() => impactAnalysis(store, snapshot.id, { symbols: ['save', 'left'], maxNodes: 1 })).toThrow('roots');
  } finally { store.close(); }
});

test('a later conservative file path expands a previously visited exact-reference file without losing its dependencies', async () => {
  const { store, snapshot, files } = await fixture();
  try {
    store.db.prepare('DELETE FROM symbol_references WHERE target_id = ?').run('left');
    store.insertEdges([
      { snapshotId: snapshot.id, sourceId: files[0]!.id, targetId: 'save', edgeType: 'DEPENDS_ON', confidence: 0.95, analyzer: 'fixture', evidence: null },
      { snapshotId: snapshot.id, sourceId: files[0]!.id, targetId: files[1]!.id, edgeType: 'IMPORTS', confidence: 1, analyzer: 'fixture', evidence: null },
    ]);
    const result = impactAnalysis(store, snapshot.id, { symbols: ['save'] });
    if ('error' in result) { throw new Error(result.error); }
    expect(result.affectedSymbols.items.some((entry) => entry.id === 'unused')).toBe(true);
    expect(result.unknowns.join(' ')).toContain('conservative');
    const shallow = impactAnalysis(store, snapshot.id, { symbols: ['save'], maxDepth: 2 });
    if ('error' in shallow) { throw new Error(shallow.error); }
    expect(shallow.affectedSymbols.items.some((entry) => entry.id === 'unused')).toBe(false);
    expect(shallow.limits.depthLimitReached).toBe(true);
  } finally { store.close(); }
});
