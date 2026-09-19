import type { CodeSymbol } from '@repolead/domain';
import type { CodeGraph } from '@repolead/knowledge-store';

function words(text: string): Set<string> {
  return new Set(text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/** Personalized graph ranking inspired by Aider's repo map; independent implementation. */
export function rankSymbols(
  graph: CodeGraph,
  query = '',
  seeds: ReadonlySet<string> = new Set(),
): CodeSymbol[] {
  const symbols = [...graph.symbols.values()];
  if (symbols.length === 0) {
    return [];
  }
  const terms = words(query);
  const preference = new Map<string, number>();
  const direct = new Map<string, number>();
  let total = 0;
  for (const symbol of symbols) {
    const tokens = words(`${symbol.qualifiedName} ${symbol.path} ${symbol.signature ?? ''}`);
    const matches = [...terms].filter((term) => tokens.has(term)).length;
    const exact = query !== '' && symbol.qualifiedName.toLowerCase() === query.toLowerCase();
    const relevance = (seeds.has(symbol.id) ? 20 : 0) + (exact ? 10 : 0) + matches;
    direct.set(symbol.id, relevance);
    const weight = 1 + relevance * 10 + (symbol.kind === 'endpoint' ? 2 : 0);
    preference.set(symbol.id, weight);
    total += weight;
  }
  for (const [id, weight] of preference) {
    preference.set(id, weight / total);
  }
  // Ignore structural CONTAINS edges: they do not establish that code is called.
  const neighbors = new Map<string, Set<string>>();
  for (const symbol of symbols) {
    neighbors.set(symbol.id, new Set((graph.outgoing.get(symbol.id) ?? [])
      .filter((edge) => edge.edgeType !== 'CONTAINS' && graph.symbols.has(edge.targetId))
      .map((edge) => edge.targetId)));
  }
  let ranks = new Map(preference);
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const next = new Map([...preference].map(([id, weight]) => [id, weight * 0.15]));
    let dangling = 0;
    for (const [id, targets] of neighbors) {
      const mass = 0.85 * (ranks.get(id) ?? 0);
      if (targets.size === 0) {
        dangling += mass;
      } else {
        for (const target of targets) {
          next.set(target, (next.get(target) ?? 0) + mass / targets.size);
        }
      }
    }
    for (const [id, weight] of preference) {
      next.set(id, (next.get(id) ?? 0) + dangling * weight);
    }
    ranks = next;
  }
  return symbols.sort((left, right) =>
    (direct.get(right.id) ?? 0) - (direct.get(left.id) ?? 0) ||
    (ranks.get(right.id) ?? 0) - (ranks.get(left.id) ?? 0) ||
    left.path.localeCompare(right.path) || left.startLine - right.startLine);
}
