import { expect, test } from '@rstest/core';
import type { CodeSymbol } from '@repolead/domain';

import { buildScipEdges } from './scip-enrich';

const text = 'const emoji = "🧠"; function hello() {} function use() { hello(); }';
const name = 'scip-typescript npm demo 0 hello().';
const definition = text.indexOf('hello');
const call = text.lastIndexOf('hello');
const byteOffset = (offset: number) => Buffer.byteLength(text.slice(0, offset));
const symbol = (qualifiedName: string): CodeSymbol => {
  const start = text.indexOf(`function ${qualifiedName}`);
  const end = text.indexOf('}', start) + 1;
  return { id: qualifiedName, qualifiedName, repositoryId: 'repo', snapshotId: 'snapshot', path: 'src/a.ts', kind: 'function', signature: null,
    startLine: 1, endLine: 1, contentHash: 'fixture', source: 'tree-sitter',
    span: { startOffset: start, endOffset: end, startColumn: start, endColumn: end } };
};

test('SCIP UTF8 ranges normalize to UTF16 and exact same-line owners', () => {
  const result = buildScipEdges({ relationships: [], documents: [{ relativePath: 'src/a.ts', positionEncoding: 'utf8', occurrences: [
    { symbol: name, isDefinition: true, startLine: 1, endLine: 1, startColumn: byteOffset(definition), endColumn: byteOffset(definition + 5) },
    { symbol: name, isDefinition: false, startLine: 1, endLine: 1, startColumn: byteOffset(call), endColumn: byteOffset(call + 5) },
  ] }] }, [symbol('hello'), symbol('use')], 'snapshot', new Map([['src/a.ts', { id: 'file', content: text,
    calls: [{ startLine: 1, endLine: 1, startColumn: call, endColumn: call + 5 }] }]]));
  expect(result.references[1]?.sourceId).toBe('use');
  expect(result.references[1]?.startColumn).toBe(call);
  expect(result.edges[0]?.edgeType).toBe('CALLS');
});

test('ambiguous definition matches produce diagnostics instead of inventing a reference edge', () => {
  const result = buildScipEdges({ relationships: [], documents: [{ relativePath: 'src/a.ts', positionEncoding: 'utf16', occurrences: [
    { symbol: name, isDefinition: true, startLine: 1, endLine: 1, startColumn: definition, endColumn: definition + 5 },
  ] }] }, [symbol('hello'), { ...symbol('hello'), id: 'duplicate' }], 'snapshot');
  expect(result.unmappedDefinitions).toBe(1);
  expect(result.diagnostics[0]?.reason).toContain('ambiguous');
  expect(result.references).toEqual([]);
  expect(result.edges).toEqual([]);
});
