import { expect, test } from '@rstest/core';

import { createParser } from './index';
import { measureSyntax } from './metrics';

test('AST metrics exclude comments, strings and nested callable scopes from decisions', async () => {
  const parser = await createParser('typescript');
  const tree = parser.parse(`// if (fake) throw 1;
function sample(n: number, ok: boolean) {
  const url = "https://example.test//not-comment";
  if (ok && n > 0) {
    for (let i = 0; i < n; i++) {
      if (i % 2) continue;
    }
  } else if (!ok) { return 0; }
  try { work(); } catch (error) { /* intentionally empty */ }
  function inner() { if (n) return 1; return 0; }
  return n ? 1 : 0;
}
`)!;
  try {
    const root = measureSyntax(tree.rootNode, false);
    expect(root).toEqual({ loc: 12, loc_code: 11, loc_blank: 0, loc_comments: 1 });
    const fn = tree.rootNode.namedChildren.find((node) => node?.type === 'function_declaration')!;
    const metric = measureSyntax(fn, true);
    expect(metric['cyclomatic_complexity']).toBe(8);
    expect(metric['max_nesting']).toBe(3);
    expect(metric['empty_catches']).toBe(1);
  } finally { tree.delete(); parser.delete(); }
});

test('Python booleans/except/pass are counted and nested functions remain independent', async () => {
  const parser = await createParser('python');
  const tree = parser.parse('def f(a, b):\n    if a and b:\n        try:\n            work()\n        except Exception:\n            pass\n    def inner():\n        if a: return 1\n    return 0\n')!;
  try {
    const metric = measureSyntax(tree.rootNode.namedChildren[0]!, true);
    expect(metric['cyclomatic_complexity']).toBe(4);
    expect(metric['empty_catches']).toBe(1);
    expect(metric['max_nesting']).toBe(2);
  } finally { tree.delete(); parser.delete(); }
});

test('cognitive nesting is explicit and malformed callables do not get fabricated complexity', async () => {
  const parser = await createParser('typescript');
  const valid = parser.parse('function f(a: boolean, b: boolean) { if (a) { if (b) return 1; } return 0; }')!;
  const invalid = parser.parse('function f() { if (')!;
  try {
    expect(measureSyntax(valid.rootNode.namedChildren[0]!, true)).toMatchObject({ cyclomatic_complexity: 3, cognitive_complexity_estimate: 3, max_nesting: 2 });
    expect(measureSyntax(invalid.rootNode, true)['cyclomatic_complexity']).toBeUndefined();
  } finally { valid.delete(); invalid.delete(); parser.delete(); }
});
