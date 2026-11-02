import { isAbsolute, relative, resolve } from 'node:path';

import { z } from 'zod';

export interface Location { path: string; startLine: number; endLine: number }
export interface Measurement { path: string; name: string; value: number; symbol?: { name: string; startLine: number; endLine: number } }
export interface ReportIssue { ruleId: string; message: string; locations: Location[]; details: Record<string, unknown> }
export interface QualityReport { measurements: Measurement[]; issues: ReportIssue[]; diagnostics: string[] }
export interface ReportContext { rootPath: string; sources: ReadonlyMap<string, string> }
const positive = z.number().int().positive();
const count = z.number().int().nonnegative();
export const emptyReport = (): QualityReport => ({ measurements: [], issues: [], diagnostics: [] });

/** Exact repository-relative paths only: never guess by basename or suffix. */
export function reportPath(path: string, context: ReportContext): string {
  const normalized = path.replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(normalized) && process.platform !== 'win32') { throw new Error(`Unmapped foreign path: ${path}`); }
  const mapped = relative(context.rootPath, isAbsolute(normalized) ? normalized : resolve(context.rootPath, normalized)).replaceAll('\\', '/');
  if (mapped === '..' || mapped.startsWith('../') || !context.sources.has(mapped)) { throw new Error(`Unmapped report path: ${path}`); }
  return mapped;
}

export function sourceLines(source: string): string[] { return source === '' ? [] : source.replace(/\r?\n$/, '').split(/\r?\n/); }
function location(path: string, startLine: number, endLine: number, context: ReportContext): Location {
  const mapped = reportPath(path, context);
  if (endLine < startLine || endLine > sourceLines(context.sources.get(mapped)!).length) { throw new Error(`Invalid report range: ${mapped}:${startLine}-${endLine}`); }
  return { path: mapped, startLine, endLine };
}

const cloneFile = z.object({ name: z.string(), start: positive, end: positive });
const jscpdSchema = z.object({ duplicates: z.array(z.object({ firstFile: cloneFile, secondFile: cloneFile,
  lines: positive, tokens: count, kind: z.string().optional(), format: z.string().optional() })), statistics: z.object({ total: z.object({ sources: count }) }) });

export function normalizeJscpd(data: unknown, context: ReportContext): QualityReport {
  const report = emptyReport();
  const parsed = jscpdSchema.parse(data);
  const duplicated = new Map<string, Set<number>>();
  for (const clone of parsed.duplicates) {
    try {
      const locations = [clone.firstFile, clone.secondFile].map((file) => location(file.name, file.start, file.end, context));
      for (const range of locations) {
        const lines = duplicated.get(range.path) ?? new Set<number>();
        for (let line = range.startLine; line <= range.endLine; line += 1) { lines.add(line); }
        duplicated.set(range.path, lines);
      }
      report.issues.push({ ruleId: 'duplicate-block', message: `Duplicated block (${clone.lines} lines, ${clone.tokens} tokens)`,
        locations, details: { lines: clone.lines, tokens: clone.tokens, kind: clone.kind ?? 'unspecified', format: clone.format ?? null } });
    } catch (error) { report.diagnostics.push(String(error)); }
  }
  // Counts describe lines participating in reported clones, not jscpd's global percentage.
  for (const [path, lines] of duplicated) { report.measurements.push({ path, name: 'duplicated_lines', value: lines.size }); }
  if (context.sources.size && parsed.statistics.total.sources === 0) { report.diagnostics.push('jscpd analyzed no eligible token blocks; absence of duplicates is not proof of coverage.'); }
  return report;
}

const ruffSchema = z.array(z.object({ filename: z.string(), code: z.string().nullable(), message: z.string(),
  location: z.object({ row: positive, column: positive }), end_location: z.object({ row: positive, column: positive }) }));

export function normalizeRuff(data: unknown, context: ReportContext): QualityReport {
  const report = emptyReport();
  const counts = new Map([...context.sources.keys()].filter((path) => path.endsWith('.py')).map((path) => [path, 0]));
  for (const issue of ruffSchema.parse(data)) {
    try {
      const end = issue.end_location.row - Number(issue.end_location.column === 1 && issue.end_location.row > issue.location.row);
      const range = location(issue.filename, issue.location.row, end, context);
      report.issues.push({ ruleId: issue.code ?? 'syntax-error', message: issue.message, locations: [range],
        details: { startColumn: issue.location.column, endColumn: issue.end_location.column } });
      counts.set(range.path, (counts.get(range.path) ?? 0) + 1);
    } catch (error) { report.diagnostics.push(String(error)); }
  }
  for (const [path, value] of counts) { report.measurements.push({ path, name: 'lint_issues', value }); }
  return report;
}

const radonBlock = z.object({ name: z.string(), lineno: positive, endline: positive, complexity: positive,
  type: z.enum(['function', 'method', 'class']), methods: z.array(z.unknown()).optional(), closures: z.array(z.unknown()).optional() });
const radonRaw = z.object({ loc: count, lloc: count, sloc: count, comments: count, multi: count, blank: count, single_comments: count });

export function normalizeRadon(cc: unknown, raw: unknown, context: ReportContext): QualityReport {
  const report = emptyReport();
  const seen = new Set<string>();
  const visit = (data: unknown, path: string) => {
    const block = radonBlock.parse(data);
    const range = location(path, block.lineno, block.endline, context);
    const key = `${range.path}:${block.lineno}:${block.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      report.measurements.push({ path: range.path, name: block.type === 'class' ? 'class_complexity' : 'cyclomatic_complexity', value: block.complexity,
        symbol: { name: block.name, startLine: range.startLine, endLine: range.endLine } });
    }
    for (const child of [...(block.methods ?? []), ...(block.closures ?? [])]) { visit(child, path); }
  };
  for (const [path, blocks] of Object.entries(z.record(z.string(), z.unknown()).parse(cc))) {
    try { for (const block of z.array(z.unknown()).parse(blocks)) { visit(block, path); } }
    catch (error) { report.diagnostics.push(`Radon complexity ${path}: ${String(error)}`); }
  }
  for (const [path, data] of Object.entries(z.record(z.string(), z.unknown()).parse(raw))) {
    try {
      const mapped = reportPath(path, context);
      for (const [name, value] of Object.entries(radonRaw.parse(data))) { report.measurements.push({ path: mapped, name: `raw_${name}`, value }); }
    } catch (error) { report.diagnostics.push(`Radon raw ${path}: ${String(error)}`); }
  }
  return report;
}
