import type { SummaryDoc } from '@repolead/domain';
import { countTokens, validateTokenBudget } from '@repolead/retrieval';

import { evidenceEntry, fitHierarchyPack, summaryEntries } from './hierarchy';
import type { EvidenceEntry, HierarchicalPack } from './hierarchy';

export type PackedAnalysis = ReturnType<typeof fitHierarchyPack>;
export interface PacketLimits { maxTokens: number; maxBytes: number }

export function packetLimits(maxTokens: number, maxBytes = 24000): PacketLimits {
  validateTokenBudget(maxTokens);
  if (!Number.isInteger(maxBytes) || maxBytes < 4096 || maxBytes > 100000) {
    throw new Error('filePackBytes must be an integer between 4096 and 100000.');
  }
  return { maxTokens, maxBytes };
}

export function packetFits(input: PackedAnalysis, limits: PacketLimits): boolean {
  const text = JSON.stringify(input.pack);
  return input.pack.truncation.omittedEvidence === 0
    && Buffer.byteLength(text, 'utf8') <= limits.maxBytes && countTokens(text) <= limits.maxTokens;
}

/** Keep each child together when possible, without repeating citation hashes for every field. */
export function synthesisEntries(children: { summary: SummaryDoc; path: string }[], limits: PacketLimits): EvidenceEntry[] {
  return children.flatMap((child) => {
    const parts = summaryEntries([child]);
    const entry = evidenceEntry(child.summary.level, child.path, { subjectId: child.summary.subjectId,
      fingerprint: child.summary.contentHash,
      sections: parts.map((part) => {
        const { section, index, value } = part.facts as { section: string; index: number; value: unknown };
        return { section, index, value };
      }) }, { parentIds: [...new Set(parts.flatMap((part) => part.record.parentIds))].sort() });
    // Leave headroom for the receiving subject and options, otherwise retain individually bounded sections.
    return Buffer.byteLength(JSON.stringify(entry), 'utf8') < limits.maxBytes / 2 ? [entry] : parts;
  });
}

/** One bounded reduction round. Never summarizes its own outputs or builds a global dossier. */
export async function synthesizeFirstRound(
  subject: HierarchicalPack['subject'], entries: EvidenceEntry[], limits: PacketLimits,
  run: (input: PackedAnalysis) => Promise<SummaryDoc>,
  options: Parameters<typeof fitHierarchyPack>[3] = {},
  onPlan?: (groups: number) => void,
): Promise<SummaryDoc[]> {
  // Match the historical first-round packets exactly so existing successful work stays cached.
  const uncertaintyCount = (facts: unknown): number => {
    if (!facts || typeof facts !== 'object') { return 0; }
    const value = facts as { section?: string; value?: unknown; sections?: unknown[] };
    return (value.section === 'unknowns' && typeof value.value === 'string' ? 1 : 0)
      + (value.sections ?? []).reduce<number>((count, section) => count + uncertaintyCount(section), 0);
  };
  const uncertain = entries.reduce((count, entry) => count + uncertaintyCount(entry.facts), 0);
  const notes = { ...options, unknowns: [...(options.unknowns ?? []), ...(uncertain
    ? [`${uncertain} child uncertainty entries are retained in detailed dossiers; do not treat unverified behavior as established.`] : [])] };
  const groups: EvidenceEntry[][] = [];
  let group: EvidenceEntry[] = [];
  for (const entry of entries) {
    if (packetFits(fitHierarchyPack(subject, [...group, entry], limits.maxTokens, notes), limits)) {
      group.push(entry); continue;
    }
    if (group.length) { groups.push(group); group = []; }
    if (!packetFits(fitHierarchyPack(subject, [entry], limits.maxTokens, notes), limits)) {
      throw new Error(`Evidence at ${entry.record.path} cannot fit a first-round ${subject.level} packet. Increase file_pack_bytes/max_tokens. No evidence was silently dropped.`);
    }
    group.push(entry);
  }
  if (group.length) { groups.push(group); }
  onPlan?.(groups.length);
  const summaries: SummaryDoc[] = [];
  for (const [index, chunk] of groups.entries()) {
    summaries.push(await run(fitHierarchyPack({ ...subject, id: `${subject.id}#synthesis:0:${index + 1}`,
      name: `${subject.name} [síntesis 1.${index + 1}]` }, chunk, limits.maxTokens, notes)));
  }
  return summaries;
}

/** Every entry is consumed. Large hierarchies are reduced through cached intermediate dossiers. */
export async function synthesizeComplete(
  subject: HierarchicalPack['subject'], entries: EvidenceEntry[], limits: PacketLimits,
  run: (input: PackedAnalysis) => Promise<SummaryDoc>,
  options: Parameters<typeof fitHierarchyPack>[3] = {},
): Promise<SummaryDoc> {
  const uncertaintyCount = (facts: unknown): number => {
    if (!facts || typeof facts !== 'object') { return 0; }
    const value = facts as { section?: string; value?: unknown; sections?: unknown[] };
    return (value.section === 'unknowns' && typeof value.value === 'string' ? 1 : 0)
      + (value.sections ?? []).reduce<number>((count, section) => count + uncertaintyCount(section), 0);
  };
  const uncertain = entries.reduce((count, entry) => count + uncertaintyCount(entry.facts), 0);
  options = { ...options, unknowns: [...(options.unknowns ?? []), ...(uncertain
    ? [`${uncertain} child uncertainty entries are retained in detailed dossiers; do not treat unverified behavior as established.`] : [])] };
  let pending = entries;
  for (let depth = 0; depth < 16; depth += 1) {
    const whole = fitHierarchyPack(subject, pending, limits.maxTokens, options);
    if (packetFits(whole, limits)) { return run(whole); }
    const groups: EvidenceEntry[][] = [];
    let group: EvidenceEntry[] = [];
    for (const entry of pending) {
      if (packetFits(fitHierarchyPack(subject, [...group, entry], limits.maxTokens, options), limits)) {
        group.push(entry); continue;
      }
      if (group.length) { groups.push(group); group = []; }
      if (!packetFits(fitHierarchyPack(subject, [entry], limits.maxTokens, options), limits)) {
        throw new Error(`Evidence at ${entry.record.path} cannot fit a complete ${subject.level} packet; increase analysis_budget.file_pack_bytes/max_tokens. No evidence was silently dropped.`);
      }
      group.push(entry);
    }
    if (group.length) { groups.push(group); }
    const summaries: SummaryDoc[] = [];
    for (const [index, chunk] of groups.entries()) {
      summaries.push(await run(fitHierarchyPack({ ...subject,
        id: `${subject.id}#synthesis:${depth}:${index + 1}`,
        name: `${subject.name} [síntesis ${depth + 1}.${index + 1}]`,
      }, chunk, limits.maxTokens, options)));
    }
    pending = synthesisEntries(summaries.map((summary) => ({ summary, path: subject.path ?? '.' })), limits);
  }
  throw new Error(`Synthesis did not converge for ${subject.name}; inspect the saved intermediate dossiers.`);
}
