import { createHash } from 'node:crypto';

import { contentHash } from '@repolead/domain';

import { reportPath, sourceLines } from './normalize';
import type { ReportContext } from './normalize';

export interface ImportedCoverage {
  path: string; lineRate: number | null; branchRate: number | null; sourceHash: string;
  lines: { line: number; hits: number }[];
  provenance: { reportHash: string; sourceBinding: 'reported-lines-verified' | 'unverified'; checkedLines: number;
    totalLines: number; totalBranches: number; coveredBranches: number };
}
interface RecordData {
  path: string; lines: Map<number, { hits: number; checksums: Set<string>; unverified: boolean }>;
  branches: Map<string, number>; summaries: Map<string, number>;
}
const integer = (value: string, minimum = 0): number => {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) { throw new Error(`Invalid LCOV count: ${value}`); }
  return Number(value);
};

/** LCOV rates count reported instrumented lines/branches only. Missing files have no row. */
export function normalizeLcov(text: string, context: ReportContext): { coverage: ImportedCoverage[]; diagnostics: string[] } {
  const records: RecordData[] = [];
  let current: RecordData | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('TN:') || line.startsWith('#')) { continue; }
    if (line.startsWith('SF:')) {
      if (current) { throw new Error('LCOV record is missing end_of_record.'); }
      current = { path: line.slice(3), lines: new Map(), branches: new Map(), summaries: new Map() };
    } else if (line === 'end_of_record') {
      if (!current) { throw new Error('Unexpected LCOV end_of_record.'); }
      for (const [name, expected] of current.summaries) {
        const actual = name === 'LF' ? current.lines.size : name === 'LH' ? [...current.lines.values()].filter((entry) => entry.hits > 0).length :
          name === 'BRF' ? current.branches.size : [...current.branches.values()].filter((hits) => hits > 0).length;
        if (actual !== expected) { throw new Error(`Inconsistent LCOV ${name} in ${current.path}: ${expected} vs ${actual}.`); }
      }
      records.push(current); current = null;
    } else if (/^(DA|BRDA|LF|LH|BRF|BRH):/.test(line)) {
      if (!current) { throw new Error('LCOV measurement outside a source record.'); }
      const kind = line.slice(0, line.indexOf(':'));
      const values = line.slice(kind.length + 1).split(',');
      if (kind === 'DA') {
        if (values.length < 2 || values.length > 3) { throw new Error(`Malformed LCOV DA: ${line}`); }
        const number = integer(values[0]!, 1); const hits = integer(values[1]!);
        if (current.lines.has(number)) { throw new Error(`Duplicate LCOV line ${number} in one record.`); }
        current.lines.set(number, { hits, checksums: new Set(values[2] ? [values[2]] : []), unverified: !values[2] });
      } else if (kind === 'BRDA') {
        if (values.length !== 4) { throw new Error(`Malformed LCOV BRDA: ${line}`); }
        integer(values[0]!.replace(/^e/, ''), 1);
        const key = values.slice(0, 3).join(',');
        if (current.branches.has(key)) { throw new Error(`Duplicate LCOV branch ${key}.`); }
        current.branches.set(key, values[3] === '-' ? 0 : integer(values[3]!));
      } else { current.summaries.set(kind, integer(values[0]!)); }
    } else if (!/^(FN|FNDA|FNF|FNH|FNL|FNA|VER|MCDC):/.test(line)) { throw new Error(`Unsupported LCOV entry: ${line.slice(0, 100)}`); }
  }
  if (current) { throw new Error('LCOV record is missing end_of_record.'); }
  if (!records.length) { throw new Error('No LCOV source records.'); }
  const diagnostics: string[] = [];
  const merged = new Map<string, RecordData>();
  const rejected = new Set<string>();
  for (const record of records) {
    try {
      const path = reportPath(record.path, context);
      const source = sourceLines(context.sources.get(path)!);
      for (const [line, data] of record.lines) {
        if (line > source.length) { rejected.add(path); throw new Error(`LCOV line outside indexed source: ${path}:${line}`); }
        for (const checksum of data.checksums) {
          const md5 = createHash('md5').update(source[line - 1]!).digest();
          if (checksum !== md5.toString('hex') && checksum.replace(/=+$/, '') !== md5.toString('base64').replace(/=+$/, '')) {
            rejected.add(path); throw new Error(`LCOV checksum mismatch: ${path}:${line}`);
          }
        }
      }
      for (const key of record.branches.keys()) {
        if (integer(key.split(',')[0]!.replace(/^e/, ''), 1) > source.length) { rejected.add(path); throw new Error(`LCOV branch outside indexed source: ${path}`); }
      }
      const prior = merged.get(path);
      if (!prior) { merged.set(path, { ...record, path }); continue; }
      // Multiple TN records are executions of the same instrumented file.
      for (const [line, data] of record.lines) {
        const old = prior.lines.get(line);
        if (old) {
          old.hits += data.hits; old.unverified ||= data.unverified;
          if (!Number.isSafeInteger(old.hits)) { rejected.add(path); throw new Error(`LCOV counter overflow: ${path}:${line}`); }
          for (const sum of data.checksums) { old.checksums.add(sum); }
        }
        else { prior.lines.set(line, data); }
      }
      for (const [key, hits] of record.branches) {
        const combined = (prior.branches.get(key) ?? 0) + hits;
        if (!Number.isSafeInteger(combined)) { rejected.add(path); throw new Error(`LCOV branch counter overflow: ${path}`); }
        prior.branches.set(key, combined);
      }
    } catch (error) { diagnostics.push(String(error)); }
  }
  const coverage: ImportedCoverage[] = [];
  for (const record of merged.values()) {
    if (rejected.has(record.path)) { continue; }
    const lines = [...record.lines].map(([line, data]) => ({ line, hits: data.hits })).sort((a, b) => a.line - b.line);
    const checkedLines = [...record.lines.values()].filter((entry) => entry.checksums.size > 0 && !entry.unverified).length;
    const coveredBranches = [...record.branches.values()].filter((hits) => hits > 0).length;
    coverage.push({ path: record.path, sourceHash: contentHash(context.sources.get(record.path)!), lines,
      lineRate: lines.length ? lines.filter((entry) => entry.hits > 0).length / lines.length : null,
      branchRate: record.branches.size ? coveredBranches / record.branches.size : null,
      provenance: { reportHash: contentHash(text), sourceBinding: lines.length && checkedLines === lines.length ? 'reported-lines-verified' : 'unverified',
        checkedLines, totalLines: lines.length, totalBranches: record.branches.size, coveredBranches } });
  }
  return { coverage: coverage.sort((a, b) => a.path.localeCompare(b.path)), diagnostics };
}
