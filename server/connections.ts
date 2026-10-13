import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Workbench } from './workbench.ts';

// Remote MCP servers every run can use, set up in Settings. Each one authenticates with either
// OAuth 2.1 (dynamic client registration + PKCE) or static headers. A `workbench` connection is an
// MCP gateway that also powers the apps, Jira and team-hub features.

export type ConnKind = 'workbench' | 'mcp';
export type ConnAuth = 'oauth' | 'header';
export type ConnUser = { id: string | null; name: string | null; email: string | null };

type OAuthState = {
  clientId: string | null;
  redirectUri: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  user: ConnUser | null;
};

type Stored = { name: string; kind: ConnKind; url: string; auth: ConnAuth; headers?: Record<string, string>; oauth?: OAuthState; createdAt: string };

export type ConnectionView = {
  name: string;
  kind: ConnKind;
  url: string;
  auth: ConnAuth;
  connected: boolean;
  user: ConnUser | null;
  // names only: header values are secrets and never leave the server
  headerNames: string[];
};

export type NewConnection = { name: string; kind: ConnKind; url: string; auth: ConnAuth; headers?: Record<string, string> };

type Metadata = { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string };
type Pending = { name: string; verifier: string; createdAt: number };

const PENDING_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 60_000;
// becomes the MCP server name inside Claude Code, so tools show up as mcp__<name>__<tool>
export const CONN_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

const b64url = (b: Buffer) => b.toString('base64url');

