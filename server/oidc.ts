import { createPublicKey, randomBytes, verify, createHash, type KeyObject } from 'node:crypto';

// Generic OpenID Connect sign-in (authorization code with PKCE) for one identity provider per deployment.

export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  // the sign-in button's text
  label?: string;
  scopes?: string;
  // only these e-mail domains may sign in; unset allows everyone the issuer vouches for
  allowedDomains?: string[];
};

export type OidcIdentity = { sub: string; email: string | null; name: string };

type Meta = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; userinfo_endpoint?: string; token_endpoint_auth_methods_supported?: string[] };
type Pending = { verifier: string; nonce: string; attempt: string; redirectUri: string; at: number };

const PENDING_TTL_MS = 10 * 60_000;
const SKEW_MS = 60_000;
const JWKS_MIN_REFETCH_MS = 60_000;

export class OidcError extends Error {}
function fail(message: string): never {
  throw new OidcError(message);
}

const b64url = (b: Buffer) => b.toString('base64url');
const json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export class Oidc {
  private meta: Promise<Meta> | null = null;
  private pending = new Map<string, Pending>();
  private jwks: { keys: any[]; at: number } | null = null;

  constructor(
    private cfg: OidcConfig,
    private http: typeof fetch = fetch,
    private now = () => Date.now(),
  ) {}

  get label(): string {
    return this.cfg.label ?? 'SSO';
  }

  private discover(): Promise<Meta> {
    this.meta ??= (async () => {
      const issuer = this.cfg.issuer.replace(/\/$/, '');
      const res = await this.http(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) }).catch((err) => fail(`could not reach the identity provider: ${err.message}`));
      if (!res.ok) fail(`the identity provider's discovery document is unavailable (HTTP ${res.status})`);
      const meta = (await res.json()) as Meta;
      // the document must be the issuer's own, or anyone could point us at another one
      if (meta.issuer?.replace(/\/$/, '') !== issuer) fail('the discovery document names a different issuer');
      for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) if (typeof meta[k] !== 'string') fail(`the discovery document has no ${k}`);
      return meta;
    })().catch((err) => {
      this.meta = null;
      throw err;
    });
    return this.meta;
  }

  // The URL to send the person to. `attempt` ties the callback to the app waiting for it.
  async begin(redirectUri: string, attempt: string): Promise<string> {
    const meta = await this.discover();
    for (const [k, p] of this.pending) if (this.now() - p.at > PENDING_TTL_MS) this.pending.delete(k);
    const state = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(16));
    this.pending.set(state, { verifier, nonce, attempt, redirectUri, at: this.now() });
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      ...Object.fromEntries(url.searchParams),
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      scope: this.cfg.scopes ?? 'openid email profile',
      state,
      nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  // Trades the callback's code for an ID token and checks everything the token and the flow promise.
  async complete(code: string, state: string): Promise<{ identity: OidcIdentity; attempt: string }> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || this.now() - p.at > PENDING_TTL_MS) fail('sign-in expired or was not started here — try again');
    const meta = await this.discover();
    const token = await this.exchange(meta, code, p);
    const claims = await this.verifyIdToken(meta, token.id_token, p.nonce);
    const identity = await this.identify(meta, claims, token.access_token);
    return { identity, attempt: p.attempt };
  }

  private async exchange(meta: Meta, code: string, p: Pending): Promise<{ id_token: string; access_token?: string }> {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: this.cfg.clientId, code_verifier: p.verifier });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const methods = meta.token_endpoint_auth_methods_supported;
    if (methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) body.set('client_secret', this.cfg.clientSecret);
    else headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64')}`;
    const res = await this.http(meta.token_endpoint, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) fail(`the identity provider refused the sign-in code (HTTP ${res.status})`);
    const out = (await res.json()) as { id_token?: string; access_token?: string };
    return typeof out.id_token === 'string' ? (out as { id_token: string }) : fail('the identity provider sent no ID token');
  }

  private async key(kid: string | undefined): Promise<KeyObject> {
    const find = () => {
      const keys = (this.jwks?.keys ?? []).filter((k) => k.kty === 'RSA' && (k.use === undefined || k.use === 'sig'));
      return kid ? keys.find((k) => k.kid === kid) : keys.length === 1 ? keys[0] : undefined;
    };
    if (!find() && (!this.jwks || this.now() - this.jwks.at > JWKS_MIN_REFETCH_MS)) {
      const res = await this.http((await this.discover()).jwks_uri, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) fail(`the identity provider's signing keys are unavailable (HTTP ${res.status})`);
      this.jwks = { keys: ((await res.json()) as { keys?: any[] }).keys ?? [], at: this.now() };
    }
    const jwk = find() ?? fail('the ID token is signed with a key the identity provider does not publish');
    return createPublicKey({ key: jwk, format: 'jwk' });
  }

  private async verifyIdToken(meta: Meta, idToken: string, nonce: string): Promise<Record<string, any>> {
    const parts = idToken.split('.');
    if (parts.length !== 3) fail('the ID token is malformed');
    let header: any;
    let claims: any;
    try {
      header = json(parts[0]);
      claims = json(parts[1]);
    } catch {
      return fail('the ID token is malformed');
    }
    if (header.alg !== 'RS256') fail(`the ID token uses an unsupported algorithm (${header.alg})`);
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!verify('RSA-SHA256', signed, await this.key(header.kid), Buffer.from(parts[2], 'base64url'))) fail('the ID token signature is invalid');
    if (claims.iss?.replace(/\/$/, '') !== meta.issuer.replace(/\/$/, '')) fail('the ID token was issued by someone else');
    const aud: string[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.cfg.clientId)) fail('the ID token is meant for another application');
    if (aud.length > 1 && claims.azp !== this.cfg.clientId) fail('the ID token was authorised for another application');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < this.now() - SKEW_MS) fail('the ID token has expired');
    if (typeof claims.iat === 'number' && claims.iat * 1000 > this.now() + SKEW_MS) fail('the ID token was issued in the future');
    if (claims.nonce !== nonce) fail('the ID token does not belong to this sign-in');
    if (typeof claims.sub !== 'string' || !claims.sub) fail('the ID token names no subject');
    return claims;
  }

  private async identify(meta: Meta, claims: Record<string, any>, accessToken?: string): Promise<OidcIdentity> {
    let { email, email_verified: verified } = claims;
    if (!email && meta.userinfo_endpoint && accessToken) {
      const res = await this.http(meta.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
      const info = res.ok ? ((await res.json()) as Record<string, any>) : {};
      if (info.sub === claims.sub) ({ email, email_verified: verified } = info);
    }
    email = typeof email === 'string' && email ? email.toLowerCase() : null;
    if (email && verified === false) fail('the identity provider has not verified your e-mail address');
    const domains = this.cfg.allowedDomains?.map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (domains?.length && (!email || !domains.includes(email.split('@')[1]))) fail('your e-mail address is not allowed to sign in here');
    return { sub: claims.sub, email, name: String(claims.name || claims.preferred_username || email || claims.sub).slice(0, 64) };
  }
}
