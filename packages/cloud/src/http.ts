import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CorporateSso, SsoDenied } from './sso';
import type { SsoSettings } from './sso';
import { createCloudProductServer } from './product-server';

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) { throw new Error('Body exceeds limit'); }
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

/** SSO is mandatory here. The legacy demo's shared bearer token is never accepted. */
export async function startCloudHttp(pool: pg.Pool, settings: SsoSettings & {
  host?: string; port?: number; allowedOrigins?: string[];
}) {
  const auth = new CorporateSso(settings, pool);
  const origins = new Set(settings.allowedOrigins ?? []);
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url?.split('?')[0];
      if (path === '/healthz' && request.method === 'GET') {
        try { await pool.query('SELECT 1 FROM repolead_repositories LIMIT 1'); json(response, 200, { status: 'ok' }); }
        catch { json(response, 503, { status: 'database-unavailable' }); }
        return;
      }
      if (['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path ?? '') && request.method === 'GET') {
        json(response, 200, auth.metadata()); return;
      }
      if (path !== '/mcp' || request.url !== '/mcp') { json(response, 404, { error: 'not-found' }); return; }
      const origin = request.headers.origin;
      if (origin && !origins.has(origin)) { request.resume(); json(response, 403, { error: 'origin-not-allowed' }); return; }
      if (origin) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('vary', 'Origin');
        response.setHeader('access-control-expose-headers', 'WWW-Authenticate,MCP-Protocol-Version');
        if (request.method === 'OPTIONS') {
          response.writeHead(204, { 'access-control-allow-methods': 'POST,GET,DELETE,OPTIONS',
            'access-control-allow-headers': 'Authorization,Content-Type,MCP-Protocol-Version' });
          response.end(); return;
        }
      }
      const identity = await auth.authenticate(request);
      if (Number(request.headers['content-length'] ?? 0) > 1024 * 1024) { request.resume(); json(response, 413, { error: 'body-too-large' }); return; }
      const payload = request.method === 'POST' ? await body(request) : undefined;
      const mcp = createCloudProductServer(pool, identity);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.once('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, payload);
    })().catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof SsoDenied) {
        if (error.status === 401) { response.setHeader('www-authenticate', auth.challenge()); }
        request.resume(); json(response, error.status, { error: error.status === 403 ? 'access-not-granted' : error.status === 503 ? 'identity-provider-unavailable' : 'authentication-required' });
      } else { json(response, 400, { error: 'request-could-not-be-processed' }); }
    });
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(settings.port ?? 3939, settings.host ?? '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  return server;
}
