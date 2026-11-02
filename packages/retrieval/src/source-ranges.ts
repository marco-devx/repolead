import { contentHash, DEFAULT_CONTEXT_TOKENS } from '@repolead/domain';
import { countTokens, TOKENIZER, validateTokenBudget } from './tokens';

export interface SourceRange { path: string; startLine?: number; endLine?: number }

/** One global budget, including provenance and continuation metadata, for several reads. */
export function buildSourceRanges(options: {
  snapshotId: string; ranges: SourceRange[]; maxTokens?: number; read: (path: string) => string;
}): { text: string; tokens: number } {
  const budget = validateTokenBudget(options.maxTokens ?? DEFAULT_CONTEXT_TOKENS);
  if (options.ranges.length < 1 || options.ranges.length > 20) { throw new Error('Request between 1 and 20 ranges.'); }
  const entries = options.ranges.map((range) => {
    const start = range.startLine ?? 1;
    if (!Number.isInteger(start) || start < 1 || (range.endLine !== undefined && (!Number.isInteger(range.endLine) || range.endLine < start))) {
      throw new Error('Invalid source range: require 1 <= startLine <= endLine.');
    }
    try {
      const source = options.read(range.path);
      const lines = source.split('\n');
      if (start > lines.length) { throw new Error(`startLine exceeds file length (${lines.length}).`); }
      const end = Math.min(range.endLine ?? lines.length, lines.length);
      return { path: range.path, start, end, total: lines.length, hash: contentHash(source),
        lines: lines.slice(start - 1, end).map((line, i) => `${start + i}\t${line}`), included: 0, error: '' };
    } catch (error) {
      return { path: range.path, start, end: start - 1, total: 0, hash: '', lines: [] as string[], included: 0,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
    }
  });
  const render = () => [
    `RepoLead source @${options.snapshotId}; budget ${budget} ${TOKENIZER} (proxy). Ranges are served in request order.`,
    ...entries.map((entry) => entry.error ? `UNAVAILABLE ${JSON.stringify(entry.path)}: ${entry.error}` : [
      `SOURCE ${JSON.stringify(entry.path)}:${entry.start}-${entry.end} (${entry.total} file lines; sha256 ${entry.hash})`,
      ...entry.lines.slice(0, entry.included),
      entry.included === entry.lines.length ? '[complete requested range]' : `[omitted lines; continue startLine=${entry.start + entry.included}, endLine=${entry.end}; increase maxTokens or request fewer ranges]`,
    ].join('\n')),
  ].join('\n');
  if (countTokens(render()) > budget) { throw new Error('Range metadata exceeds maxTokens; increase budget or request fewer ranges.'); }
  for (const entry of entries) {
    entry.included = entry.lines.length;
    if (countTokens(render()) <= budget) { continue; }
    let low = 0; let high = entry.lines.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2); entry.included = mid;
      if (countTokens(render()) <= budget) { low = mid; } else { high = mid - 1; }
    }
    entry.included = low;
    // BPE boundaries are not strictly monotone; enforce the budget after the search.
    while (entry.included > 0 && countTokens(render()) > budget) { entry.included -= 1; }
  }
  const text = render();
  if (countTokens(text) > budget) { throw new Error('Source response exceeds maxTokens.'); }
  return { text, tokens: countTokens(text) };
}
