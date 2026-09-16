import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { Command } from 'commander';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openStore } from '@repolead/knowledge-store';
import type { ServedRepo } from '@repolead/mcp-server';
import { createServer, startHttpServer } from '@repolead/mcp-server';

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
    .option('--http', 'sirve por HTTP (Streamable HTTP) en vez de stdio')
    .option('--port <port>', 'puerto HTTP', '3939')
    .option('--token <token>', 'bearer token para HTTP (o env REPOLEAD_TOKEN)')
    .option('--no-source', 'modo producto: nunca servir código fuente crudo')
    .action(async (options: {
      db: string;
      dir?: string;
      http?: boolean;
      port: string;
      token?: string;
      source: boolean;
    }) => {
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

      if (options.http) {
        const token = options.token ?? process.env['REPOLEAD_TOKEN'];
        if (!token) {
          console.error('HTTP requiere autenticación: pasa --token o define REPOLEAD_TOKEN.');
          process.exitCode = 1;
          return;
        }
        const port = Number(options.port);
        await startHttpServer(repos, { port, token, exposeSource: options.source });
        console.error(
          `RepoLead MCP server listo (http://0.0.0.0:${port}/mcp) · ${repos.map((repo) => repo.name).join(', ')}${options.source ? '' : ' · sin código fuente'}`,
        );
        return;
      }

      const server = createServer(repos, { exposeSource: options.source });
      // stdout es el canal MCP: cualquier log va a stderr.
      console.error(`RepoLead MCP server listo (stdio) · ${repos.map((repo) => repo.name).join(', ')}`);
      await server.connect(new StdioServerTransport());
    });
}
