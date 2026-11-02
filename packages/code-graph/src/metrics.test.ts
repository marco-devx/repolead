import { expect, test } from '@rstest/core';

import type { CodeSymbol, Edge, SourceFile } from '@repolead/domain';

import { graphMetrics } from './metrics';

test('graph metrics deduplicate edges, exclude recursion and expose dependency components', () => {
  const files: SourceFile[] = ['a/one.ts', 'a/two.ts', 'a/three.ts', 'a/four.ts', 'b/main.ts'].map((path) => ({
    id: path, path, repositoryId: 'repo', snapshotId: 'snap', language: 'typescript', contentHash: path,
    lineCount: 1, lastAuthor: null, lastCommitAt: null,
  }));
  const symbols: CodeSymbol[] = files.map((file) => ({ id: `symbol:${file.path}`, path: file.path, repositoryId: 'repo', snapshotId: 'snap',
    qualifiedName: file.path, kind: 'function', signature: null, startLine: 1, endLine: 1, contentHash: file.path, source: 'fixture' }));
  const edge = (sourceId: string, targetId: string, edgeType: Edge['edgeType']): Edge => ({ snapshotId: 'snap', sourceId, targetId, edgeType, analyzer: 'fixture', confidence: 1, evidence: {} });
  const edges = [
    edge(symbols[0]!.id, symbols[0]!.id, 'CALLS'),
    edge(symbols[0]!.id, symbols[1]!.id, 'CALLS'), edge(symbols[0]!.id, symbols[1]!.id, 'DEPENDS_ON'),
    edge('a/one.ts', 'a/two.ts', 'IMPORTS'),
    edge(symbols[4]!.id, symbols[1]!.id, 'CALLS'), edge(symbols[1]!.id, symbols[4]!.id, 'DEPENDS_ON'),
    edge('a/one.ts', 'external://npm/x', 'IMPORTS'), edge('a/two.ts', 'external://npm/x', 'IMPORTS'),
    edge('a/one.ts', 'external://npm/y', 'IMPORTS'),
    edge('a/one.ts', 'test-id', 'TESTED_BY'), edge('a/one.ts', 'test-id', 'TESTED_BY'),
  ];
  const metrics = graphMetrics('snap', symbols, files, ['a', 'b'].map((path) => ({ id: path, path, name: path, repositoryId: 'repo', snapshotId: 'snap' })), edges);
  const value = (subjectId: string, name: string) => metrics.find((metric) => metric.subjectId === subjectId && metric.name === name)?.value;
  expect(value(symbols[0]!.id, 'fan_out')).toBe(1);
  expect(value(symbols[1]!.id, 'fan_in')).toBe(2);
  expect(value(symbols[0]!.id, 'file_test_links')).toBe(1);
  expect(value('a', 'coupling_in')).toBe(1);
  expect(value('a', 'coupling_out')).toBe(3);
  expect(value('a', 'instability')).toBe(0.75);
  expect(value('a', 'internal_dependency_edges')).toBe(1);
  expect(value('a', 'dependency_components')).toBe(3);
  expect(value('a', 'largest_component_ratio')).toBe(0.5);
});
