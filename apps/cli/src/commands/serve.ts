import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { Command } from 'commander';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openStore } from '@repolead/knowledge-store';
import type { ServedRepo } from '@repolead/mcp-server';
import { createServer } from '@repolead/mcp-server';

/** Bases de RepoLead en <dir> y sus subdirectorios inmediatos. */
function discoverDatabases(dir: string): { name: string; dbPath: string }[] {
  const root = resolve(dir);
  const candidates = [root, ...readdirSync(root).map((entry) => join(root, entry))];
  return candidates
    .filter((path) => {
      try {
        return statSync(path).isDirectory() && existsSync(join(path, '.repolead', 'repolead.db'));
      } catch {
        return false;
      }
    })
    .map((path) => ({ name: basename(path), dbPath: join(path, '.repolead', 'repolead.db') }));
}

export function registerServe(program: Command): void {
  program
    .command('serve')
    .description('Levanta el servidor MCP de RepoLead sobre stdio (uno o varios repos)')
    .option('--db <path>', 'una base SQLite concreta', '.repolead/repolead.db')
    .option('--dir <path>', 'sirve todos los repos con .repolead/repolead.db bajo este directorio')
    .action(async (options: { db: string; dir?: string }) => {
      const repos: ServedRepo[] = [];
      if (options.dir) {
        for (const found of discoverDatabases(options.dir)) {
          repos.push({ name: found.name, store: await openStore(found.dbPath) });
        }
        if (repos.length === 0) {
          console.error(`Sin bases bajo ${options.dir}: corre \`repolead onboard\` en cada repo primero.`);
          process.exitCode = 1;
          return;
        }
      } else {
        const store = await openStore(options.db);
        const snapshot = store.getLatestSnapshot();
        const repository = snapshot ? store.getRepository(snapshot.repositoryId) : null;
        repos.push({ name: repository?.name ?? 'repo', store });
      }

      const server = createServer(repos);
      // stdout es el canal MCP: cualquier log va a stderr.
      console.error(`RepoLead MCP server listo (stdio) · ${repos.map((repo) => repo.name).join(', ')}`);
      await server.connect(new StdioServerTransport());
    });
}
