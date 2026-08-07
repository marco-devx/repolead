import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Command } from 'commander';

const HOOK_FILENAME = 'repolead-hook.cjs';

/**
 * Standalone, dependency-free hook script: it must start in milliseconds on
 * every Read/Grep/Glob, so it never loads the CLI bundle. Fails open on any
 * error and stays silent after two nudges per session.
 */
const HOOK_SCRIPT = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CODE_EXT = /\\.(ts|tsx|mts|cts|js|jsx|py)$/;
const MAX_NUDGES = 2;

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const toolInput = input.tool_input || {};
    const candidate = toolInput.file_path || toolInput.path || input.cwd || process.cwd();
    const abs = path.resolve(input.cwd || process.cwd(), candidate);

    let stat = null;
    try { stat = fs.statSync(abs); } catch { return; }
    if (stat.isFile() && !CODE_EXT.test(abs)) return;

    let dir = stat.isDirectory() ? abs : path.dirname(abs);
    let dbPath = null;
    for (let i = 0; i < 12; i += 1) {
      const probe = path.join(dir, '.repolead', 'repolead.db');
      if (fs.existsSync(probe)) { dbPath = probe; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!dbPath) return;

    const dbMtime = fs.statSync(dbPath).mtimeMs;
    if (stat.isFile() && stat.mtimeMs > dbMtime + 60000) return;

    const sessionId = String(input.session_id || 'unknown').replace(/[^a-zA-Z0-9-]/g, '');
    const marker = path.join(os.tmpdir(), 'repolead-nudge-' + sessionId);
    let count = 0;
    try { count = parseInt(fs.readFileSync(marker, 'utf8'), 10) || 0; } catch {}
    if (count >= MAX_NUDGES) return;
    fs.writeFileSync(marker, String(count + 1));

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          'This repository is indexed by RepoLead (MCP server "repolead"). Prefer its tools over raw exploration: ' +
          'search (hybrid symbol search, natural language), symbol_context, find_callers, module_context, ' +
          'repo_overview and get_evidence answer from a verified code graph in milliseconds and cost a fraction ' +
          'of the tokens of reading files. Fall back to direct reads only for content the graph does not cover.',
      },
    }));
  } catch {}
});
`;

interface ClaudeSettings {
  hooks?: Record<string, { matcher?: string; hooks?: { type: string; command: string }[] }[]>;
  [key: string]: unknown;
}

export interface InstallHooksResult {
  scriptPath: string;
  settingsPath: string;
  action: 'installed' | 'updated' | 'removed' | 'not-installed';
}

export function installHooks(rootPath: string, remove = false): InstallHooksResult {
  const root = resolve(rootPath);
  const claudeDir = join(root, '.claude');
  const scriptPath = join(claudeDir, HOOK_FILENAME);
  const settingsPath = join(claudeDir, 'settings.json');

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as ClaudeSettings;
  }
  settings.hooks ??= {};
  const preToolUse = (settings.hooks['PreToolUse'] ??= []);
  const existingIndex = preToolUse.findIndex((entry) =>
    entry.hooks?.some((hook) => hook.command.includes(HOOK_FILENAME)),
  );

  if (remove) {
    if (existingIndex === -1) {
      return { scriptPath, settingsPath, action: 'not-installed' };
    }
    preToolUse.splice(existingIndex, 1);
    if (preToolUse.length === 0) {
      delete settings.hooks['PreToolUse'];
    }
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    rmSync(scriptPath, { force: true });
    return { scriptPath, settingsPath, action: 'removed' };
  }

  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(scriptPath, HOOK_SCRIPT);

  const entry = {
    matcher: 'Read|Grep|Glob',
    hooks: [{ type: 'command', command: `node "${scriptPath}"` }],
  };
  const action = existingIndex === -1 ? 'installed' : 'updated';
  if (existingIndex === -1) {
    preToolUse.push(entry);
  } else {
    preToolUse[existingIndex] = entry;
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { scriptPath, settingsPath, action };
}

export function registerInstallHooks(program: Command): void {
  program
    .command('install-hooks')
    .description('Install a Claude Code PreToolUse hook that steers agents toward RepoLead')
    .argument('[path]', 'project directory', '.')
    .option('--remove', 'uninstall the hook')
    .action((path: string, options: { remove?: boolean }) => {
      const result = installHooks(path, options.remove ?? false);
      const messages: Record<InstallHooksResult['action'], string> = {
        installed: `✓ Hook installed: ${result.scriptPath}`,
        updated: `✓ Hook updated: ${result.scriptPath}`,
        removed: `✓ Hook removed`,
        'not-installed': '− No RepoLead hook found in this project',
      };
      console.log(messages[result.action]);
      if (!options.remove && result.action !== 'not-installed') {
        console.log(`  Registered in ${result.settingsPath} (matcher: Read|Grep|Glob)`);
        console.log('  Agents opening indexed files will be nudged to query RepoLead instead.');
      }
    });
}
