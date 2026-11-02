import { expect, test } from '@rstest/core';
import { contentHash } from '@repolead/domain';

import { mutationPattern, normalizeMutationReport, probeStryker } from './index';
import type { MutationTarget } from './index';

const source = 'export function hot(x) { return x > 0; }\nexport function cold(x) { return x + 1; }\n';
const target: MutationTarget = { symbolId: 'hot', path: 'src/example.js', sourceHash: contentHash(source), startLine: 1, endLine: 1,
  startColumn: 0, endColumn: source.split('\n')[0]!.length };
const entry = (id: string, status = 'Killed', line = 1) => ({ id, status, mutatorName: 'EqualityOperator',
  location: { start: { line, column: 32 }, end: { line, column: 33 } }, replacement: 'PRIVATE_SOURCE', statusReason: 'PRIVATE_TEST_OUTPUT' });
const report = (mutants: ReturnType<typeof entry>[]) => ({ schemaVersion: '1', files: { [target.path]: { source, mutants } }, framework: { name: 'StrykerJS', version: '10.1.1' } });

test('Stryker normalization verifies source/ranges, calculates score and never retains source or test failure output', () => {
  const normalized = normalizeMutationReport(report([
    entry('1'), entry('2', 'Timeout'), entry('3', 'Survived'), entry('4', 'NoCoverage'),
    entry('5', 'CompileError'), entry('6', 'RuntimeError'), entry('7', 'Ignored'), entry('8', 'Pending'), entry('outside', 'Ignored', 2),
  ]), [target]);
  expect(normalized.mutationScore).toBe(50); expect(normalized.complete).toBe(false);
  expect(normalized.ignoredOutsideScope).toBe(1); expect(normalized.mutants).toHaveLength(8);
  expect(normalized.mutants.every((mutant) => mutant.symbolIds[0] === 'hot')).toBe(true);
  expect(JSON.stringify(normalized)).not.toContain('PRIVATE_'); expect(JSON.stringify(normalized)).not.toContain(source);
  expect(normalizeMutationReport(report([entry('1', 'CompileError')]), [target]).mutationScore).toBeNull();
});

test('unplanned/missing/stale files, out-of-range mutants and malformed status/positions are rejected', () => {
  for (const invalid of [
    { ...report([]), schemaVersion: '2' }, { ...report([]), files: {} },
    { ...report([]), files: { 'other.js': { source, mutants: [] } } },
    report([entry('1', 'Killed', 2)]), report([entry('1', 'Pending', 2)]), report([entry('1', 'Unknown')]),
    report([entry('1'), entry('1')]), report([{ ...entry('1'), location: { start: { line: 1, column: 100 }, end: { line: 1, column: 101 } } }]),
    report([{ ...entry('1'), location: { start: { line: 1, column: 3 }, end: { line: 1, column: 2 } } }]),
  ]) { expect(() => normalizeMutationReport(invalid, [target])).toThrow(); }
  expect(() => normalizeMutationReport(report([]), [{ ...target, sourceHash: 'stale' }])).toThrow('hash mismatch');
  expect(() => normalizeMutationReport(report([]), [])).toThrow('nonempty');
});

test('mutation selectors are literal exact ranges and an unavailable optional binary is explicit', async () => {
  expect(mutationPattern(target)).toBe(`src/example.js:1:0-1:${target.endColumn}`);
  for (const path of ['../src/a.js', '/tmp/a.js', 'src/*.js', 'src/a[0].js', 'src/a.js:1-2', '.hidden/a.js', 'src/\na.js']) {
    expect(() => mutationPattern({ ...target, path })).toThrow('literal');
  }
  for (const range of [{ startLine: 0 }, { startColumn: -1 }, { endLine: 0 }, { endColumn: 0 }]) {
    expect(() => mutationPattern({ ...target, ...range })).toThrow('range');
  }
  expect((await probeStryker({ REPOLEAD_STRYKER_BIN: '/repolead-does-not-exist/stryker' })).available).toBe(false);
});
