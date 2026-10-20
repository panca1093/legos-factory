import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDeps, createApp } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import { Users } from '../server/users.ts';
import { alive, fakeServers, OTHER, WB } from './fakes.ts';

beforeAll(() => {
  process.env.CLAUDE_PROJECTS_DIR = join(import.meta.dirname, 'fixtures/projects');
  process.env.LEGOS_SETTINGS = join(import.meta.dirname, 'fixtures/settings/app.json');
});

describe('users', () => {
  it('keeps PIN users apart by name and stores the database owner-only', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lf-users-')), 'factory.db');
    const u = new Users(openDb(path));
    await expect(u.createPin('Ada', '12345')).rejects.toThrow(/6 digits/);
    const ada = await u.createPin('Ada', '123456');
    await expect(u.createPin('ada', '000000')).rejects.toThrow(/already exists/);
    await u.createPin('Bob', '654321');
    expect(u.pinNames()).toEqual(['Ada', 'Bob']);
    expect(u.verify(ada.cookie)).toMatchObject({ id: ada.user.id, kind: 'pin', name: 'Ada' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // survives a restart: same signing secret, same users
    expect(new Users(openDb(path)).verify(ada.cookie)?.name).toBe('Ada');
    expect((await u.loginPin('bob', '654321')).ok).toBe(true);
    expect((await u.loginPin('Ada', '654321')).ok).toBe(false);
  });

  it('rejects tampered, foreign and expired cookies', async () => {
    let now = Date.now();
    const u = new Users(openDb(':memory:'), () => now);
    const { cookie, user } = await u.createPin('Ada', '123456');
    const [v, id, exp, sig] = cookie.split('.');
    expect(u.verify(`${v}.${id}.${Number(exp) + 1}.${sig}`)).toBeNull();
    expect(u.verify(`${cookie}x`)).toBeNull();
    expect(u.verify(undefined)).toBeNull();
    expect(new Users(openDb(':memory:')).verify(cookie)).toBeNull(); // another install's secret
    expect(u.verify(u.issue('00000000-0000-0000-0000-000000000000'))).toBeNull(); // no such user
    now += 31 * 24 * 3600_000;
    expect(u.verify(cookie)).toBeNull();
    expect(user.kind).toBe('pin');
  });

  it('locks a name out after repeated misses, doubling each time, without touching other names', async () => {
    let now = Date.now();
    const u = new Users(openDb(':memory:'), () => now);
    await u.createPin('Ada', '123456');
    await u.createPin('Bob', '654321');
    for (let i = 0; i < 4; i++) expect(await u.loginPin('Ada', '000000')).toEqual({ ok: false, retryAfterMs: null });
    expect(await u.loginPin('Ada', '000000')).toEqual({ ok: false, retryAfterMs: 30_000 });
    expect((await u.loginPin('Ada', '123456')).ok).toBe(false); // even the right PIN waits
    expect((await u.loginPin('Bob', '654321')).ok).toBe(true);
    now += 30_000;
    expect(await u.loginPin('Ada', '000000')).toEqual({ ok: false, retryAfterMs: 60_000 });
    now += 60_000;
    expect((await u.loginPin('Ada', '123456')).ok).toBe(true);
    expect(await u.loginPin('Ada', '000000')).toEqual({ ok: false, retryAfterMs: null }); // success resets
  });

  it('treats unknown names like wrong PINs', async () => {
    const u = new Users(openDb(':memory:'));
    for (let i = 0; i < 4; i++) expect(await u.loginPin('nobody', '123456')).toEqual({ ok: false, retryAfterMs: null });
    expect((await u.loginPin('nobody', '123456')).ok).toBe(false);
    expect(((await u.loginPin('nobody', '123456')) as any).retryAfterMs).toBeGreaterThan(0);
  });

  it('keeps one user per external id, separate from PIN users of the same name', async () => {
    const u = new Users(openDb(':memory:'));
    await u.createPin('Ada', '123456');
    const a = u.upsertExternal('workbench', 'sub-1', 'Ada', 'ada@acme.test');
    const again = u.upsertExternal('workbench', 'sub-1', 'Ada L.', 'ada@acme.test');
    expect(again.id).toBe(a.id);
    expect(u.get(a.id)).toMatchObject({ kind: 'workbench', name: 'Ada L.' });
    expect(u.pinNames()).toEqual(['Ada']);
  });
});

function setup(opts: { workbench?: boolean } = {}) {
  const srv = fakeServers();
  const db = openDb(':memory:');
  const runs = new RunManager(alive);
  const options = { users: new Users(db), db, selfUrl: 'http://localhost:4317', fetch: srv.fetchFn, workbenchUrl: opts.workbench ? `${WB}/mcp` : null };
  const deps = buildDeps(runs, options);
  const app = createApp(runs, options, deps);
  const req = (path: string, init: RequestInit = {}, cookie?: string) =>
    app.request(`http://localhost:4317${path}`, { ...init, headers: { host: 'localhost:4317', ...(cookie && { cookie }), ...(init.headers as any) } });
  const post = (path: string, body: unknown, cookie?: string) =>
    req(path, { method: 'POST', body: JSON.stringify(body), headers: { 'x-legos': '1', 'content-type': 'application/json' } }, cookie);
  const signUp = async (name: string, pin = '123456') => cookieOf(await post('/auth/users', { name, pin }));
  return { srv, runs, board: deps.runs, req, post, signUp };
}
const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];

