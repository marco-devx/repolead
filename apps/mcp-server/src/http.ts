import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createNodeServer } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { ServedRepo, ServerOptions } from './server';
import { createServer } from './server';

export interface HttpServerOptions extends ServerOptions {
  port: number;
  /** Bearer token requerido en cada request. */
  token: string;
  host?: string;
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = Buffer.from(token);
  const received = Buffer.from(provided);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    request.on('end', () => {
      try {
        resolvePromise(raw.length > 0 ? JSON.parse(raw) : undefined);
      } catch (error) {
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.on('error', rejectPromise);
  });
}

/**
 * MCP sobre Streamable HTTP en modo stateless: una instancia de servidor por
 * request (los stores se comparten, abiertos una sola vez). Pensado para
 * despliegues remotos: clientes como el conector MCP de claude.ai o Claude
 * Code con `--transport http`.
 */
export function startHttpServer(repos: ServedRepo[], options: HttpServerOptions): Promise<Server> {
  const httpServer = createNodeServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.url !== '/mcp') {
        response.writeHead(404).end();
        return;
      }
      if (!authorized(request, options.token)) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      try {
        const body = await readBody(request);
        const server = createServer(repos, { exposeSource: options.exposeSource });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        response.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch {
        if (!response.headersSent) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'bad request' }));
        }
      }
    })();
  });

  return new Promise((resolvePromise) => {
    httpServer.listen(options.port, options.host ?? '0.0.0.0', () => resolvePromise(httpServer));
  });
}
