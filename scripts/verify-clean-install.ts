import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentHash } from '@repolead/domain';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'repolead-clean-install-'));
const execute = (command: string, args: string[], timeout = 300000) => execFileSync(command, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
try {
  // Include the actual uncommitted implementation; never copy secrets, node_modules or ignored caches.
  const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: project, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
  const manifest: { path: string; hash: string }[] = [];
  for (const path of paths) {
    const from = join(project, path);
    if (!existsSync(from) || !lstatSync(from).isFile()) { continue; }
    const to = join(root, path); mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to);
    manifest.push({ path, hash: contentHash(readFileSync(from)) });
  }
  const started = Date.now();
  const install = execute('bun', ['install', '--frozen-lockfile']);
  console.log('Clean frozen-lockfile install passed.');
  const check = execute('bun', ['run', 'check']);
  console.log('Clean lint, TypeScript, tests and build passed.');
  const cli = join(root, 'apps/cli/dist/index.cjs');
  const help = execute('node', [cli, '--help']);
  assert.ok(help.includes('mutation') && help.includes('opportunities'));
  const doctor = JSON.parse(execute('node', [cli, 'doctor', '--json']));
  const report = { generatedAt: new Date().toISOString(), durationMs: Date.now() - started,
    source: 'Git tracked and nonignored untracked working-tree files copied into an empty temporary directory',
    sourceFileCount: manifest.length, sourceManifestHash: contentHash(JSON.stringify(manifest)),
    commands: ['bun install --frozen-lockfile', 'bun run check (lint + Rslint + TypeScript + tests + build)', 'node compiled-cli --help', 'node compiled-cli doctor --json'],
    install: install.slice(-2000), checks: check.slice(-5000), doctor,
    scope: 'Local clean-install execution of the configured CI gates, not a hosted GitHub Actions run.',
    scriptHash: contentHash(readFileSync(fileURLToPath(import.meta.url))) };
  writeFileSync(join(project, 'benchmarks/clean-install-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ sourceFileCount: report.sourceFileCount, durationMs: report.durationMs, scope: report.scope }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
