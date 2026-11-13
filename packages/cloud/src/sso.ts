import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { IncomingMessage } from 'node:http';
import type pg from 'pg';

export interface CloudIdentity { subject: string; issuer: string; email: string; repositories: string[] }
export interface SsoSettings { issuer: string; resource: string; allowHttpLoopback?: boolean }
export class SsoDenied extends Error { constructor(readonly status: 401 | 403 | 503) { super('SSO access denied'); } }

/** Same corporate identity provider as tickets-portal; permissions are current grants in PG. */
export class CorporateSso {
  private discovered: Promise<{ jwks: ReturnType<typeof createRemoteJWKSet> }> | null = null;
  readonly metadataUrl: string;
  constructor(readonly settings: SsoSettings, private readonly pool: pg.Pool) {
    for (const address of [settings.issuer, settings.resource]) {
      const url = new URL(address);
      if (url.username || url.password || url.search || url.hash
        || (url.protocol !== 'https:' && !(settings.allowHttpLoopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('SSO issuer and public MCP resource require HTTPS (HTTP loopback is test/development only).');
      }
    }
    if (new URL(settings.resource).pathname !== '/mcp') { throw new Error('The public MCP resource must end in /mcp.'); }
    this.metadataUrl = `${new URL(settings.resource).origin}/.well-known/oauth-protected-resource/mcp`;
  }

  metadata() {
    return { resource: this.settings.resource, authorization_servers: [this.settings.issuer],
      scopes_supported: ['openid', 'profile', 'email'], bearer_methods_supported: ['header'], resource_name: 'RepoLead Producto' };
  }

  challenge(): string { return `Bearer resource_metadata="${this.metadataUrl}", scope="openid profile email"`; }

  private discovery() {
    if (!this.discovered) {
      this.discovered = (async () => {
        const response = await fetch(`${this.settings.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) { throw new Error('OIDC discovery unavailable'); }
        const data = await response.json() as { issuer?: string; jwks_uri?: string };
        if (data.issuer !== this.settings.issuer || !data.jwks_uri) { throw new Error('OIDC issuer mismatch'); }
        const jwksUrl = new URL(data.jwks_uri);
        if (jwksUrl.origin !== new URL(this.settings.issuer).origin) { throw new Error('OIDC JWKS must share the configured provider origin'); }
        return { jwks: createRemoteJWKSet(jwksUrl, { timeoutDuration: 10000, cooldownDuration: 30000 }) };
      })().catch((error: unknown) => { this.discovered = null; throw error; });
    }
    return this.discovered;
  }

  async authenticate(request: IncomingMessage): Promise<CloudIdentity> {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length > 32768) { throw new SsoDenied(401); }
    let discovery: Awaited<ReturnType<CorporateSso['discovery']>>;
    try { discovery = await this.discovery(); } catch { throw new SsoDenied(503); }
    let payload;
    try {
      ({ payload } = await jwtVerify(authorization.slice(7), discovery.jwks, { issuer: this.settings.issuer,
        audience: this.settings.resource, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 }));
      if (!payload.sub || payload.email_verified !== true || typeof payload.email !== 'string' || payload.typ !== 'Bearer') { throw new Error('Not a verified Keycloak access token'); }
      if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes('openid')) { throw new Error('Missing OIDC scope'); }
    } catch { throw new SsoDenied(401); }
    const email = payload.email.toLowerCase();
    const grant = await this.pool.query(`SELECT repositories FROM repolead_readers
      WHERE issuer=$1 AND email=$2 AND enabled=true AND (subject IS NULL OR subject=$3)`, [this.settings.issuer, email, payload.sub]);
    if (!grant.rowCount || !grant.rows[0].repositories.length) { throw new SsoDenied(403); }
    return { issuer: this.settings.issuer, subject: payload.sub, email, repositories: grant.rows[0].repositories as string[] };
  }
}
