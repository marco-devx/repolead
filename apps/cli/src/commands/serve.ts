import type { Command } from 'commander';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openStore } from '@repolead/knowledge-store';
import { createServer } from '@repolead/mcp-server';

export function registerServe(program: Command): void {
  program
    .command('serve')
    .description('Levanta el servidor MCP de RepoLead sobre stdio')
    .option('--db <path>', 'ruta del archivo SQLite', '.repolead/repolead.db')
    .action(async (options: { db: string }) => {
      const store = await openStore(options.db);
      const server = createServer(store);
      // stdout es el canal MCP: cualquier log va a stderr.
      console.error('RepoLead MCP server listo (stdio)');
      await server.connect(new StdioServerTransport());
    });
}
