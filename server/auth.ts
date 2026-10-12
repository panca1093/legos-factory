import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Workbench } from './workbench.ts';

// Sign-in: OAuth 2.1 + PKCE against workbench, which fronts the organisation's SSO.
// The same per-user token later authorises that user's workbench MCP calls.

export type User = { sub: string | null; name: string | null; email: string | null };

type Session = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  user: User;
  createdAt: number;
};

type Store = { clientId: string | null; redirectUri: string | null; sessions: Record<string, Session> };

type Pending = { verifier: string; returnTo: string; attempt: string | null; createdAt: number };

type Metadata = { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string };

export type AuthConfig = {
  issuer: string;
  resource: string;
  callbackUrl: string;
  storePath?: string;
  fetch?: typeof fetch;
};

const PENDING_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 60_000;

const b64url = (b: Buffer) => b.toString('base64url');

export function authStorePath(): string {
  return process.env.LEGOS_AUTH_STORE ?? join(homedir(), '.legos-factory', 'auth.json');
}

// Best effort: if the access token is a JWT, read who it belongs to. Opaque tokens yield nulls.
export function userFromToken(token: string): User {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return {
      sub: typeof claims.sub === 'string' ? claims.sub : null,
      name: claims.name ?? claims.preferred_username ?? null,
      email: claims.email ?? null,
    };
  } catch {
    return { sub: null, name: null, email: null };
  }
}

export class Auth {
  private store: Store = { clientId: null, redirectUri: null, sessions: {} };
  private loaded = false;
  private meta: Metadata | null = null;
  private pending = new Map<string, Pending>();
  private refreshing = new Map<string, Promise<string | null>>();
  // login attempt id -> session, for when sign-in finishes in another browser than the app
  private finished = new Map<string, { sid: string; at: number }>();
  private readonly storePath: string;
  private readonly http: typeof fetch;

  constructor(private cfg: AuthConfig) {
    this.storePath = cfg.storePath ?? authStorePath();
    this.http = cfg.fetch ?? fetch;
  }

  private async load() {
    if (this.loaded) return;
    try {
      this.store = { ...this.store, ...JSON.parse(await readFile(this.storePath, 'utf8')) };
    } catch {
      // first run, or unreadable: start fresh (users just sign in again)
    }
    this.loaded = true;
  }

  // Holds refresh tokens: owner-only permissions.
  private async save() {
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 });
    // write-then-rename so a crash or concurrent reader never sees half a file
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.storePath);
  }

  private async metadata(): Promise<Metadata> {
    if (this.meta) return this.meta;
    const res = await this.http(new URL('/.well-known/oauth-authorization-server', this.cfg.issuer));
    if (!res.ok) throw new Error(`workbench metadata unavailable (HTTP ${res.status})`);
    this.meta = (await res.json()) as Metadata;
    return this.meta;
  }

  // Dynamic client registration, once per callback URL.
  private async clientId(): Promise<string> {
    await this.load();
    if (this.store.clientId && this.store.redirectUri === this.cfg.callbackUrl) return this.store.clientId;
    const meta = await this.metadata();
    if (!meta.registration_endpoint) throw new Error('workbench does not support client registration');
    const res = await this.http(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'legos-factory',
        redirect_uris: [this.cfg.callbackUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'mcp',
      }),
    });
    if (!res.ok) throw new Error(`client registration failed (HTTP ${res.status}): ${await res.text()}`);
    const { client_id } = (await res.json()) as { client_id: string };
    this.store.clientId = client_id;
    this.store.redirectUri = this.cfg.callbackUrl;
    await this.save();
    return client_id;
  }

  async loginUrl(returnTo: string, attempt: string | null = null): Promise<string> {
    const [clientId, meta] = await Promise.all([this.clientId(), this.metadata()]);
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const now = Date.now();
    for (const [k, p] of this.pending) if (now - p.createdAt > PENDING_TTL_MS) this.pending.delete(k);
    this.pending.set(state, { verifier, returnTo, attempt, createdAt: now });
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: this.cfg.callbackUrl,
      scope: 'mcp',
      state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      resource: this.cfg.resource,
    }).toString();
    return url.toString();
  }

  private async tokenRequest(params: Record<string, string>) {
    const meta = await this.metadata();
    const res = await this.http(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: (await this.clientId()), resource: this.cfg.resource }).toString(),
    });
    if (!res.ok) throw Object.assign(new Error(`token request failed (HTTP ${res.status})`), { status: res.status });
    return (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  }

  async callback(code: string, state: string): Promise<{ sid: string; returnTo: string; attempt: string | null }> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) throw new Error('login expired or was not started here — try again');
    const t = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.callbackUrl, code_verifier: p.verifier });
    const sid = b64url(randomBytes(32));
    this.store.sessions[sid] = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
      user: (await this.whoami(t.access_token)) ?? userFromToken(t.access_token),
      createdAt: Date.now(),
    };
    await this.save();
    if (p.attempt) this.finished.set(p.attempt, { sid, at: Date.now() });
    return { sid, returnTo: p.returnTo, attempt: p.attempt };
  }

  // One-time: hands the finished login's session to whichever browser started it.
  claim(attempt: string): string | null {
    const f = this.finished.get(attempt);
    this.finished.delete(attempt);
    return f && Date.now() - f.at < PENDING_TTL_MS ? f.sid : null;
  }

  // Workbench tokens carry only `sub`; its `whoami` MCP tool returns id + email. Best effort.
  private async whoami(token: string): Promise<User | null> {
    try {
      const me = await new Workbench(this.cfg.resource, this.http).whoami(token);
      return me ? { sub: me.id, name: me.name, email: me.email } : null;
    } catch {
      return null;
    }
  }

  async user(sid: string | undefined): Promise<User | null> {
    if (!sid) return null;
    await this.load();
    return this.store.sessions[sid]?.user ?? null;
  }

  // Fresh access token for a session, refreshing shortly before expiry; null means "sign in again".
  async accessToken(sid: string): Promise<string | null> {
    await this.load();
    const s = this.store.sessions[sid];
    if (!s) return null;
    if (!s.expiresAt || s.expiresAt - Date.now() > REFRESH_SKEW_MS) return s.accessToken;
    if (!s.refreshToken) return this.drop(sid);
    let inflight = this.refreshing.get(sid);
    if (!inflight) {
      inflight = this.tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refreshToken })
        .then(async (t) => {
          s.accessToken = t.access_token;
          s.refreshToken = t.refresh_token ?? s.refreshToken;
          s.expiresAt = t.expires_in ? Date.now() + t.expires_in * 1000 : null;
          await this.save();
          return s.accessToken;
        })
        // Workbench rotates refresh tokens. Only a definite rejection ends the session; a timeout or 5xx
        // keeps it and hands back the stale token so the next request can retry the refresh.
        .catch((err) => (err?.status === 400 || err?.status === 401 ? this.drop(sid) : s.accessToken))
        .finally(() => this.refreshing.delete(sid));
      this.refreshing.set(sid, inflight);
    }
    return inflight;
  }

  private async drop(sid: string): Promise<null> {
    delete this.store.sessions[sid];
    await this.save();
    return null;
  }

  async logout(sid: string | undefined) {
    if (!sid) return;
    await this.load();
    if (this.store.sessions[sid]) await this.drop(sid);
  }
}
