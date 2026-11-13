import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { Command } from 'commander';
import { Option } from 'commander';

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
    .option('--host <host>', 'interfaz HTTP; usa 0.0.0.0 para despliegue remoto', '127.0.0.1')
    .option('--allow-origin <origin>', 'origen HTTP(S) permitido; repetible para clientes de navegador', (value: string, previous: string[]) => [...previous, value], [])
    .option('--token <token>', 'bearer token para HTTP (o env REPOLEAD_TOKEN)')
    .option('--no-source', 'restringe lecturas de fuente; NO elimina extractos o recursos técnicos')
    .option('--product', 'proyección funcional: 4 herramientas, sin código, documentos crudos ni recursos técnicos; SQLite de solo lectura')
    .option('--only <names>', 'repos autorizados, separados por comas; obligatorio con --product --dir')
    .addOption(new Option('--tool-profile <profile>', 'catálogo MCP: completo o solo contexto (4 herramientas)').choices(['all', 'context']).default('all'))
    .action(async (options: {
      db: string;
      dir?: string;
      http?: boolean;
      port: string;
      host: string;
      allowOrigin: string[];
      token?: string;
      source: boolean;
      product?: boolean;
      only?: string;
      toolProfile: 'all' | 'context';
    }) => {
      const repos: ServedRepo[] = [];
      const allowed = options.only ? new Set(options.only.split(',').map((name) => name.trim()).filter(Boolean)) : null;
      if (options.product && options.dir && !allowed?.size) { throw new Error('--product --dir requiere --only con los repositorios autorizados.'); }
      let discoveryTimer: ReturnType<typeof setInterval> | undefined;
      let closed = false;
      const closeStores = () => { if (!closed) { closed = true; clearInterval(discoveryTimer); for (const repo of repos) { repo.store.close(); } } };
      let discovery: Promise<void> | null = null;
      const discover = (): Promise<void> => {
        if (discovery) { return discovery; }
        discovery = (async () => {
          for (const found of discoverDatabases(options.dir!)) {
            if (closed || (allowed && !allowed.has(found.name)) || repos.some((repo) => repo.name === found.name)) { continue; }
            try {
              const store = await openStore(found.dbPath, { readonly: options.product });
              // Newly created databases may not have finished their initial migration yet.
              try { store.getLatestSnapshot(); } catch (error) { store.close(); throw error; }
              if (closed) { store.close(); } else { repos.push({ name: found.name, store }); }
            } catch (error) { if (!options.product) { throw error; } }
          }
        })().finally(() => { discovery = null; });
        return discovery;
      };
      let serving = false;
      try {
      if (options.dir) {
        await discover();
        if (repos.length === 0 && !options.product) {
          console.error(`Sin bases bajo ${options.dir}: corre \`repolead onboard\` en cada repo primero.`);
          process.exitCode = 1;
          return;
        }
        if (options.product) {
          discoveryTimer = setInterval(() => { void discover().catch(() => { console.error('No se pudo actualizar el inventario de producto.'); }); }, 5000);
          discoveryTimer.unref();
        }
      } else {
        const store = await openStore(options.db, { readonly: options.product });
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
        const listening = await startHttpServer(repos, { port, host: options.host, allowedOrigins: options.allowOrigin, token, exposeSource: options.source, toolProfile: options.toolProfile, product: options.product });
        listening.once('close', closeStores);
        serving = true;
        const address = listening.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        console.error(
          `RepoLead MCP server listo (http://${options.host}:${actualPort}/mcp) · ${repos.map((repo) => repo.name).join(', ')}${options.product ? ' · proyección funcional de producto' : options.source ? '' : ' · lecturas de fuente desactivadas'}`,
        );
        return;
      }

      const server = createServer(repos, { exposeSource: options.source, toolProfile: options.toolProfile, product: options.product });
      // stdout es el canal MCP: cualquier log va a stderr.
      console.error(`RepoLead MCP server listo (stdio) · ${repos.map((repo) => repo.name).join(', ')}`);
      const transport = new StdioServerTransport();
      transport.onclose = closeStores;
      await server.connect(transport);
      serving = true;
      } finally { if (!serving) { closeStores(); } }
    });
}
