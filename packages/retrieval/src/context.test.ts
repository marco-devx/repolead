import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';

import { contentHash, fileUri, stableSymbolId } from '@repolead/domain';
import type { CodeSymbol } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

import { benchmarkTokens } from './benchmark';
import { buildContextPack } from './context';
import { readIndexedSource } from './source';
import { countTokens } from './tokens';

async function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'repolead-context-'));
  const root = join(temporary, 'repo');
  mkdirSync(root);
  const source = [
    'export function authorize(role: string) {',
    '  return role === "admin";',
    '}',
    ...Array.from({ length: 100 }, (_, index) => `export function utility${index}() { return ${index}; }`),
  ].join('\n');
  writeFileSync(join(root, 'app.ts'), source);
  writeFileSync(join(temporary, 'outside.txt'), 'harmless fixture outside');
  writeFileSync(join(root, 'unindexed.txt'), 'harmless unindexed fixture');
  symlinkSync(join(temporary, 'outside.txt'), join(root, 'escape.ts'));
  const store = await openStore(':memory:');
  const repo = store.upsertRepository({ name: 'fixture', rootPath: root });
  const snapshot = store.createSnapshot({ repositoryId: repo.id, commitSha: 'abc' });
  store.insertFiles([{ id: fileUri('fixture', 'app.ts'), repositoryId: repo.id, snapshotId: snapshot.id, path: 'app.ts',
    language: 'typescript', contentHash: contentHash(source), lineCount: 103, lastAuthor: null, lastCommitAt: null }]);
  const symbols: CodeSymbol[] = Array.from({ length: 101 }, (_, index) => ({
    id: stableSymbolId({ repository: 'fixture', path: 'app.ts', kind: 'function', qualifiedName: index === 0 ? 'authorize' : `utility${index - 1}` }),
    repositoryId: repo.id, snapshotId: snapshot.id, path: 'app.ts',
    qualifiedName: index === 0 ? 'authorize' : `utility${index - 1}`, kind: 'function',
    signature: index === 0 ? '(role: string)' : '()', startLine: index === 0 ? 1 : index + 3,
    endLine: index === 0 ? 3 : index + 3, contentHash: 'hash', source: 'tree-sitter',
  }));
  store.insertSymbols(symbols);
  store.insertEdges(symbols.slice(2).map((symbol) => ({ snapshotId: snapshot.id, sourceId: symbol.id, targetId: symbols[1]!.id,
    edgeType: 'CALLS' as const, confidence: 1, analyzer: 'fixture', evidence: null })));
  return { store, snapshot, root, temporary, symbols, source };
}

test('prioriza el símbolo solicitado sobre utilidades populares y entrega su código completo dentro del presupuesto', async () => {
  const { store, snapshot, root, temporary, symbols } = await fixture();
  try {
    const pack = buildContextPack({ store, snapshotId: snapshot.id, symbols: ['authorize'], maxTokens: 300, includeSource: true });
    expect(countTokens(pack.text)).toBe(pack.tokens);
    expect(pack.tokens).toBeLessThanOrEqual(300);
    expect(pack.symbolIds).toContain(symbols[0]!.id);
    expect(pack.sourceSymbolIds).toContain(symbols[0]!.id);
    expect(pack.text).toContain('return role === "admin";');
    expect(pack.text).not.toContain('utility99');
    const report = benchmarkTokens(store, snapshot.id, [{ name: 'authorization', symbols: ['authorize'] }], 300);
    expect(report.totals.completeTargetSources).toBe(1);
    expect(report.totals.savedTokens).toBeGreaterThan(0);
    writeFileSync(join(root, 'app.ts'), 'changed');
    const stale = buildContextPack({ store, snapshotId: snapshot.id, symbols: ['authorize'], maxTokens: 300, includeSource: true });
    expect(stale.sourceSymbolIds).toEqual([]);
    expect(stale.sourceOmissions).toHaveLength(1);
    expect(stale.text).toContain('stale');
  } finally {
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('el presupuesto cubre todo el texto, incluso omisiones y firmas grandes', async () => {
  const { store, snapshot, temporary, symbols } = await fixture();
  try {
    store.db.prepare('UPDATE symbols SET signature = ? WHERE id = ?').run('long'.repeat(2000), symbols[0]!.id);
    const pack = buildContextPack({ store, snapshotId: snapshot.id, maxTokens: 256 });
    expect(countTokens(pack.text)).toBeLessThanOrEqual(256);
    expect(pack.symbolIds.length).toBeLessThan(pack.totalSymbols);
    expect(pack.text).toContain('/101');
    const disabled = buildContextPack({ store, snapshotId: snapshot.id, symbols: ['authorize'], maxTokens: 256, includeSource: true, exposeSource: false });
    expect(disabled.sourceSymbolIds).toEqual([]);
    expect(disabled.text).not.toContain('return role');
  } finally {
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('la evidencia rechaza rutas externas, symlinks externos, archivos no indexados y fuentes obsoletas', async () => {
  const { store, snapshot, root, temporary } = await fixture();
  try {
    expect(() => readIndexedSource(store, snapshot.id, root, '../outside.txt')).toThrow('outside');
    expect(() => readIndexedSource(store, snapshot.id, root, 'escape.ts')).toThrow('outside');
    expect(() => readIndexedSource(store, snapshot.id, root, 'unindexed.txt')).toThrow('not indexed');
    expect(readIndexedSource(store, snapshot.id, root, 'app.ts')).toContain('authorize');
  } finally {
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