describe('sign-in', () => {
  it('gates the API until someone creates a user or signs in', async () => {
    const { req, post } = setup();
    expect(await (await req('/auth/me')).json()).toMatchObject({ authEnabled: true, workbenchLogin: false, users: [], authenticated: false });
    expect((await req('/api/sessions')).status).toBe(401);
    expect((await post('/auth/users', { name: 'Ada', pin: '12ab56' })).status).toBe(400);
    expect((await post('/auth/users', { name: '', pin: '123456' })).status).toBe(400);

    const s = await post('/auth/users', { name: 'Ada', pin: '123456' });
    expect(s.status).toBe(200);
    expect(s.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect((await req('/api/sessions', {}, cookieOf(s))).status).toBe(200);
    expect((await post('/auth/users', { name: 'ada', pin: '000000' })).status).toBe(409);
    expect((await post('/auth/users', { name: 'Bob', pin: '000000' })).status).toBe(200);

    expect(await (await req('/auth/me')).json()).toMatchObject({ users: ['Ada', 'Bob'], authenticated: false });
    expect((await post('/auth/login', { name: 'Ada', pin: '654321' })).status).toBe(401);
    const l = await post('/auth/login', { name: 'Ada', pin: '123456' });
    expect(await (await req('/auth/me', {}, cookieOf(l))).json()).toMatchObject({ authenticated: true, user: { name: 'Ada', kind: 'pin' } });
  });

  it('answers 429 while locked out, and requires x-legos on auth writes', async () => {
    const { req, post } = setup();
    await post('/auth/users', { name: 'Ada', pin: '123456' });
    for (let i = 0; i < 4; i++) await post('/auth/login', { name: 'Ada', pin: '000000' });
    const locked = await post('/auth/login', { name: 'Ada', pin: '000000' });
    expect(locked.status).toBe(429);
    expect((await locked.json()).retryAfterMs).toBe(30_000);
    expect((await req('/auth/login', { method: 'POST', body: '{"name":"Ada","pin":"123456"}' })).status).toBe(403);
    expect((await req('/auth/users', { method: 'POST', body: '{"name":"Eve","pin":"123456"}' })).status).toBe(403);
  });

  it('logout clears the cookie', async () => {
    const { post, signUp } = setup();
    const out = await post('/auth/logout', {}, await signUp('Ada'));
    expect(out.headers.get('set-cookie')).toMatch(/lf_sid=;.*Max-Age=0/);
  });

  it('signs in with workbench as its own user, with workbench already connected', async () => {
    const { srv, req, post, signUp } = setup({ workbench: true });
    const ada = await signUp('Ada');
    expect(await (await req('/auth/me')).json()).toMatchObject({ workbenchLogin: true });

    const attempt = 'attempt-0123456789abcdef';
    const start = await post('/auth/workbench', { attempt });
    expect(start.status).toBe(200);
    const authorize = new URL((await start.json()).url);
    expect(authorize.origin + authorize.pathname).toBe(`${WB}/authorize`);
    expect((await req(`/auth/claim?attempt=${attempt}`)).status).toBe(404); // not finished yet

    srv.setChallenge(authorize.searchParams.get('code_challenge')!);
    const cb = await req(`/auth/callback?code=abc&state=${authorize.searchParams.get('state')}`);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain('Signed in as who@acme.test');
    // the browser that finished the redirect is signed in; so is the app polling with its attempt, once
    const viaCallback = cookieOf(cb);
    const claim = await req(`/auth/claim?attempt=${attempt}`);
    expect(claim.status).toBe(200);
    const viaClaim = cookieOf(claim);
    expect((await req(`/auth/claim?attempt=${attempt}`)).status).toBe(404);

    for (const cookie of [viaCallback, viaClaim]) {
      expect(await (await req('/auth/me', {}, cookie)).json()).toMatchObject({ authenticated: true, user: { kind: 'workbench', email: 'who@acme.test' } });
    }
    const conns = (await (await req('/api/connections', {}, viaClaim)).json()).connections;
    expect(conns).toEqual([expect.objectContaining({ name: 'workbench', kind: 'workbench', connected: true, url: `${WB}/mcp` })]);
    // separate from the PIN user, who has no connections and no say over this one
    expect((await (await req('/api/connections', {}, ada)).json()).connections).toEqual([]);
    expect(await (await req('/auth/me')).json()).toMatchObject({ users: ['Ada'] });

    // signing in again reuses the same user
    const again = new URL((await (await post('/auth/workbench', {})).json()).url);
    srv.setChallenge(again.searchParams.get('code_challenge')!);
    const cb2 = await req(`/auth/callback?code=abc&state=${again.searchParams.get('state')}`);
    const me1 = (await (await req('/auth/me', {}, viaClaim)).json()).user.id;
    const me2 = (await (await req('/auth/me', {}, cookieOf(cb2))).json()).user.id;
    expect(me2).toBe(me1);
  });

  it('hides workbench sign-in when not configured and rejects forged callbacks', async () => {
    const { req, post } = setup();
    expect((await post('/auth/workbench', {})).status).toBe(404);
    expect((await post('/auth/workbench', { attempt: 'x' })).status).toBe(404);
    expect((await setup({ workbench: true }).post('/auth/workbench', { attempt: 'bad id!' })).status).toBe(400);
    expect((await req('/auth/callback?code=x&state=forged')).status).toBe(400);
  });
});

describe('isolation between users', () => {
  it('keeps connections, runs, decisions and the live stream to their owner', async () => {
    const { runs, board, req, post, signUp } = setup();
    const ada = await signUp('Ada');
    const bob = await signUp('Bob');
    await post('/api/connections', { name: 'tools', kind: 'mcp', url: `${OTHER}/mcp`, auth: 'header', headers: { 'x-api-key': 'ada-key' } }, ada);
    expect((await (await req('/api/connections', {}, bob)).json()).connections).toEqual([]);

    let mcp: any;
    const orig = runs.start.bind(runs);
    runs.start = (r) => ((mcp = r.mcp), orig(r));
    const run = await (await post('/api/runs', { cwd: '/tmp', prompt: 'hi' }, ada)).json();
    expect(run.owner).not.toBe((await (await req('/auth/me', {}, bob)).json()).user.id);
    // the run reaches Ada's connection through the proxy
    const proxied = await req('/mcp/tools', { method: 'POST', headers: { ...mcp.tools.headers, 'content-type': 'application/json' }, body: '{}' });
    expect((await proxied.json()).key).toBe('ada-key');

    expect((await req(`/api/runs/${run.id}`, {}, ada)).status).toBe(200);
    expect((await req(`/api/runs/${run.id}`, {}, bob)).status).toBe(404);
    expect((await post(`/api/runs/${run.id}/end`, {}, bob)).status).toBe(404);

    // a pending decision on Ada's run is invisible to Bob
    const decision = { id: 'd1', runId: run.id, cwd: '/tmp', toolName: 'Bash', title: null, reason: null, input: {}, createdAt: new Date().toISOString() };
    const snapshot = board.snapshot.bind(board);
    board.snapshot = () => ({ ...(snapshot() as any), decisions: [decision] });
    const answered: string[] = [];
    board.decide = (id) => (answered.push(id), true);
    board.discuss = (id) => (answered.push(id), run.id);
    expect((await post('/api/decisions/d1', { behavior: 'allow' }, bob)).status).toBe(410);
    expect((await post('/api/decisions/d1/discuss', { text: 'why?' }, bob)).status).toBe(410);
    expect(answered).toEqual([]);
    expect((await post('/api/decisions/d1', { behavior: 'allow' }, ada)).status).toBe(200);
    expect(answered).toEqual(['d1']);

    const firstEvent = async (cookie: string) => {
      const res = await req('/api/stream', {}, cookie);
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      await reader.cancel();
      return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ''));
    };
    expect((await firstEvent(ada)).runs.map((r: any) => r.id)).toEqual([run.id]);
    const bobSnap = await firstEvent(bob);
    expect(bobSnap.runs).toEqual([]);
    expect(bobSnap.decisions).toEqual([]);
    expect((await (await req('/api/activity/me', {}, bob)).json()).items).toEqual([]);
  });
});
