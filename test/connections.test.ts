import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { RunManager, type QueryFn } from '../server/claude-runs.ts';
import { ActivityLog } from '../server/activity.ts';
import { Connections } from '../server/connections.ts';

const WB = 'https://wb.test';
const OTHER = 'https://tools.test';
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

// Fake workbench (its own authorization server) plus a generic MCP server that delegates auth to it.
function fakeServers(opts: { expiresIn?: number } = {}) {
  const calls: { url: string; body?: string; auth: string | null; headers: Headers }[] = [];
  let n = 0;
  let lastChallenge = '';
  const fetchFn = (async (input: any, init: any = {}) => {
    const url = String(input);
    const body = init.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : init.body;
    const headers = new Headers(init.headers);
    calls.push({ url, body, auth: headers.get('authorization'), headers });
    if (url === `${OTHER}/.well-known/oauth-protected-resource/mcp`) return Response.json({ authorization_servers: [WB] });
    if (url === `${WB}/.well-known/oauth-authorization-server`)
      return Response.json({ authorization_endpoint: `${WB}/authorize`, token_endpoint: `${WB}/token`, registration_endpoint: `${WB}/register` });
    if (url === `${WB}/register`) return Response.json({ client_id: `client-${calls.filter((c) => c.url === `${WB}/register`).length}` });
    if (url === `${WB}/token`) {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        const ok = createHash('sha256').update(p.get('code_verifier')!).digest('base64url') === lastChallenge;
        if (!ok) return new Response('bad verifier', { status: 400 });
      }
      n++;
      return Response.json({ access_token: jwt({ sub: 'u1', n }), refresh_token: `r${n}`, expires_in: opts.expiresIn ?? 3600 });
    }
    if (url === `${WB}/mcp` || url === `${OTHER}/mcp`) {
      const msg = body ? JSON.parse(body) : {};
      if (msg.method === 'tools/call' && msg.params?.name === 'whoami')
        return Response.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ id: 'u1', email: 'who@acme.test' }) }] } });
      return new Response(JSON.stringify({ seen: headers.get('authorization'), key: headers.get('x-api-key') }), {
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'm1' },
      });
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
  const srv = fakeServers(opts);
  const pushed: { auth: string | null; body: any }[] = [];
  const fetchFn = (async (input: any, init: any = {}) => {
    if (String(input).startsWith('https://hub.test/')) {
      pushed.push({ auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(init.body) : null });
      return Response.json(String(input).includes('/hub/team') ? { me: 'x', members: [] } : { accepted: 1 });
    }
    return srv.fetchFn(input, init);
  }) as typeof fetch;
  const path = join(mkdtempSync(join(tmpdir(), 'lf-conn-')), 'connections.json');
  const conns = new Connections({ callbackUrl: 'http://localhost:4317/auth/callback', path, fetch: fetchFn });
  const runs = new RunManager(alive);
  const activity = new ActivityLog(join(mkdtempSync(join(tmpdir(), 'lf-act-')), 'a.jsonl'));
  const app = createApp(runs, { connections: conns, selfUrl: 'http://localhost:4317', fetch: fetchFn, activity, hubUrl: opts.hub ? 'https://hub.test' : null });
  const req = (p: string, init: RequestInit = {}) => app.request(`http://localhost:4317${p}`, { ...init, headers: { host: 'localhost:4317', ...(init.headers as any) } });
  const post = (p: string, body: unknown = {}) => req(p, { method: 'POST', body: JSON.stringify(body), headers: { 'x-legos': '1', 'content-type': 'application/json' } });

  async function connect(name: string): Promise<URL> {
    const r = await post(`/api/connections/${name}/connect`);
    expect(r.status).toBe(200);
    const authorize = new URL((await r.json()).url);
    srv.setChallenge(authorize.searchParams.get('code_challenge')!);
    const cb = await req(`/auth/callback?code=abc&state=${authorize.searchParams.get('state')}`);
    expect(cb.status).toBe(200);
    expect(await cb.text()).toContain(`Connected ${name}`);
    return authorize;
  }
  const addWorkbench = () => post('/api/connections', { name: 'workbench', kind: 'workbench', url: WB, auth: 'oauth' });
  return { srv, conns, runs, req, post, connect, addWorkbench, path, pushed, activity };
}

