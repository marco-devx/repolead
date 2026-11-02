import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { contentHash } from '@repolead/domain';
import { z } from 'zod';

export interface MutationTarget {
  symbolId: string; path: string; sourceHash: string;
  startLine: number; endLine: number; startColumn: number; endColumn: number;
}
export const MUTANT_STATUSES = ['Killed', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Timeout', 'Ignored', 'Pending'] as const;
const position = z.object({ line: z.number().int().min(1), column: z.number().int().min(1) });
const mutant = z.object({ id: z.string().min(1), mutatorName: z.string().min(1), status: z.enum(MUTANT_STATUSES),
  location: z.object({ start: position, end: position }) });
const schema = z.object({ schemaVersion: z.string().regex(/^1(?:\.|$)/),
  files: z.record(z.string(), z.object({ source: z.string(), mutants: z.array(mutant) })),
  framework: z.object({ name: z.string(), version: z.string().optional() }).optional() });

export function mutationPattern(target: MutationTarget): string {
  if (isAbsolute(target.path) || target.path.split('/').some((part) => !part || part === '.' || part === '..')
    || [...target.path].some((char) => char.charCodeAt(0) < 32 || '\\:*?[]{}()!@+'.includes(char))
    || target.path.split('/').some((part) => part.startsWith('.'))) {
    throw new Error(`Mutation target requires a literal, non-hidden repository path: ${target.path}`);
  }
  if (![target.startLine, target.endLine, target.startColumn, target.endColumn].every(Number.isSafeInteger)
    || target.startLine < 1 || target.endLine < target.startLine || target.startColumn < 0 || target.endColumn < 0
    || (target.startLine === target.endLine && target.endColumn <= target.startColumn)) { throw new Error('Invalid mutation range.'); }
  // Stryker's range syntax uses 1-based lines and 0-based columns; reports use 1-based columns.
  return `${target.path}:${target.startLine}:${target.startColumn}-${target.endLine}:${target.endColumn}`;
}

const before = (left: { line: number; column: number }, right: { line: number; column: number }) =>
  left.line < right.line || (left.line === right.line && left.column <= right.column);

/** Validate complete file hashes and requested ranges; never retain source/replacement/test output in normalized results. */
export function normalizeMutationReport(raw: unknown, targets: MutationTarget[]) {
  const report = schema.parse(raw);
  if (!targets.length) { throw new Error('An explicit nonempty mutation target plan is required.'); }
  for (const target of targets) { mutationPattern(target); }
  const expected = new Map<string, MutationTarget[]>();
  for (const target of targets) { const group = expected.get(target.path) ?? []; group.push(target); expected.set(target.path, group); }
  const mutants: (z.infer<typeof mutant> & { path: string; symbolIds: string[] })[] = [];
  let ignoredOutsideScope = 0;
  for (const [path, file] of Object.entries(report.files)) {
    const selected = expected.get(path);
    if (!selected) { throw new Error(`Mutation report contains an unplanned file: ${path}`); }
    if (selected.some((target) => target.sourceHash !== contentHash(file.source))) { throw new Error(`Mutation report source hash mismatch: ${path}`); }
    const lines = file.source.split('\n'); const ids = new Set<string>();
    for (const entry of file.mutants) {
      if (ids.has(entry.id)) { throw new Error(`Duplicate mutant ID in ${path}: ${entry.id}`); } ids.add(entry.id);
      for (const pos of [entry.location.start, entry.location.end]) {
        if (pos.line > lines.length || pos.column > lines[pos.line - 1]!.length + 1) { throw new Error(`Mutant outside source bounds: ${path}`); }
      }
      if (!before(entry.location.start, entry.location.end) || (entry.location.start.line === entry.location.end.line && entry.location.start.column === entry.location.end.column)) {
        throw new Error('Empty/reversed mutant location.');
      }
      const symbolIds = selected.filter((target) => before({ line: target.startLine, column: target.startColumn + 1 }, entry.location.start)
        && before(entry.location.end, { line: target.endLine, column: target.endColumn + 1 })).map((target) => target.symbolId);
      if (!symbolIds.length) {
        if (entry.status === 'Ignored') { ignoredOutsideScope += 1; continue; }
        throw new Error(`Executed/pending mutant outside the selected hotspots: ${path}:${entry.location.start.line}`);
      }
      mutants.push({ ...entry, path, symbolIds });
    }
    expected.delete(path);
  }
  if (expected.size) { throw new Error(`Mutation report omits selected files: ${[...expected.keys()].join(', ')}`); }
  const counts = Object.fromEntries(MUTANT_STATUSES.map((status) => [status, mutants.filter((entry) => entry.status === status).length])) as Record<typeof MUTANT_STATUSES[number], number>;
  const detected = counts.Killed + counts.Timeout; const undetected = counts.Survived + counts.NoCoverage;
  const denominator = detected + undetected;
  return { schemaVersion: report.schemaVersion, framework: report.framework ?? null, counts, ignoredOutsideScope, mutants,
    mutationScore: denominator ? Math.round(detected / denominator * 10000) / 100 : null,
    scoreBasis: '100 × (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage). CompileError, RuntimeError, Ignored and Pending excluded; inspect counts before interpreting.',
    complete: counts.Pending === 0, sourceBinding: 'full-mutated-file-hashes-and-selected-ranges-verified',
    limitations: ['A mutation score measures detection of these mutants, not correctness of all behavior or absence of equivalent mutants.',
      'Report source hashes do not establish test/dependency freshness or authenticate execution. Imported counts remain reported results.'] };
}
export type NormalizedMutationReport = ReturnType<typeof normalizeMutationReport>;

const run = promisify(execFile); const require_ = createRequire(import.meta.url);
export function strykerCommand(env: NodeJS.ProcessEnv = process.env) {
  if (env['REPOLEAD_STRYKER_BIN']) { return { command: env['REPOLEAD_STRYKER_BIN'], args: [] as string[] }; }
  try { return { command: env['REPOLEAD_NODE_BIN'] ?? 'node', args: [join(dirname(require_.resolve('@stryker-mutator/core/package.json')), 'bin/stryker.js')] }; }
  catch { return { command: 'stryker', args: [] as string[] }; }
}
export async function probeStryker(env: NodeJS.ProcessEnv = process.env) {
  const invocation = strykerCommand(env);
  try {
    const { stdout } = await run(invocation.command, [...invocation.args, '--version'], { timeout: 10000, maxBuffer: 100000, env });
    const version = stdout.trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) { throw new Error('Unrecognized Stryker version.'); }
    return { available: true, version, invocation, message: null };
  } catch (error) { return { available: false, version: null, invocation, message: String(error).slice(0, 1000) }; }
}

