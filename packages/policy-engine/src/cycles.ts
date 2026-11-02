/** Iterative DFS; returns a real closed path for each discovered back edge. */
export function directedCycles(edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const state = new Map<string, 'active' | 'done'>();
  const cycles: string[][] = [];
  const seen = new Set<string>();
  for (const root of [...edges.keys()].sort()) {
    if (state.has(root)) { continue; }
    const stack: { node: string; targets: string[]; index: number }[] = [];
    const positions = new Map<string, number>();
    const push = (node: string) => { positions.set(node, stack.length); state.set(node, 'active'); stack.push({ node, targets: [...(edges.get(node) ?? [])].sort(), index: 0 }); };
    push(root);
    while (stack.length) {
      const frame = stack.at(-1)!;
      const target = frame.targets[frame.index++];
      if (target === undefined) { state.set(frame.node, 'done'); positions.delete(frame.node); stack.pop(); continue; }
      if (!state.has(target)) { push(target); continue; }
      if (state.get(target) !== 'active') { continue; }
      const path = stack.slice(positions.get(target)!).map((entry) => entry.node);
      if (path.length < 2) { continue; }
      const first = path.reduce((index, node, at) => node < path[index]! ? at : index, 0);
      const canonical = [...path.slice(first), ...path.slice(0, first)];
      const key = JSON.stringify(canonical);
      if (!seen.has(key)) { seen.add(key); cycles.push([...canonical, canonical[0]!]); }
    }
  }
  return cycles.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