beforeAll(() => {
  process.env.CLAUDE_PROJECTS_DIR = join(import.meta.dirname, 'fixtures/projects');
  process.env.LEGOS_SETTINGS = join(import.meta.dirname, 'fixtures/settings/app.json');
});

describe('adding connections', () => {
  it('validates input', async () => {
    const { post } = setup();
    const add = (b: object) => post('/api/connections', { name: 'x', kind: 'mcp', url: OTHER, auth: 'oauth', ...b });
    expect((await add({ name: 'Bad Name' })).status).toBe(400);
    expect((await add({ url: 'http://tools.test/mcp' })).status).toBe(400);
    expect((await add({ url: 'not a url' })).status).toBe(400);
    expect((await add({ kind: 'workbench', auth: 'header', headers: { a: 'b' } })).status).toBe(400);
    expect((await add({ auth: 'header', headers: {} })).status).toBe(400);
    expect((await add({ auth: 'header', headers: { 'x-api-key': 'a\nb' } })).status).toBe(400);
    expect((await add({ url: 'http://localhost:9000/mcp', auth: 'header', headers: { 'x-api-key': 'k' } })).status).toBe(201);
    expect((await add({})).status).toBe(409);
  });

  it('expands a bare workbench host to its MCP endpoint and never shows header values', async () => {
    const { req, addWorkbench, post } = setup();
    expect(await (await addWorkbench()).json()).toMatchObject({ url: `${WB}/mcp`, connected: false });
    await post('/api/connections', { name: 'tools', kind: 'mcp', url: `${OTHER}/mcp`, auth: 'header', headers: { 'x-api-key': 'sekret' } });
    const list = await (await req('/api/connections')).text();
    expect(list).toContain('x-api-key');
    expect(list).not.toContain('sekret');
  });
});

