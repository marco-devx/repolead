import { createParser } from '@repolead/adapter-tree-sitter';
import type { Node, Tree } from '@repolead/adapter-tree-sitter';
import { sliceSource } from '@repolead/domain';
import type { CodeSymbol } from '@repolead/domain';
import { countTokens } from './tokens';

const STOP = new Set('the and that with from for this into what when does how que para como con del los las por una los source code function file implementation'.split(' '));
export function evidenceTerms(text: string): string[] {
  return [...new Set(text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2 && !STOP.has(word)))];
}
function relevance(text: string, terms: string[]): number {
  const words = evidenceTerms(text);
  return terms.filter((term) => words.some((word) => word === term || (Math.min(word.length, term.length) >= 4 && (word.startsWith(term) || term.startsWith(word))))).length;
}
const statements = new Set(['lexical_declaration', 'variable_declaration', 'function_declaration', 'function_definition', 'method_definition',
  'class_declaration', 'class_definition', 'type_alias_declaration', 'interface_declaration', 'enum_declaration', 'export_statement']);
const guards = new Set(['if_statement', 'elif_clause', 'else_clause', 'for_statement', 'for_in_statement', 'while_statement',
  'do_statement', 'try_statement', 'catch_clause', 'except_clause', 'finally_clause', 'with_statement', 'switch_statement', 'switch_case', 'case_clause']);
const children = (node: Node): Node[] => node.namedChildren.filter((child): child is Node => child !== null);
type Range = { start: number; end: number };
export interface SourceExcerpt { text: string; complete: boolean; ranges: Range[]; omittedLines: number }

/** Select complete AST statements, retaining enclosing headers and small earlier exit guards.
 * This is a quotation, not a program slice: omitted code can still change its meaning. */
export async function sourceDocument(path: string, source: string) {
  let tree: Tree | null = null;
  const grammar = /\.py$/.test(path) ? 'python' : /\.[jt]sx$/.test(path) ? 'tsx' : /\.[cm]?[jt]s$/.test(path) ? 'typescript' : null;
  if (grammar) {
    const parser = await createParser(grammar);
    try { tree = parser.parse(source); } finally { parser.delete(); }
  }
  const lines = source.split('\n');
  const render = (ranges: Range[]): { text: string; ranges: Range[] } => {
    const merged: Range[] = [];
    for (const range of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
      const last = merged.at(-1);
      if (last && range.start <= last.end + 1) { last.end = Math.max(last.end, range.end); }
      else { merged.push({ ...range }); }
    }
    return { ranges: merged, text: merged.map((range) => lines.slice(range.start - 1, range.end).map((line, i) => `${range.start + i}\t${line}`).join('\n')).join('\n[... omitted source lines ...]\n') };
  };
  const nodeRange = (node: Node): Range => ({ start: node.startPosition.row + 1, end: node.endPosition.row + 1 });
  const extract = (symbol: Pick<CodeSymbol, 'startLine' | 'endLine' | 'span'>, query: string, budget: number): SourceExcerpt => {
    const full = sliceSource(source, symbol).split('\n').map((line, i) => `${symbol.startLine + i}\t${line}`).join('\n');
    if (countTokens(full) <= budget) { return { text: full, complete: true, ranges: [{ start: symbol.startLine, end: symbol.endLine }], omittedLines: 0 }; }
    const terms = evidenceTerms(query); const candidates: Node[] = [];
    const visit = (node: Node) => {
      if (node.endPosition.row + 1 < symbol.startLine || node.startPosition.row + 1 > symbol.endLine) { return; }
      const inside = node.startPosition.row + 1 >= symbol.startLine && node.endPosition.row + 1 <= symbol.endLine;
      if (inside && (statements.has(node.type) || node.type.endsWith('_statement')) && countTokens(node.text) <= Math.min(340, Math.floor(budget * 0.75))) {
        candidates.push(node); return;
      }
      for (const child of children(node)) { visit(child); }
    };
    if (tree && !tree.rootNode.hasError) { visit(tree.rootNode); }
    if (!candidates.length) { return { text: '', ranges: [], complete: false, omittedLines: symbol.endLine - symbol.startLine + 1 }; }
    const density = (node: Node) => relevance(node.text, terms) / Math.sqrt(24 + countTokens(node.text));
    candidates.sort((a, b) => density(b) - density(a) || a.startIndex - b.startIndex);
    const selected: Range[] = [{ start: symbol.startLine, end: symbol.startLine }];
    let selectedStatements = 0;
    for (const node of candidates) {
      if (relevance(node.text, terms) === 0) { continue; }
      const extra = [nodeRange(node)];
      let current: Node | null = node;
      while (current?.parent && current.parent.startPosition.row + 1 >= symbol.startLine) {
        const parent: Node = current.parent;
        if (guards.has(parent.type) || /function|method/.test(parent.type)) {
          const body = parent.childForFieldName('body') ?? parent.childForFieldName('consequence') ?? children(parent).find((child) => child.type === 'statement_block' || child.type === 'block');
          if (body && body.startPosition.row - parent.startPosition.row < 30) { extra.push({ start: parent.startPosition.row + 1, end: body.startPosition.row + 1 }); }
        }
        if (parent.type === 'statement_block' || parent.type === 'block') {
          for (const sibling of children(parent)) {
            if (sibling.startIndex >= current.startIndex) { break; }
            if (/(?:\breturn\b|\bthrow\b|\braise\b)/.test(sibling.text) && countTokens(sibling.text) <= 150) { extra.push(nodeRange(sibling)); }
          }
        }
        current = parent;
      }
      const proposal = render([...selected, ...extra]);
      if (countTokens(proposal.text) <= budget) { selected.push(...extra); selectedStatements += 1; }
    }
    let result = render(selected);
    if (!selectedStatements || countTokens(result.text) > budget) { result = { text: '', ranges: [] }; }
    return { ...result, complete: false, omittedLines: symbol.endLine - symbol.startLine + 1 - result.ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0) };
  };
  const declarations = (query: string, budget: number): string => {
    if (!tree || tree.rootNode.hasError) { return ''; }
    const terms = evidenceTerms(query); const ranges: Range[] = [];
    const ranked = children(tree.rootNode).sort((a, b) => relevance(b.text, terms) - relevance(a.text, terms) || a.startIndex - b.startIndex);
    for (const node of ranked) {
      const declaration = node.type === 'export_statement' ? children(node)[0] ?? node : node;
      if (!['lexical_declaration', 'variable_declaration', 'import_statement', 'import_from_statement', 'import_declaration'].includes(declaration.type)) { continue; }
      if (relevance(node.text, terms) === 0 || /arrow_function|function_expression/.test(children(declaration).map((child) => child.childForFieldName('value')?.type).join(' '))) { continue; }
      const next = [...ranges, nodeRange(node)];
      if (countTokens(render(next).text) <= budget) { ranges.push(nodeRange(node)); }
    }
    return render(ranges).text;
  };
  return { extract, declarations, close: () => tree?.delete() };
}
