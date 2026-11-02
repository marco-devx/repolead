import type { SourceSpan } from './entities';

/** Exact AST span for modern snapshots; whole-line fallback for legacy data. */
export function sliceSource(content: string, range: { startLine: number; endLine: number; span?: SourceSpan }): string {
  if (!range.span) { return content.split('\n').slice(range.startLine - 1, range.endLine).join('\n'); }
  const { startOffset, endOffset } = range.span;
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || startOffset < 0 || endOffset < startOffset || endOffset > content.length) {
    throw new Error('Indexed source span is outside the stored file.');
  }
  return content.slice(startOffset, endOffset);
}
