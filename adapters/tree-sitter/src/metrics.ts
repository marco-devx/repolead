import type { Node } from 'web-tree-sitter';

export const SYNTAX_METRICS_ANALYZER = 'tree-sitter-metrics-v1';
const functions = new Set(['function_declaration', 'generator_function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'function_definition', 'lambda']);
const branches = new Set(['if_statement', 'elif_clause', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'catch_clause', 'except_clause', 'conditional_expression', 'ternary_expression', 'for_in_clause', 'if_clause']);
const cases = new Set(['switch_case', 'case_clause']);
const children = (node: Node) => node.namedChildren.filter((entry): entry is Node => entry !== null);

/** Physical source lines, excluding AST comment spans rather than regex-matching strings. */
export function sourceLineMetrics(node: Node): Record<string, number> {
  const source = node.text;
  const pieces: string[] = [];
  const comments: Node[] = [];
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.type === 'comment') { comments.push(current); }
    else { stack.push(...children(current)); }
  }
  let offset = 0;
  for (const comment of comments.sort((a, b) => a.startIndex - b.startIndex)) {
    const start = comment.startIndex - node.startIndex;
    const end = comment.endIndex - node.startIndex;
    pieces.push(source.slice(offset, start), source.slice(start, end).replace(/[^\r\n]/g, ' '));
    offset = end;
  }
  pieces.push(source.slice(offset));
  const lines = (text: string) => text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  const original = lines(source);
  const code = lines(pieces.join(''));
  const locBlank = original.filter((line) => !line.trim()).length;
  const locCode = code.filter((line) => Boolean(line.trim())).length;
  return { loc: original.length, loc_code: locCode, loc_blank: locBlank, loc_comments: original.length - locBlank - locCode };
}

/** RepoLead's documented AST metric, not a claim of byte-for-byte Sonar/Radon equivalence. */
export function measureSyntax(node: Node, callable: boolean): Record<string, number> {
  const result = sourceLineMetrics(node);
  if (!callable || node.hasError) { return result; }
  let root = node;
  const value = node.childForFieldName('value');
  if (value && functions.has(value.type)) { root = value; }
  if (!root.childForFieldName('body')) { return result; }
  let cyclomatic = 1;
  let cognitive = 0;
  let maxNesting = 0;
  let emptyCatches = 0;
  const logical = (item: Node | null) => item?.childForFieldName('operator')?.text ?? '';
  const visit = (current: Node, nesting: number): void => {
    if (current.id !== root.id && functions.has(current.type)) { return; }
    const type = current.type;
    const decision = branches.has(type);
    const isSwitch = type === 'switch_statement' || type === 'match_statement';
    if (decision) { cyclomatic += 1; cognitive += 1 + nesting; }
    if (isSwitch) { cognitive += 1 + nesting; }
    if (cases.has(type) && !/^case\s+_\s*:/.test(current.text)) { cyclomatic += 1; }
    if (type === 'assert_statement' || type === 'with_statement') { cyclomatic += 1; }
    if (type === 'else_clause') { cognitive += 1; }
    const operator = logical(current);
    if (['&&', '||', '??', 'and', 'or'].includes(operator)) {
      cyclomatic += 1;
      if (logical(current.parent) !== operator) { cognitive += 1; }
    }
    if ((type === 'break_statement' || type === 'continue_statement') && current.childForFieldName('label')) { cognitive += 1; }
    if (type === 'catch_clause' || type === 'except_clause') {
      const body = current.childForFieldName('body') ?? children(current).find((child) => child.type === 'block');
      if (body && children(body).every((child) => ['comment', 'pass_statement', 'empty_statement'].includes(child.type))) { emptyCatches += 1; }
    }
    const nextNesting = nesting + Number(decision || isSwitch);
    maxNesting = Math.max(maxNesting, nextNesting);
    for (const child of children(current)) {
      const elseIf = child.type === 'elif_clause' || (child.type === 'else_clause' && children(child).some((entry) => entry.type === 'if_statement'));
      visit(child, elseIf ? nesting : nextNesting);
    }
  };
  visit(root, 0);
  return { ...result, cyclomatic_complexity: cyclomatic, cognitive_complexity_estimate: cognitive,
    max_nesting: maxNesting, empty_catches: emptyCatches };
}
