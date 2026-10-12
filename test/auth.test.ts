import { createHash } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { Auth, userFromToken } from '../server/auth.ts';
import { RunManager, type QueryFn } from '../server/claude-runs.ts';
import { ActivityLog } from '../server/activity.ts';

const WB = 'https://wb.test';
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

// Fake workbench: OAuth metadata, client registration, token endpoint, and an MCP endpoint echoing the bearer.
function fakeWorkbench(opts: { expiresIn?: number } = {}) {
  const calls: { url: string; body?: string; auth?: string | null }[] = [];
  let n = 0;
  let lastChallenge = '';
  const fetchFn = (async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : init.body;
    calls.push({ url, body, auth: new Headers(init.headers).get('authorization') });
    if (url.endsWith('/.well-known/oauth-authorization-server'))
      return Response.json({ authorization_endpoint: `${WB}/authorize`, token_endpoint: `${WB}/token`, registration_endpoint: `${WB}/register` });
    if (url === `${WB}/register`) return Response.json({ client_id: 'client-1' });
    if (url === `${WB}/token`) {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        const ok = createHash('sha256').update(p.get('code_verifier')!).digest('base64url') === lastChallenge;
        if (!ok) return new Response('bad verifier', { status: 400 });
      }
      n++;
      return Response.json({ access_token: jwt({ sub: 'u1', name: 'Ada', email: 'p@acme.test', n }), refresh_token: `r${n}`, expires_in: opts.expiresIn ?? 3600 });
    }
    if (url === `${WB}/mcp`) {
      const msg = body ? JSON.parse(body) : {};
      if (msg.method === 'tools/call' && msg.params?.name === 'whoami')
        return Response.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ id: 'u1', email: 'who@acme.test' }) }] } });
      return new Response(JSON.stringify({ seen: new Headers(init.headers).get('authorization') }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'm1' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls, setChallenge: (c: string) => (lastChallenge = c) };
}

// stays alive until its input closes, like a real session; grants are revoked when a run ends
const alive = (({ prompt }: any) => {
  const it = (async function* () {
    for await (const _ of prompt as AsyncIterable<unknown>);
  })() as any;
  it.interrupt = async () => {};
  return it;
}) as unknown as QueryFn;

