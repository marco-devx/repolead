import { expect, test } from '@rstest/core';
import { buildSourceRanges } from './source-ranges';
import { countTokens, validateTokenBudget } from './tokens';

test('120K default serves more than the former 64K ceiling while still bounding oversized source', () => {
  const source = Array.from({ length: 15000 }, (_, i) => `const item${i} = compute(${i}, "some indexed source text");`).join('\n');
  const result = buildSourceRanges({ snapshotId: 's', ranges: [{ path: 'large.ts' }], read: () => source });
  expect(result.tokens).toBeGreaterThan(64000);
  expect(result.tokens).toBeLessThanOrEqual(120000);
  expect(result.text).toContain('budget 120000');
  expect(result.text).toContain('continue startLine=');
  expect(validateTokenBudget(120000)).toBe(120000);
  expect(() => validateTokenBudget(120001)).toThrow();
});

test('batch includes complete long ranges and all metadata within one budget', () => {
  const files = { 'long.ts': Array.from({ length: 350 }, (_, i) => `const value${i} = ${i};`).join('\n'), 'short.ts': 'export const answer = 42;' };
  const read = (path: string) => { if (!(path in files)) { throw new Error('not indexed'); } return files[path as keyof typeof files]; };
  const complete = buildSourceRanges({ snapshotId: 'snapshot', ranges: [{ path: 'long.ts' }, { path: 'short.ts' }], maxTokens: 8000, read });
  expect(complete.text).toContain('350\tconst value349 = 349;');
  expect(complete.text.match(/complete requested range/g)).toHaveLength(2);
  expect(complete.tokens).toBe(countTokens(complete.text));
  expect(complete.tokens).toBeLessThanOrEqual(8000);
  const small = buildSourceRanges({ snapshotId: 'snapshot', ranges: [{ path: 'long.ts' }, { path: 'short.ts' }], maxTokens: 500, read });
  expect(small.tokens).toBeLessThanOrEqual(500);
  expect(small.text).toContain('continue startLine=');
  expect(small.text).toContain('"short.ts"');
  const unavailable = buildSourceRanges({ snapshotId: 'snapshot', ranges: [{ path: 'missing' }, { path: 'short.ts' }], maxTokens: 500, read });
  expect(unavailable.text).toContain('UNAVAILABLE "missing": not indexed');
  expect(unavailable.text).toContain('answer = 42');
  expect(() => buildSourceRanges({ snapshotId: 's', ranges: [{ path: 'long.ts', startLine: 5, endLine: 1 }], read })).toThrow('Invalid source range');
  const outside = buildSourceRanges({ snapshotId: 's', ranges: [{ path: 'long.ts', startLine: 999 }], read });
  expect(outside.text).toContain('exceeds file length');
});
