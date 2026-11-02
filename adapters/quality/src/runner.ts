import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { normalizeJscpd, normalizeRadon, normalizeRuff, reportPath } from './normalize';
import type { QualityReport } from './normalize';

export const QUALITY_TOOLS = ['jscpd', 'ruff', 'radon'] as const;
export type QualityTool = typeof QUALITY_TOOLS[number];
export const QUALITY_PROFILE = 'quality-v1:jscpd-exact-strict-5lines-50tokens:ruff-E9,F,B:radon-api-cc-raw';
export interface ToolCommand { command: string; args: string[] }
export interface ToolProbe { tool: QualityTool; status: 'available' | 'unavailable'; version: string | null; invocation: ToolCommand; message?: string }
const run = promisify(execFile);
const require_ = createRequire(import.meta.url);
const radonVersion = 'import radon; print(radon.__version__)';

function installedPythonBin(name: string): string | null {
  let path = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(path, '.repolead-tools', 'python', 'bin', name);
    if (existsSync(candidate)) { return candidate; }
    const parent = dirname(path);
    if (parent === path) { return null; }
    path = parent;
  }
}

export function qualityCommand(tool: QualityTool, env: NodeJS.ProcessEnv = process.env): ToolCommand {
  if (tool === 'radon') { return { command: env['REPOLEAD_QUALITY_PYTHON'] ?? installedPythonBin('python') ?? 'python3', args: ['-I'] }; }
  if (tool === 'ruff') { return { command: env['REPOLEAD_RUFF_BIN'] ?? installedPythonBin('ruff') ?? 'ruff', args: [] }; }
  if (env['REPOLEAD_JSCPD_BIN']) { return { command: env['REPOLEAD_JSCPD_BIN'], args: [] }; }
  try { return { command: process.execPath, args: [join(dirname(require_.resolve('jscpd/package.json')), 'run-jscpd.js')] }; }
  catch { return { command: 'jscpd', args: [] }; }
}

export async function probeQualityTool(tool: QualityTool, env: NodeJS.ProcessEnv = process.env): Promise<ToolProbe> {
  const invocation = qualityCommand(tool, env);
  try {
    const { stdout } = await run(invocation.command, [...invocation.args, ...(tool === 'radon' ? ['-c', radonVersion] : ['--version'])], { timeout: 10000, env });
    const version = stdout.trim().split('\n')[0];
    if (!version) { throw new Error('Tool returned no version.'); }
    return { tool, invocation, status: 'available', version };
  } catch (error) { return { tool, invocation, status: 'unavailable', version: null, message: String(error).slice(0, 1000) }; }
}

export function eligibleSource(tool: QualityTool, path: string): boolean {
  return tool === 'jscpd' ? /\.(?:[cm]?[jt]sx?|py)$/.test(path) : path.endsWith('.py');
}

// Isolated Python imports only the installed analyzer; it never imports or executes target code.
const RADON_SCRIPT = `import json, pathlib, sys
from radon.complexity import cc_visit
from radon.cli.harvest import cc_to_dict
from radon.raw import analyze
cc, raw = {}, {}
for path in json.loads(pathlib.Path(sys.argv[1]).read_text()):
    try:
        text = pathlib.Path(path).read_text(encoding='utf-8')
        cc[path] = [cc_to_dict(block) for block in cc_visit(text)]
        raw[path] = analyze(text)._asdict()
    except (SyntaxError, ValueError, UnicodeError) as error:
        cc[path] = {'error': str(error)}
        raw[path] = {'error': str(error)}
print(json.dumps({'cc': cc, 'raw': raw}))
`;

export async function runQualityTool(probe: ToolProbe, sources: ReadonlyMap<string, string>, timeoutMs = 120000): Promise<QualityReport> {
  if (probe.status !== 'available') { throw new Error(probe.message ?? `${probe.tool} unavailable`); }
  const stage = await mkdtemp(join(tmpdir(), 'repolead-quality-'));
  const rootPath = join(stage, 'source');
  const selected = new Map([...sources].filter(([path]) => eligibleSource(probe.tool, path)));
  try {
    await mkdir(rootPath);
    for (const [path, content] of selected) {
      reportPath(path, { rootPath, sources: selected });
      const destination = resolve(rootPath, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    const invoke = async (args: string[]) => (await run(probe.invocation.command, [...probe.invocation.args, ...args],
      { cwd: rootPath, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })).stdout;
    const context = { rootPath, sources: selected };
    if (probe.tool === 'jscpd') {
      const config = join(stage, 'jscpd.json');
      await writeFile(config, '{}');
      await invoke(['.', '--config', config, '--reporters', 'json', '--output', join(stage, 'report'),
        '--format', 'typescript,javascript,tsx,jsx,python', '--kind', 'exact', '--mode', 'strict',
        '--min-lines', '5', '--min-tokens', '50', '--no-gitignore']);
      return normalizeJscpd(JSON.parse(await readFile(join(stage, 'report', 'jscpd-report.json'), 'utf8')), context);
    }
    if (probe.tool === 'ruff') {
      const issues: unknown[] = [];
      const paths = [...selected.keys()].sort();
      // Explicit paths include hidden tracked files and avoid implicit excludes; bounded argv.
      for (let offset = 0; offset < paths.length; offset += 100) {
        const result: unknown = JSON.parse(await invoke(['check', '--isolated', '--no-cache', '--no-fix', '--output-format', 'json',
          '--select', 'E9,F,B', '--exit-zero', '--', ...paths.slice(offset, offset + 100)]));
        if (!Array.isArray(result)) { throw new Error('Ruff did not return a JSON array.'); }
        issues.push(...result);
      }
      return normalizeRuff(issues, context);
    }
    const manifest = join(stage, 'manifest.json');
    await writeFile(manifest, JSON.stringify([...selected.keys()].sort()));
    const result = JSON.parse(await invoke(['-c', RADON_SCRIPT, manifest])) as { cc: unknown; raw: unknown };
    return normalizeRadon(result.cc, result.raw, context);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
