import { expect, test } from '@rstest/core';

import { directedCycles } from './cycles';

test('cycle witnesses close real paths across any number of modules and ignore DAG cross edges', () => {
  const edges = new Map([
    ['A', new Set(['B', 'D'])], ['B', new Set(['C'])], ['C', new Set(['A'])], ['D', new Set(['C'])],
    ['E', new Set(['F'])], ['F', new Set(['G'])], ['G', new Set(['F'])], ['H', new Set(['H'])],
  ]);
  const cycles = directedCycles(edges);
  expect(cycles).toEqual([['A', 'B', 'C', 'A'], ['F', 'G', 'F']]);
  for (const cycle of cycles) {
    for (let index = 0; index < cycle.length - 1; index += 1) { expect(edges.get(cycle[index]!)!.has(cycle[index + 1]!)).toBe(true); }
  }
  expect(directedCycles(new Map([['A', new Set(['B', 'C'])], ['B', new Set(['C'])]]))).toEqual([]);
});

test('long cycles are handled without recursive stack overflow and canonicalize insertion order', () => {
  const count = 12000;
  const edges = new Map(Array.from({ length: count }, (_, index) => [String(index).padStart(5, '0'), new Set([String((index + 1) % count).padStart(5, '0')]) ] as const));
  expect(directedCycles(edges)[0]).toHaveLength(count + 1);
  const small = new Map([['C', new Set(['A'])], ['B', new Set(['C'])], ['A', new Set(['B'])]]);
  expect(directedCycles(small)).toEqual([['A', 'B', 'C', 'A']]);
});