/** Explicit opt-in caller only. Stryker copies the project; test commands execute real project code. */
export async function executeStryker(options: { rootPath: string; targets: MutationTarget[]; testCommand: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) {
  if (!options.targets.length || !options.testCommand.trim()) { throw new Error('Selected targets and an explicit test command are required.'); }
  const timeoutMs = options.timeoutMs ?? 600000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) { throw new Error('timeoutMs must be 1000–3600000.'); }
  const mutate = options.targets.map(mutationPattern);
  const probe = await probeStryker(options.env);
  if (!probe.available) { throw new Error(`Stryker unavailable: ${probe.message}`); }
  const root = realpathSync(options.rootPath); const parent = join(root, '.repolead', 'mutation-runs');
  for (const directory of [join(root, '.repolead'), parent]) {
    if (existsSync(directory) && !realpathSync(directory).startsWith(`${root}${sep}`)) { throw new Error('Mutation artifact directory escapes the repository.'); }
    mkdirSync(directory, { recursive: true });
  }
  const work = mkdtempSync(join(parent, 'run-')); const configPath = join(work, 'stryker.config.json');
  const reportPath = join(work, 'mutation.json'); const sandbox = join(work, 'sandbox');
  const config = { mutate, inPlace: false, testRunner: 'command', commandRunner: { command: options.testCommand },
    coverageAnalysis: 'off', plugins: [], reporters: ['json'], jsonReporter: { fileName: relative(root, reportPath) },
    tempDirName: relative(root, sandbox), ignorePatterns: ['.repolead/**', '.repolead-tools/**'],
    concurrency: 1, incremental: false, timeoutMS: 5000, timeoutFactor: 2, dryRunTimeoutMinutes: 2,
    logLevel: 'warn', fileLogLevel: 'off', allowConsoleColors: false, thresholds: { high: 80, low: 60, break: 0 } };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  try {
    const log = await new Promise<string>((resolve_, reject) => {
      const child = spawn(probe.invocation.command, [...probe.invocation.args, 'run', configPath],
        { cwd: root, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      let output = ''; let timedOut = false; let force: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try { if (process.platform !== 'win32' && child.pid) { process.kill(-child.pid, signal); } else { child.kill(signal); } } catch { /* already exited */ }
      };
      const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 2000); }, timeoutMs);
      const record = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-262144); };
      child.stdout.on('data', record); child.stderr.on('data', record);
      child.on('error', (error) => { clearTimeout(timer); if (force) { clearTimeout(force); } reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) { kill('SIGKILL'); }
        if (force) { clearTimeout(force); }
        if (code !== 0 || timedOut) { reject(new Error(`Stryker ${timedOut ? 'timed out' : `exited ${code}`}: ${output.slice(-2000)}`)); }
        else { resolve_(output); }
      });
    });
    if (statSync(reportPath).size > 64 * 1024 * 1024) { throw new Error('Mutation report exceeds 64 MiB.'); }
    const rawText = readFileSync(reportPath, 'utf8');
    return { version: probe.version!, configPath, reportPath, log, reportHash: contentHash(rawText),
      normalized: normalizeMutationReport(JSON.parse(rawText), options.targets) };
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
}
