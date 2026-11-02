import { createHash } from 'node:crypto';

import { expect, test } from '@rstest/core';

import { normalizeLcov } from './coverage';
import { normalizeJscpd, normalizeRadon, normalizeRuff } from './normalize';

const context = { rootPath: '/repo', sources: new Map([
  ['a.ts', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n'],
  ['b.ts', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n'],
  ['calc.py', 'def f(n):\n    if n:\n        return n\n    return 0\n'],
]) };

test('clone line unions avoid double counting and foreign paths cannot match by basename', () => {
  const clone = (start: number, end: number, path = 'b.ts') => ({ firstFile: { name: 'a.ts', start, end },
    secondFile: { name: path, start, end }, lines: end - start + 1, tokens: 60 });
  const result = normalizeJscpd({ duplicates: [clone(1, 5), clone(3, 7), clone(1, 5, '/another/b.ts')], statistics: { total: { sources: 2 } } }, context);
  expect(result.issues).toHaveLength(2);
  expect(result.measurements.map((metric) => metric.value)).toEqual([7, 7]);
  expect(result.diagnostics).toHaveLength(1);
  expect(() => normalizeJscpd({}, context)).toThrow();
});

test('Ruff diagnostics preserve codes/ranges and invalid data cannot become a clean report', () => {
  const result = normalizeRuff([{ filename: '/repo/calc.py', code: 'F821', message: 'undefined name',
    location: { row: 2, column: 8 }, end_location: { row: 3, column: 1 } }], context);
  expect(result.issues[0]!.locations).toEqual([{ path: 'calc.py', startLine: 2, endLine: 2 }]);
  expect(result.measurements).toEqual([{ path: 'calc.py', name: 'lint_issues', value: 1 }]);
  expect(() => normalizeRuff({ error: 'failed' }, context)).toThrow();
});

test('Radon normalization retains tool measurements and exposes failed files', () => {
  const result = normalizeRadon({ 'calc.py': [{ type: 'function', name: 'f', lineno: 1, endline: 4, complexity: 2 }],
    'broken.py': { error: 'SyntaxError' } }, { 'calc.py': { loc: 4, lloc: 4, sloc: 4, comments: 0, multi: 0, blank: 0, single_comments: 0 } }, context);
  expect(result.measurements[0]).toEqual({ path: 'calc.py', name: 'cyclomatic_complexity', value: 2, symbol: { name: 'f', startLine: 1, endLine: 4 } });
  expect(result.diagnostics).toHaveLength(1);
});

test('LCOV merges test executions, derives rates and keeps missing files/branches unknown', () => {
  const result = normalizeLcov('TN:one\nSF:calc.py\nDA:2,1\nDA:3,0\nBRDA:2,0,0,1\nBRDA:2,0,1,-\nLF:2\nLH:1\nBRF:2\nBRH:1\nend_of_record\nTN:two\nSF:calc.py\nDA:2,1\nDA:3,2\nBRDA:2,0,0,1\nBRDA:2,0,1,2\nend_of_record\nSF:a.ts\nDA:1,0\nend_of_record', context);
  expect(result.diagnostics).toEqual([]);
  expect(result.coverage).toHaveLength(2);
  const py = result.coverage.find((record) => record.path === 'calc.py')!;
  expect(py.lineRate).toBe(1);
  expect(py.branchRate).toBe(1);
  expect(py.lines).toEqual([{ line: 2, hits: 2 }, { line: 3, hits: 2 }]);
  expect(py.provenance.sourceBinding).toBe('unverified');
  expect(result.coverage[0]!.branchRate).toBeNull();
  expect(result.coverage.find((record) => record.path === 'b.ts')).toBeUndefined();
});

test('LCOV verifies supplied line checksums, rejects stale ranges, and validates counts/records', () => {
  const checksum = createHash('md5').update('    if n:').digest('base64').replace(/=+$/, '');
  const valid = normalizeLcov(`SF:calc.py\nDA:2,1,${checksum}\nend_of_record`, context);
  expect(valid.coverage[0]!.provenance.sourceBinding).toBe('reported-lines-verified');
  const mixed = normalizeLcov(`SF:calc.py\nDA:2,1,${checksum}\nend_of_record\nSF:calc.py\nDA:2,2\nend_of_record`, context);
  expect(mixed.coverage[0]!.provenance.sourceBinding).toBe('unverified');
  const invalidLaterRecord = normalizeLcov('SF:calc.py\nDA:2,1\nend_of_record\nSF:calc.py\nDA:20,1\nend_of_record', context);
  expect(invalidLaterRecord.coverage).toEqual([]);
  for (const text of ['SF:calc.py\nDA:2,1,bad\nend_of_record', 'SF:calc.py\nDA:20,1\nend_of_record',
    'SF:/foreign/calc.py\nDA:2,1\nend_of_record']) {
    const invalid = normalizeLcov(text, context);
    expect(invalid.coverage).toEqual([]); expect(invalid.diagnostics).toHaveLength(1);
  }
  for (const text of ['SF:calc.py\nDA:2,1', 'SF:calc.py\nDA:2,-1\nend_of_record',
    'SF:calc.py\nDA:2,1\nLF:4\nend_of_record']) { expect(() => normalizeLcov(text, context)).toThrow(); }
});
