import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { contentHash } from '@repolead/domain';
import { z } from 'zod';

export const JOERN_QUERY_VERSION = 'parameter-to-call-argument-v1';
function installation(env: NodeJS.ProcessEnv = process.env) {
  const configured = env['REPOLEAD_JOERN_BIN'] ?? 'joern';
  const found = configured.includes('/') || configured.includes('\\') ? resolve(configured)
    : (env['PATH'] ?? process.env['PATH'] ?? '').split(delimiter).map((path) => join(path, configured)).find((path) => existsSync(path));
  const binary = found && existsSync(found) ? realpathSync(found) : configured;
  let version: string | null = null;
  for (const lib of [join(dirname(binary), 'lib'), join(dirname(binary), '..', 'lib')]) {
    if (!isAbsolute(binary) || !existsSync(lib)) { continue; }
    const versions = readdirSync(lib).flatMap((name) => /^io\.joern\.x2cpg-(.+)\.jar$/.exec(name)?.[1] ?? []);
    if (versions.length === 1) { version = versions[0]!; break; }
  }
  return { binary, version };
}
// Fixed query: caller input is passed as literal nameExact parameters, never interpolated Scala.
export const JOERN_SCRIPT = `import io.shiftleft.semanticcpg.language.*
import io.joern.dataflowengineoss.language.*
@main def exec(inputPath: String, outFile: String, sourceMethod: String, sinkCall: String, maxPaths: Int, language: String) = {
  importCode(inputPath, language = language)
  run.ossdataflow
  def sources = cpg.method.nameExact(sourceMethod).parameter.filter(_.index > 0)
  def sinks = cpg.call.nameExact(sinkCall).argument.filter(_.argumentIndex > 0)
  val flows = sinks.reachableByFlows(sources).take(maxPaths + 1).l
  val paths = flows.take(maxPaths).map(p => ujson.Arr.from(p.elements.map(n => ujson.Obj(
    "path" -> n.file.name.headOption.getOrElse(""), "line" -> n.lineNumber.getOrElse(0), "kind" -> n.label))))
  val result = ujson.Obj("version" -> 1, "sourceCount" -> sources.size, "sinkCount" -> sinks.size,
    "truncated" -> (flows.size > maxPaths), "paths" -> ujson.Arr.from(paths))
  java.nio.file.Files.writeString(java.nio.file.Paths.get(outFile), ujson.write(result))
}`;

async function execute(binary: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let timedOut = false; let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (signal: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) { process.kill(-child.pid, signal); } else { child.kill(signal); } } catch { /* already exited */ } };
    const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); killTimer = setTimeout(() => stop('SIGKILL'), 2000); }, timeoutMs);
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-32000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', (error) => { clearTimeout(timer); if (killTimer) { clearTimeout(killTimer); } reject(error); });
    child.on('close', (code) => { clearTimeout(timer); if (killTimer) { clearTimeout(killTimer); }
      if (timedOut || code !== 0) { reject(new Error(`Joern ${timedOut ? 'timed out' : `exited ${code}`}: ${output.slice(-3000)}`)); }
      else { resolve(output); } });
  });
}

export async function probeJoern(env: NodeJS.ProcessEnv = process.env) {
  const { binary, version } = installation(env);
  try { const output = await execute(binary, ['--help'], tmpdir(), 10000);
    return { available: output.includes('--script'), binary, version,
      detail: `Joern script interpreter available${version ? ` (${version}, installed core JAR identity)` : '; distribution version unknown'}.` };
  } catch { return { available: false, binary, detail: 'Joern not available (optional)' }; }
}

const reportSchema = z.strictObject({ version: z.literal(1), sourceCount: z.number().int().nonnegative(), sinkCount: z.number().int().nonnegative(),
  truncated: z.boolean(), paths: z.array(z.array(z.strictObject({ path: z.string(), line: z.number().int().positive(), kind: z.string().min(1) })).min(1).max(500)).max(100) });