function setup(opts: { expiresIn?: number; hub?: boolean } = {}) {
  const wb = fakeWorkbench(opts);
  const pushed: { auth: string | null; body: any }[] = [];
  const hubFetch = (async (input: any, init: any = {}) => {
    if (String(input).startsWith('https://hub.test/')) {
      pushed.push({ auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(init.body) : null });
      return Response.json(String(input).includes('/hub/team') ? { me: 'x', members: [] } : { accepted: 1 });
    }
    return wb.fetchFn(input, init);
  }) as typeof fetch;
  const storePath = join(mkdtempSync(join(tmpdir(), 'lf-auth-')), 'auth.json');
  const auth = new Auth({ issuer: WB, resource: `${WB}/mcp`, callbackUrl: 'http://localhost:4317/auth/callback', storePath, fetch: wb.fetchFn });
  const runs = new RunManager(alive);
  const activity = new ActivityLog(join(mkdtempSync(join(tmpdir(), 'lf-act-')), 'a.jsonl'));
  const app = createApp(runs, {
    auth,
    workbenchMcpUrl: `${WB}/mcp`,
    selfUrl: 'http://localhost:4317',
    fetch: opts.hub ? hubFetch : wb.fetchFn,
    activity,
    hubUrl: opts.hub ? 'https://hub.test' : null,
  });
  const req = (path: string, init: RequestInit = {}, cookie?: string) =>
    app.request(`http://localhost:4317${path}`, { ...init, headers: { host: 'localhost:4317', ...(cookie && { cookie }), ...(init.headers as any) } });

  async function login(): Promise<string> {
    const start = await req('/auth/login?returnTo=' + encodeURIComponent('http://localhost:5173/#/tasks'));
    const authorize = new URL(start.headers.get('location')!);
    wb.setChallenge(authorize.searchParams.get('code_challenge')!);
    const cb = await req(`/auth/callback?code=abc&state=${authorize.searchParams.get('state')}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('http://localhost:5173/#/tasks');
    return cb.headers.get('set-cookie')!.split(';')[0];
  }
  return { wb, auth, runs, req, login, storePath, pushed, activity };
}

beforeAll(() => {
  process.env.CLAUDE_PROJECTS_DIR = join(import.meta.dirname, 'fixtures/projects');
  process.env.LEGOS_SETTINGS = join(import.meta.dirname, 'fixtures/settings/app.json');
});

describe('sign in via workbench', () => {
  it('gates the API until the user signs in', async () => {
    const { req, login } = setup();
    expect((await req('/api/sessions')).status).toBe(401);
    expect(await (await req('/auth/me')).json()).toMatchObject({ authEnabled: true, authenticated: false });

    const cookie = await login();
    expect((await req('/api/sessions', {}, cookie)).status).toBe(200);
    // identity comes from workbench whoami, not the (sub-only) token
    expect(await (await req('/auth/me', {}, cookie)).json()).toMatchObject({ authenticated: true, user: { sub: 'u1', email: 'who@acme.test' } });
  });

  it('registers once, uses PKCE, and asks for the workbench resource', async () => {
    const { req, wb } = setup();
    const a = new URL((await req('/auth/login')).headers.get('location')!);
    await req('/auth/login');
    expect(wb.calls.filter((c) => c.url.endsWith('/register'))).toHaveLength(1);
    expect(a.origin + a.pathname).toBe(`${WB}/authorize`);
    expect(Object.fromEntries(a.searchParams)).toMatchObject({ client_id: 'client-1', code_challenge_method: 'S256', scope: 'mcp', resource: `${WB}/mcp` });
  });

  it('rejects a callback it did not start, and never redirects off localhost', async () => {
    const { req, wb } = setup();
    expect((await req('/auth/callback?code=x&state=forged')).status).toBe(400);
    const a = new URL((await req('/auth/login?returnTo=' + encodeURIComponent('https://evil.example/'))).headers.get('location')!);
    wb.setChallenge(a.searchParams.get('code_challenge')!);
    const cb = await req(`/auth/callback?code=abc&state=${a.searchParams.get('state')}`);
    expect(cb.headers.get('location')).toBe('/');
  });

  it('refreshes an expiring token and keeps the store owner-only', async () => {
    const { auth, login, wb, storePath } = setup({ expiresIn: 30 });
    const sid = (await login()).split('=')[1];
    const before = wb.calls.filter((c) => c.url.endsWith('/token')).length;
    const [t1, t2] = await Promise.all([auth.accessToken(sid), auth.accessToken(sid)]);
    expect(t1).toBe(t2);
    expect(wb.calls.filter((c) => c.url.endsWith('/token')).length).toBe(before + 1);
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
  });

  it('hands a login finished in another browser to the window that started it, once', async () => {
    const { req, wb } = setup();
    const attempt = 'a'.repeat(48);
    const a = new URL((await req(`/auth/login?attempt=${attempt}`)).headers.get('location')!);
    wb.setChallenge(a.searchParams.get('code_challenge')!);
    // the callback lands in "another browser": it gets a close-me page, not a redirect
    const cb = await req(`/auth/callback?code=abc&state=${a.searchParams.get('state')}`);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain('Signed in to legos-factory');

    const claim = (id: string) => req('/auth/claim', { method: 'POST', headers: { 'x-legos': '1', 'content-type': 'application/json' }, body: JSON.stringify({ attempt: id }) });
    expect(await (await claim('b'.repeat(48))).json()).toEqual({ done: false });
    const ok = await claim(attempt);
    expect(await ok.json()).toEqual({ done: true });
    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    expect((await req('/api/sessions', {}, cookie)).status).toBe(200);
    expect(await (await claim(attempt)).json()).toEqual({ done: false });
    expect((await req('/auth/login?attempt=short')).status).toBe(400);
  });

  it('keeps the session through a transient refresh failure, ends it on rejection', async () => {
    const { auth, login, wb } = setup({ expiresIn: 30 });
    const sid = (await login()).split('=')[1];
    const real = wb.fetchFn;
    let mode: 'down' | 'reject' = 'down';
    (auth as any).http = (async (input: any, init: any) =>
      String(input).endsWith('/token') ? (mode === 'down' ? new Response('bad gateway', { status: 502 }) : new Response('{"error":"invalid_grant"}', { status: 400 })) : real(input, init)) as typeof fetch;
    expect(await auth.accessToken(sid)).not.toBeNull();
    expect(await auth.user(sid)).not.toBeNull();
    mode = 'reject';
    expect(await auth.accessToken(sid)).toBeNull();
    expect(await auth.user(sid)).toBeNull();
  });

  it('logout ends the session', async () => {
    const { req, login } = setup();
    const cookie = await login();
    expect((await req('/auth/logout', { method: 'POST', headers: { 'x-legos': '1' } }, cookie)).status).toBe(200);
    expect((await req('/api/sessions', {}, cookie)).status).toBe(401);
  });
});

describe('workbench-backed API', () => {
  it('needs sign-in and validates Jira input', async () => {
    const { req, login } = setup();
    expect((await req('/api/jira/issues')).status).toBe(401);
    const cookie = await login();
    expect((await req('/api/jira/issues?filter=nope', {}, cookie)).status).toBe(400);
    expect((await req('/api/jira/issues/not-a-key', {}, cookie)).status).toBe(400);
    expect((await req('/api/workbench/connect', { method: 'POST', headers: { 'x-legos': '1' }, body: JSON.stringify({ integration: '../x' }) }, cookie)).status).toBe(400);
  });
});

describe('team activity', () => {
  const start = (req: any, cookie: string, cwd: string, share?: string) =>
    req('/api/runs', { method: 'POST', headers: { 'x-legos': '1', 'content-type': 'application/json' }, body: JSON.stringify({ cwd, prompt: 'hi PROJ-7', share }) }, cookie);
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("pushes shared runs to the hub with the owner's token, keeps private ones home", async () => {
    const { req, login, pushed, activity } = setup({ hub: true });
    const cookie = await login();
    await start(req, cookie, '/tmp', 'private');
    await settle();
    expect(pushed).toHaveLength(0);
    expect((await activity.list(0)).length).toBe(1); // still in my activity

    await start(req, cookie, '/tmp');
    await settle();
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[0].auth).toMatch(/^Bearer h\./);
    expect(pushed[0].body.items[0]).toMatchObject({ ticket: 'PROJ-7', title: 'hi PROJ-7' });
    expect(pushed[0].body.items[0]).not.toHaveProperty('estimatedCostUsd');
  });

  it('serves my activity locally and team activity through the hub', async () => {
    const { req, login } = setup({ hub: true });
    const cookie = await login();
    await start(req, cookie, '/tmp');
    await settle();
    expect((await (await req('/api/activity/me', {}, cookie)).json()).items.length).toBe(1);
    expect(await (await req('/api/team', {}, cookie)).json()).toMatchObject({ configured: true, members: [] });
    const noHub = setup();
    expect((await noHub.req('/api/team', {}, await noHub.login())).status).toBe(409);
  });
});

describe('per-user workbench proxy', () => {
  it("gives each run the workbench MCP with its owner's fresh token", async () => {
    const { req, login, runs } = setup();
    const cookie = await login();
    let mcp: any;
    const orig = runs.start.bind(runs);
    runs.start = (r) => ((mcp = r.mcp), orig(r));
    const res = await req('/api/runs', { method: 'POST', headers: { 'x-legos': '1', 'content-type': 'application/json' }, body: JSON.stringify({ cwd: '/tmp', prompt: 'hi' }) }, cookie);
    expect(res.status).toBe(201);
    expect(mcp).toMatchObject({ name: 'workbench', url: 'http://localhost:4317/mcp/workbench' });

    const call = await req('/mcp/workbench', { method: 'POST', headers: { ...mcp.headers, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0"}' });
    expect(call.status).toBe(200);
    expect(call.headers.get('mcp-session-id')).toBe('m1');
    expect((await call.json()).seen).toMatch(/^Bearer h\./);

    expect((await req('/mcp/workbench', { method: 'POST', headers: { 'x-legos-run': 'guess' } })).status).toBe(403);

    // ending the run revokes its access
    await runs.end((await res.json()).id);
    await new Promise((r) => setTimeout(r, 10));
    expect((await req('/mcp/workbench', { method: 'POST', headers: mcp.headers })).status).toBe(403);
  });
});

describe('userFromToken', () => {
  it('reads JWT claims and tolerates opaque tokens', () => {
    expect(userFromToken(jwt({ sub: 's', preferred_username: 'ada' }))).toEqual({ sub: 's', name: 'ada', email: null });
    expect(userFromToken('opaque-token')).toEqual({ sub: null, name: null, email: null });
  });
});
