import { expect, test } from '@rstest/core';
import { normalizeJoernReport, probeJoern, runJoern } from './index';

test('Joern nodes must belong to captured files and valid source lines; normalized reports omit code', () => {
  const files = [{ path: 'src/a.js', source: 'function a(value) { return value; }\n' }];
  const raw = { version: 1, sourceCount: 1, sinkCount: 1, truncated: false, paths: [[{ path: '/captured/src/a.js', line: 1, kind: 'IDENTIFIER' }]] };
  const report = normalizeJoernReport(raw, files, '/captured');
  expect(report.paths[0]![0]!.path).toBe('src/a.js'); expect(report.paths[0]![0]!.sourceHash).toHaveLength(64);
  expect(JSON.stringify(report)).not.toContain('return value');
  expect(() => normalizeJoernReport({ ...raw, paths: [[{ path: '../other.js', line: 1, kind: 'IDENTIFIER' }]] }, files, '/captured')).toThrow();
  expect(() => normalizeJoernReport({ ...raw, paths: [[{ path: 'src/a.js', line: 999, kind: 'IDENTIFIER' }]] }, files, '/captured')).toThrow();
  expect(() => normalizeJoernReport({ ...raw, paths: [[{ path: 'src/a.js', line: 0, kind: 'IDENTIFIER' }]] }, files, '/captured')).toThrow();
});

test('missing optional Joern and unsafe or unbounded requests fail explicitly', async () => {
  expect((await probeJoern({ REPOLEAD_JOERN_BIN: '/missing/joern' })).available).toBe(false);
  const query = { sourceMethod: 'entry', sinkCall: 'sink', language: 'javascript' as const, files: [{ path: 'a.js', source: '' }] };
  await expect(runJoern({ ...query, maxPaths: 1000 })).rejects.toThrow('bounds');
  await expect(runJoern({ ...query, files: [{ path: '../outside.js', source: '' }] })).rejects.toThrow('Unsafe');
  await expect(runJoern({ ...query, env: { REPOLEAD_JOERN_BIN: '/missing/joern' } })).rejects.toThrow();
});