export function normalizeJoernReport(input: unknown, files: { path: string; source: string }[], sourceRoot: string) {
  const report = reportSchema.parse(input); const byPath = new Map(files.map((file) => [file.path, file]));
  return { ...report, paths: report.paths.map((nodes) => nodes.map((node) => {
    const path = isAbsolute(node.path) ? relative(sourceRoot, node.path) : node.path;
    const file = byPath.get(path.replaceAll('\\', '/'));
    if (!file || node.line > file.source.split('\n').length) { throw new Error('Joern node is outside the captured source snapshot.'); }
    return { path: file.path, line: node.line, kind: node.kind, sourceHash: contentHash(file.source),
      lineHash: contentHash(file.source.split('\n')[node.line - 1]!) };
  })) };
}

export async function runJoern(input: { files: { path: string; source: string }[]; sourceMethod: string; sinkCall: string;
  language: 'javascript' | 'python'; maxPaths?: number; timeoutMs?: number; env?: NodeJS.ProcessEnv }) {
  const maxPaths = input.maxPaths ?? 10; const timeoutMs = input.timeoutMs ?? 300000;
  if (!Number.isInteger(maxPaths) || maxPaths < 1 || maxPaths > 100 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) { throw new Error('Invalid Joern bounds.'); }
  if (![input.sourceMethod, input.sinkCall].every((value) => value.length > 0 && value.length <= 500 && !/[\0\r\n]/.test(value))) { throw new Error('Invalid Joern method/call name.'); }
  if (!input.files.length) { throw new Error('No supported source files in this snapshot.'); }
  const { binary, version } = installation(input.env ?? process.env);
  const root = mkdtempSync(join(tmpdir(), 'repolead-joern-')); const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot);
  try {
    let bytes = 0; const seen = new Set<string>();
    for (const file of input.files) {
      if (isAbsolute(file.path) || file.path.split(/[\\/]/).some((part) => !part || part === '.' || part === '..') || /[\0\r\n]/.test(file.path) || seen.has(file.path)) { throw new Error('Unsafe or duplicate Joern source path.'); }
      bytes += Buffer.byteLength(file.source); if (bytes > 100 * 1024 * 1024 || input.files.length > 5000) { throw new Error('Joern source budget exceeded (100 MiB / 5000 files).'); }
      seen.add(file.path); const path = join(sourceRoot, file.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.source);
    }
    const script = join(root, 'flow.sc'); const output = join(root, 'report.json'); writeFileSync(script, JOERN_SCRIPT);
    const started = Date.now();
    await execute(binary, ['-J-Xmx2g', '--script', script, '--param', `inputPath=${sourceRoot}`, '--param', `outFile=${output}`,
      '--param', `sourceMethod=${input.sourceMethod}`, '--param', `sinkCall=${input.sinkCall}`, '--param', `maxPaths=${maxPaths}`,
      '--param', `language=${input.language === 'python' ? 'PYTHONSRC' : 'JSSRC'}`], root, timeoutMs);
    const report = normalizeJoernReport(JSON.parse(readFileSync(output, 'utf8')) as unknown, input.files, sourceRoot);
    return { ...report, durationMs: Date.now() - started, queryVersion: JOERN_QUERY_VERSION, queryHash: contentHash(JOERN_SCRIPT),
      engine: 'Joern OSS dataflow', engineVersion: version, binary, sourceMethod: input.sourceMethod, sinkCall: input.sinkCall,
      limits: { maxPaths, timeoutMs, files: input.files.length },
      unknowns: ['Static parameter-to-call-argument data flow under Joern default semantics; not runtime reachability or vulnerability proof.',
        'Exact method/call names may select several declarations. Empty/bounded results do not prove absence of a flow.',
        'External library models, dynamic dispatch and unsupported frontend constructs can omit or overapproximate flows.'] };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
