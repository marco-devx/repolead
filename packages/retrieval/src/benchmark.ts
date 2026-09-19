import type { KnowledgeStore } from '@repolead/knowledge-store';

import { buildContextPack } from './context';
import { readIndexedSource } from './source';
import { countTokens, TOKENIZER } from './tokens';

export interface TokenBenchmarkCase {
  name: string;
  symbols: string[];
  module?: string;
}

/** Reproducible context-size comparison. Does not call a model or measure answer quality. */
export function benchmarkTokens(store: KnowledgeStore, snapshotId: string, cases: TokenBenchmarkCase[], maxTokens = 2000) {
  if (cases.length === 0) {
    throw new Error('El benchmark necesita al menos un caso.');
  }
  const snapshot = store.db.prepare('SELECT repository_id, commit_sha FROM snapshots WHERE id = ?').get(snapshotId) as {
    repository_id: string; commit_sha: string;
  };
  const repo = store.getRepository(snapshot.repository_id)!;
  const symbols = store.listSymbols(snapshotId);
  const results = cases.map((entry) => {
    const pack = buildContextPack({ store, snapshotId, symbols: entry.symbols, module: entry.module, maxTokens, includeSource: true });
    const map = buildContextPack({ store, snapshotId, symbols: entry.symbols, module: entry.module, maxTokens });
    const targetIds = entry.symbols.map((name) => {
      const matches = symbols.filter((symbol) => symbol.id === name || symbol.qualifiedName === name);
      if (matches.length !== 1) {
        throw new Error('Usa IDs inequívocos en el benchmark: ' + name);
      }
      return matches[0]!.id;
    });
    const paths = [...new Set(targetIds.map((id) => symbols.find((symbol) => symbol.id === id)!.path))];
    const sourceContentHashes = Object.fromEntries(paths.map((path) => {
      const row = store.db.prepare('SELECT content_hash FROM files WHERE snapshot_id = ? AND path = ?')
        .get(snapshotId, path) as { content_hash: string };
      return [path, row.content_hash];
    }));
    const raw = paths.map((path) => {
      const source = readIndexedSource(store, snapshotId, repo.rootPath, path);
      return 'SOURCE ' + path + '\n' + source.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n');
    }).join('\n');
    const baselineTokens = countTokens(raw);
    const savedTokens = baselineTokens - pack.tokens;
    return {
      name: entry.name, symbols: entry.symbols, paths, sourceContentHashes, baselineTokens, contextTokens: pack.tokens,
      mapOnlyTokens: map.tokens, savedTokens,
      savingsPercent: Math.round(savedTokens / Math.max(1, baselineTokens) * 1000) / 10,
      completeTargetSources: targetIds.filter((id) => pack.sourceSymbolIds.includes(id)).length,
      requestedTargetSources: targetIds.length,
      includedSymbols: pack.symbolIds.length, candidateSymbols: pack.totalSymbols,
      sourceOmissions: pack.sourceOmissions.length,
    };
  });
  const baselineTokens = results.reduce((sum, entry) => sum + entry.baselineTokens, 0);
  const contextTokens = results.reduce((sum, entry) => sum + entry.contextTokens, 0);
  return {
    repository: repo.name, benchmarkVersion: 1, commit: snapshot.commit_sha, tokenizer: TOKENIZER, maxTokens, modelCalls: 0,
    measurement: 'Numbered source of the relevant files versus context_pack text including complete target source. Snapshot includes tracked working-tree contents; per-file hashes identify the measured revision. Excludes prompts, tool schemas/protocol overhead, reasoning, output tokens and provider cache/billing. Symbol targets are supplied; discovery cost and answer quality are not measured.',
    cases: results,
    totals: {
      baselineTokens, contextTokens, savedTokens: baselineTokens - contextTokens,
      mapOnlyTokens: results.reduce((sum, entry) => sum + entry.mapOnlyTokens, 0),
      savingsPercent: Math.round((baselineTokens - contextTokens) / Math.max(1, baselineTokens) * 1000) / 10,
      completeTargetSources: results.reduce((sum, entry) => sum + entry.completeTargetSources, 0),
      requestedTargetSources: results.reduce((sum, entry) => sum + entry.requestedTargetSources, 0),
    },
  };
}