export function connectionsPath(): string {
  return process.env.LEGOS_CONNECTIONS ?? join(homedir(), '.legos-factory', 'connections.json');
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class Connections {
  private list: Stored[] = [];
  private loaded = false;
  private meta = new Map<string, Metadata>();
  private pending = new Map<string, Pending>();
  private refreshing = new Map<string, Promise<string | null>>();
  private readonly path: string;
  private readonly http: typeof fetch;

  constructor(private cfg: { callbackUrl: string; path?: string; fetch?: typeof fetch }) {
    this.path = cfg.path ?? connectionsPath();
    this.http = cfg.fetch ?? fetch;
  }

  private async load() {
    if (this.loaded) return;
    try {
      this.list = JSON.parse(await readFile(this.path, 'utf8')).connections ?? [];
    } catch {
      // first run, or unreadable: start empty
    }
    this.loaded = true;
  }

  // Holds tokens and header secrets: owner-only, write-then-rename.
  private async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ connections: this.list }, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  private async find(name: string): Promise<Stored> {
    await this.load();
    const c = this.list.find((x) => x.name === name);
    if (!c) throw new HttpError(`no connection named ${name}`, 404);
    return c;
  }

  private view(c: Stored): ConnectionView {
    return {
      name: c.name,
      kind: c.kind,
      url: c.url,
      auth: c.auth,
      connected: c.auth === 'header' || !!c.oauth?.accessToken,
      user: c.oauth?.user ?? null,
      headerNames: Object.keys(c.headers ?? {}),
    };
  }

  async all(): Promise<ConnectionView[]> {
    await this.load();
    return this.list.map((c) => this.view(c));
  }

  async add(input: NewConnection): Promise<ConnectionView> {
    await this.load();
    if (!CONN_NAME_RE.test(input.name)) throw new HttpError('name must be lowercase letters, digits, - or _ (max 32)', 400);
    if (this.list.some((c) => c.name === input.name)) throw new HttpError(`a connection named ${input.name} already exists`, 409);
    if (input.kind !== 'workbench' && input.kind !== 'mcp') throw new HttpError('kind must be workbench or mcp', 400);
    if (input.auth !== 'oauth' && input.auth !== 'header') throw new HttpError('auth must be oauth or header', 400);
    if (input.kind === 'workbench' && input.auth !== 'oauth') throw new HttpError('workbench connects with OAuth', 400);
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new HttpError('url is not a valid URL', 400);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL.has(url.hostname))) throw new HttpError('url must be https (http only for localhost)', 400);
    // a bare workbench host means its MCP endpoint
    if (input.kind === 'workbench' && url.pathname === '/') url = new URL('/mcp', url);
    let headers: Record<string, string> | undefined;
    if (input.auth === 'header') {
      const entries = Object.entries(input.headers ?? {}).map(([k, v]) => [k.trim(), String(v).trim()] as const);
      if (!entries.length || entries.some(([k, v]) => !HEADER_NAME_RE.test(k) || !v || /[\r\n]/.test(v))) throw new HttpError('headers need a name and a single-line value', 400);
      headers = Object.fromEntries(entries);
    }
    const c: Stored = { name: input.name, kind: input.kind, url: url.toString().replace(/\/$/, ''), auth: input.auth, headers, createdAt: new Date().toISOString() };
    this.list.push(c);
    await this.save();
    return this.view(c);
  }

  async remove(name: string) {
    const c = await this.find(name);
    this.list = this.list.filter((x) => x !== c);
    this.meta.delete(name);
    await this.save();
  }

  // Forget tokens, keep the client registration so reconnecting is one click.
  async disconnect(name: string) {
    const c = await this.find(name);
    if (c.oauth) Object.assign(c.oauth, { accessToken: null, refreshToken: null, expiresAt: null, user: null });
    await this.save();
  }

  // MCP auth discovery: the server's protected-resource metadata names its authorization server;
  // servers without it (like workbench) are their own authorization server at the origin.
  private async metadata(c: Stored): Promise<Metadata> {
    const hit = this.meta.get(c.name);
    if (hit) return hit;
    const mcp = new URL(c.url);
    let issuer = mcp.origin;
    try {
      const res = await this.http(new URL(`/.well-known/oauth-protected-resource${mcp.pathname}`, mcp.origin), { signal: AbortSignal.timeout(10_000) });
      const as = res.ok ? (await res.json())?.authorization_servers?.[0] : null;
      if (typeof as === 'string') issuer = as;
    } catch {
      // fall back to the origin
    }
    // TODO: uncertain — issuers with a path need RFC 8414 path insertion; only origin-rooted issuers are handled, verify against a real one
    const res = await this.http(new URL('/.well-known/oauth-authorization-server', issuer), { signal: AbortSignal.timeout(10_000) }).catch((err) => {
      throw new HttpError(`${c.name}: could not reach ${new URL(issuer).host} (${err.message})`, 502);
    });
    if (!res.ok) throw new HttpError(`${c.name}: authorization server metadata unavailable (HTTP ${res.status})`, 502);
    const meta = (await res.json()) as Metadata;
    this.meta.set(c.name, meta);
    return meta;
  }

  private async clientId(c: Stored): Promise<string> {
    c.oauth ??= { clientId: null, redirectUri: null, accessToken: null, refreshToken: null, expiresAt: null, user: null };
    if (c.oauth.clientId && c.oauth.redirectUri === this.cfg.callbackUrl) return c.oauth.clientId;
    const meta = await this.metadata(c);
    if (!meta.registration_endpoint) throw new HttpError(`${c.name} does not support client registration`, 502);
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
    if (!res.ok) throw new HttpError(`${c.name}: client registration failed (HTTP ${res.status}): ${await res.text()}`, 502);
    c.oauth.clientId = ((await res.json()) as { client_id: string }).client_id;
    c.oauth.redirectUri = this.cfg.callbackUrl;
    await this.save();
    return c.oauth.clientId;
  }

  // Returns the URL the user opens to authorise this connection.
  async startOAuth(name: string): Promise<string> {
    const c = await this.find(name);
    if (c.auth !== 'oauth') throw new HttpError(`${name} uses headers, not OAuth`, 400);
    const [clientId, meta] = await Promise.all([this.clientId(c), this.metadata(c)]);
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const now = Date.now();
    for (const [k, p] of this.pending) if (now - p.createdAt > PENDING_TTL_MS) this.pending.delete(k);
    this.pending.set(state, { name, verifier, createdAt: now });
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: this.cfg.callbackUrl,
      scope: 'mcp',
      state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      resource: c.url,
    }).toString();
    return url.toString();
  }

  private async tokenRequest(c: Stored, params: Record<string, string>) {
    const meta = await this.metadata(c);
    const res = await this.http(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: await this.clientId(c), resource: c.url }).toString(),
    });
    if (!res.ok) throw new HttpError(`token request failed (HTTP ${res.status})`, res.status);
    return (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  }

  async callback(code: string, state: string): Promise<string> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) throw new Error('connect expired or was not started here — try again from Settings');
    const c = await this.find(p.name);
    const t = await this.tokenRequest(c, { grant_type: 'authorization_code', code, redirect_uri: this.cfg.callbackUrl, code_verifier: p.verifier });
    Object.assign(c.oauth!, {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
      user: c.kind === 'workbench' ? await this.whoami(c, t.access_token) : null,
    });
    await this.save();
    return c.name;
  }

  // Workbench tokens carry only `sub`; its whoami tool returns id + email. Best effort.
  private async whoami(c: Stored, token: string): Promise<ConnUser | null> {
    try {
      return await new Workbench(c.url, this.http).whoami(token);
    } catch {
      return null;
    }
  }

  // Fresh access token, refreshed shortly before expiry; null means "connect again".
  async accessToken(name: string): Promise<string | null> {
    const c = await this.find(name).catch(() => null);
    const o = c?.oauth;
    if (!c || !o?.accessToken) return null;
    if (!o.expiresAt || o.expiresAt - Date.now() > REFRESH_SKEW_MS) return o.accessToken;
    if (!o.refreshToken) return this.expire(c);
    let inflight = this.refreshing.get(name);
    if (!inflight) {
      inflight = this.tokenRequest(c, { grant_type: 'refresh_token', refresh_token: o.refreshToken })
        .then(async (t) => {
          o.accessToken = t.access_token;
          o.refreshToken = t.refresh_token ?? o.refreshToken;
          o.expiresAt = t.expires_in ? Date.now() + t.expires_in * 1000 : null;
          await this.save();
          return o.accessToken;
        })
        // Refresh tokens rotate. Only a definite rejection drops the tokens; a timeout or 5xx keeps
        // them and hands back the stale token so the next request retries the refresh.
        .catch((err) => (err?.status === 400 || err?.status === 401 ? this.expire(c) : o.accessToken))
        .finally(() => this.refreshing.delete(name));
      this.refreshing.set(name, inflight);
    }
    return inflight;
  }

  private async expire(c: Stored): Promise<null> {
    Object.assign(c.oauth!, { accessToken: null, refreshToken: null, expiresAt: null });
    await this.save();
    return null;
  }

  // Headers to attach upstream for this connection right now; null when it needs connecting.
  async headersFor(name: string): Promise<Record<string, string> | null> {
    const c = await this.find(name).catch(() => null);
    if (!c) return null;
    if (c.auth === 'header') return { ...c.headers };
    const token = await this.accessToken(name);
    return token ? { authorization: `Bearer ${token}` } : null;
  }

  async url(name: string): Promise<string | null> {
    return (await this.find(name).catch(() => null))?.url ?? null;
  }

  // The workbench behind apps, Jira and the team hub: the first connected one.
  async workbench(): Promise<{ name: string; url: string; token: string } | null> {
    await this.load();
    for (const c of this.list.filter((x) => x.kind === 'workbench')) {
      const token = await this.accessToken(c.name);
      if (token) return { name: c.name, url: c.url, token };
    }
    return null;
  }
}
