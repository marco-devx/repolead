import type { HierarchicalPack } from './hierarchy';
import { contentHash } from '@repolead/domain';
export const EVIDENCE_ENCODING_VERSION = 'short-citations-v3';

/** Remove only server-owned cache hashes; source, claims and domain objects remain literal. */
function modelFacts(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return value; }
  const { contentHash: _contentHash, fingerprint: _fingerprint, ...facts } = value as Record<string, unknown>;
  const scope = facts['dependencyScope'];
  if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
    const { fingerprint: _scopeHash, ...visible } = scope as Record<string, unknown>;
    if (Array.isArray(visible['dependencies'])) {
      visible['dependencies'] = visible['dependencies'].map((dependency: unknown) => {
        if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) { return dependency; }
        const { contentHash: _hash, ...identity } = dependency as Record<string, unknown>;
        return identity;
      });
    }
    facts['dependencyScope'] = visible;
  }
  return facts;
}

/** Short, request-local citations. SQLite IDs and cache fingerprints remain unchanged. */
export function modelEvidence(pack: HierarchicalPack, schema: Record<string, unknown>, namespace?: string) {
  const originalText = JSON.stringify(pack);
  let prefix = namespace ? `E${contentHash(namespace).slice(0, 16)}_` : 'E';
  while (pack.evidence.some((_, index) => originalText.includes(`${prefix}${index + 1}`))) { prefix = `RL${prefix}`; }
  const aliases = new Map(pack.evidence.map((entry, index) => [entry.id, `${prefix}${index + 1}`]));
  const originals = new Map([...aliases].map(([id, alias]) => [alias, id]));
  const symbols = new Set<string>();
  const collectSymbols = (value: unknown): void => {
    if (!value || typeof value !== 'object') { return; }
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'id' || key === 'subjectId') && typeof item === 'string' && item.startsWith('sym_')) { symbols.add(item); }
      if (key === 'symbolIds' && Array.isArray(item)) { item.filter((id): id is string => typeof id === 'string').forEach((id) => symbols.add(id)); }
      if (Array.isArray(item)) { item.forEach(collectSymbols); } else { collectSymbols(item); }
    }
  };
  pack.evidence.forEach((entry) => collectSymbols(entry.facts));
  const visit = (value: unknown, ids: Map<string, string>, citationsOnly: boolean): unknown => {
    if (Array.isArray(value)) { return value.map((entry) => visit(entry, ids, citationsOnly)); }
    if (citationsOnly && typeof value === 'string') {
      return value.replace(new RegExp(`\\b${prefix}[0-9]+\\b`, 'g'), (id) => ids.get(id) ?? id);
    }
    if (!value || typeof value !== 'object') { return value; }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key === 'evidenceIds' && Array.isArray(item)) { return [key, item.map((id: unknown) => typeof id === 'string' ? ids.get(id) ?? id : id)]; }
      if (!citationsOnly && key === 'id' && typeof item === 'string' && ids.has(item)) { return [key, ids.get(item)]; }
      return [key, visit(item, ids, citationsOnly)];
    }));
  };
  const { fingerprint: _fingerprint, ...visible } = pack;
  const short = visit({ ...visible, evidence: pack.evidence.map((entry) => ({ ...entry, facts: modelFacts(entry.facts) })) }, aliases, false) as Omit<HierarchicalPack, 'fingerprint'>;
  const constrain = (value: unknown): unknown => {
    if (Array.isArray(value)) { return value.map(constrain); }
    if (!value || typeof value !== 'object') { return value; }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => key === 'evidenceIds'
      ? [key, { ...(item as object), items: { $ref: '#/$defs/evidenceId' } }]
      : key === 'symbolIds' ? [key, symbols.size ? { ...(item as object), items: { $ref: '#/$defs/symbolId' } }
        : { ...(item as object), maxItems: 0 }] : [key, constrain(item)]));
  };
  const constrained = constrain(schema) as Record<string, unknown>;
  constrained['$defs'] = { ...((schema['$defs'] as object | undefined) ?? {}), evidenceId: aliases.size
    ? { type: 'string', enum: [...originals.keys()] } : { type: 'string' },
    ...(symbols.size ? { symbolId: { type: 'string', enum: [...symbols].sort() } } : {}) };
  return { pack: short, schema: constrained, expand: (json: unknown) => visit(json, originals, true) };
}
