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
  allowedOrigins?: string[];
  maxBodyBytes?: number;
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = Buffer.from(token);
  const received = Buffer.from(provided);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

class RequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    let chunks: Buffer[] = []; let bytes = 0; let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; chunks = []; rejectPromise(error); } };
    request.on('data', (chunk: Buffer) => {
      if (settled) { return; }
      bytes += chunk.length;
      if (bytes > maxBytes) { fail(new RequestError(413, 'request too large')); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) { return; }
      try {
        // Decode once: a UTF-8 codepoint can straddle HTTP chunks.
        const raw = Buffer.concat(chunks).toString('utf8');
        chunks = []; settled = true;
        resolvePromise(raw.length > 0 ? JSON.parse(raw) : undefined);
      } catch (error) {
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.on('error', fail);
    request.on('aborted', () => fail(new RequestError(400, 'request aborted')));
  });
}

/**
 * MCP sobre Streamable HTTP en modo stateless: una instancia de servidor por
 * request (los stores se comparten, abiertos una sola vez). Pensado para
 * despliegues remotos: clientes como el conector MCP de claude.ai o Claude
 * Code con `--transport http`.
 */
export async function startHttpServer(repos: ServedRepo[], options: HttpServerOptions): Promise<Server> {
  if (!options.token.trim()) { throw new Error('HTTP requires a nonempty bearer token.'); }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) { throw new Error('HTTP port must be an integer from 0 to 65535.'); }
  const maxBytes = options.maxBodyBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) { throw new Error('maxBodyBytes must be a positive integer.'); }
  const origins = new Set((options.allowedOrigins ?? []).map((value) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Allowed origins must be HTTP(S) origins without credentials, path, query or fragment.');
    }
    return url.origin;
  }));
  // Fail configuration errors before opening a port; request instances remain stateless.
  await createServer(repos, options).close();
  const httpServer = createNodeServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.url !== '/mcp') {
        response.writeHead(404).end();
        return;
      }
      const origin = request.headers.origin;
      if (origin && !origins.has(origin)) {
        response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'origin not allowed' }));
        request.resume(); return;
      }
      if (origin) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('vary', 'Origin');
        response.setHeader('access-control-expose-headers', 'MCP-Session-Id, MCP-Protocol-Version');
        if (request.method === 'OPTIONS') {
          response.writeHead(204, { 'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
            'access-control-allow-headers': 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID' }).end();
          request.resume(); return;
        }
      }
      if (!authorized(request, options.token)) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        request.resume();
        return;
      }
      try {
        if (Number(request.headers['content-length'] ?? 0) > maxBytes) { request.resume(); throw new RequestError(413, 'request too large'); }
        const body = await readBody(request, maxBytes);
        const server = createServer(repos, { exposeSource: options.exposeSource, toolProfile: options.toolProfile });
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
      } catch (error) {
        if (!response.headersSent) {
          response.writeHead(error instanceof RequestError ? error.status : 400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: error instanceof RequestError ? error.message : 'bad request' }));
        }
      }
    })();
  });

  httpServer.requestTimeout = 15000;
  httpServer.headersTimeout = 10000;
  return new Promise((resolvePromise, rejectPromise) => {
    httpServer.once('error', rejectPromise);
    httpServer.listen(options.port, options.host ?? '127.0.0.1', () => {
      httpServer.removeListener('error', rejectPromise); resolvePromise(httpServer);
    });
  });
}