describe('OAuth connections', () => {
  it('registers once, uses PKCE and asks for the MCP resource, then knows who you are', async () => {
    const { srv, addWorkbench, connect, req, path } = setup();
    await addWorkbench();
    const a = await connect('workbench');
    await connect('workbench');
    expect(srv.calls.filter((c) => c.url.endsWith('/register'))).toHaveLength(1);
    expect(a.origin + a.pathname).toBe(`${WB}/authorize`);
    expect(Object.fromEntries(a.searchParams)).toMatchObject({ client_id: 'client-1', code_challenge_method: 'S256', scope: 'mcp', resource: `${WB}/mcp` });
    expect((await (await req('/api/connections')).json()).connections[0]).toMatchObject({ connected: true, user: { email: 'who@acme.test' } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('follows protected-resource metadata to the authorization server', async () => {
    const { post, connect } = setup();
    await post('/api/connections', { name: 'tools', kind: 'mcp', url: `${OTHER}/mcp`, auth: 'oauth' });
    const a = await connect('tools');
    expect(a.origin).toBe(WB);
    expect(a.searchParams.get('resource')).toBe(`${OTHER}/mcp`);
  });

  it('rejects a callback it did not start', async () => {
    const { req } = setup();
    expect((await req('/auth/callback?code=x&state=forged')).status).toBe(400);
  });

  it('refreshes once for concurrent callers; survives a transient failure, drops tokens on rejection', async () => {
    const { conns, addWorkbench, connect, srv } = setup({ expiresIn: 30 });
    await addWorkbench();
    await connect('workbench');
    const before = srv.calls.filter((c) => c.url.endsWith('/token')).length;
    const [t1, t2] = await Promise.all([conns.accessToken('workbench'), conns.accessToken('workbench')]);
    expect(t1).toBe(t2);
    expect(srv.calls.filter((c) => c.url.endsWith('/token')).length).toBe(before + 1);

    const real = srv.fetchFn;
    let mode: 'down' | 'reject' = 'down';
    (conns as any).http = (async (input: any, init: any) =>
      String(input).endsWith('/token') ? new Response('x', { status: mode === 'down' ? 502 : 400 }) : real(input, init)) as typeof fetch;
    expect(await conns.accessToken('workbench')).not.toBeNull();
    mode = 'reject';
    expect(await conns.accessToken('workbench')).toBeNull();
    expect((await conns.all())[0].connected).toBe(false);
  });

  it('disconnect forgets tokens, remove forgets the connection', async () => {
    const { addWorkbench, connect, post, req, path } = setup();
    await addWorkbench();
    await connect('workbench');
    await post('/api/connections/workbench/disconnect');
    expect((await (await req('/api/connections')).json()).connections[0].connected).toBe(false);
    expect(readFileSync(path, 'utf8')).not.toContain('h.');
    await req('/api/connections/workbench', { method: 'DELETE', headers: { 'x-legos': '1' } });
    expect((await (await req('/api/connections')).json()).connections).toEqual([]);
  });
});

describe('connections proxy', () => {
  it('gives each run every connected server, with credentials attached fresh upstream', async () => {
    const { req, post, runs, addWorkbench, connect } = setup();
    await addWorkbench();
    await connect('workbench');
    await post('/api/connections', { name: 'tools', kind: 'mcp', url: `${OTHER}/mcp`, auth: 'header', headers: { 'x-api-key': 'sekret' } });
    await post('/api/connections', { name: 'later', kind: 'mcp', url: `${OTHER}/mcp`, auth: 'oauth' });
    let mcp: any;
    const orig = runs.start.bind(runs);
    runs.start = (r) => ((mcp = r.mcp), orig(r));
    const res = await post('/api/runs', { cwd: '/tmp', prompt: 'hi' });
    expect(res.status).toBe(201);
    // not-yet-connected ones are left out
    expect(Object.keys(mcp)).toEqual(['workbench', 'tools']);
    expect(mcp.tools.url).toBe('http://localhost:4317/mcp/tools');

    const call = (name: string, headers: Record<string, string>) =>
      req(`/mcp/${name}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0"}' });
    const wb = await call('workbench', mcp.workbench.headers);
    expect(wb.headers.get('mcp-session-id')).toBe('m1');
    expect((await wb.json()).seen).toMatch(/^Bearer h\./);
    expect((await (await call('tools', mcp.tools.headers)).json()).key).toBe('sekret');
    expect((await call('later', mcp.tools.headers)).status).toBe(401);
    expect((await call('tools', { 'x-legos-run': 'guess' })).status).toBe(403);

    await runs.end((await res.json()).id);
    await new Promise((r) => setTimeout(r, 10));
    expect((await call('tools', mcp.tools.headers)).status).toBe(403);
  });

  it('starts runs without MCP extras when nothing is connected', async () => {
    const { post, runs } = setup();
    let mcp: any = 'unset';
    const orig = runs.start.bind(runs);
    runs.start = (r) => ((mcp = r.mcp), orig(r));
    expect((await post('/api/runs', { cwd: '/tmp', prompt: 'hi' })).status).toBe(201);
    expect(mcp).toBeUndefined();
  });
});

describe('workbench features', () => {
  it('need a connected workbench and validate Jira input', async () => {
    const { req, post, addWorkbench, connect } = setup();
    expect((await req('/api/jira/issues')).status).toBe(409);
    expect((await req('/api/workbench/integrations')).status).toBe(409);
    await addWorkbench();
    await connect('workbench');
    expect((await req('/api/jira/issues?filter=nope')).status).toBe(400);
    expect((await req('/api/jira/issues/not-a-key')).status).toBe(400);
    expect((await post('/api/workbench/connect', { integration: '../x' })).status).toBe(400);
  });

  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("pushes shared runs to the hub with the workbench token, keeps private ones home", async () => {
    const { post, pushed, activity, addWorkbench, connect } = setup({ hub: true });
    await addWorkbench();
    await connect('workbench');
    await post('/api/runs', { cwd: '/tmp', prompt: 'hi PROJ-7', share: 'private' });
    await settle();
    expect(pushed).toHaveLength(0);
    expect((await activity.list(0)).length).toBe(1);

    await post('/api/runs', { cwd: '/tmp', prompt: 'hi PROJ-7' });
    await settle();
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[0].auth).toMatch(/^Bearer h\./);
    expect(pushed[0].body.items[0]).toMatchObject({ ticket: 'PROJ-7', title: 'hi PROJ-7' });
    expect(pushed[0].body.items[0]).not.toHaveProperty('estimatedCostUsd');
  });

  it('serves team activity through the hub only with a workbench', async () => {
    const { req, addWorkbench, connect } = setup({ hub: true });
    expect((await req('/api/team')).status).toBe(409);
    await addWorkbench();
    await connect('workbench');
    expect(await (await req('/api/team')).json()).toMatchObject({ configured: true, members: [] });
    expect((await setup().req('/api/team')).status).toBe(409);
  });
});
