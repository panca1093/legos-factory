import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import { MyRepos } from '../server/my-repos.ts';
import { allowed, Workspaces } from '../server/tenancy.ts';
import { Users } from '../server/users.ts';
import { WorkItems } from '../server/work-items.ts';
import { alive } from './fakes.ts';

beforeAll(() => {
  process.env.CLAUDE_PROJECTS_DIR = join(import.meta.dirname, 'fixtures/projects');
  process.env.LEGOS_SETTINGS = join(import.meta.dirname, 'fixtures/settings/app.json');
});

const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];

function setup() {
  const db = openDb(':memory:');
  const app = createApp(new RunManager(alive), { users: new Users(db), db });
  const req = (path: string, cookie: string, init: RequestInit = {}) =>
    app.request(`http://localhost:4317${path}`, { ...init, headers: { host: 'localhost:4317', cookie, 'x-legos': '1', 'content-type': 'application/json', ...(init.headers as any) } });
  const send = (method: string) => (path: string, cookie: string, body: unknown = {}) => req(path, cookie, { method, body: JSON.stringify(body) });
  const post = send('POST');
  const put = send('PUT');
  const del = send('DELETE');
  const signUp = async (name: string) => {
    const res = await app.request('http://localhost:4317/auth/users', {
      method: 'POST',
      body: JSON.stringify({ name, pin: '123456' }),
      headers: { host: 'localhost:4317', 'x-legos': '1', 'content-type': 'application/json' },
    });
    return cookieOf(res);
  };
  const json = async (res: Response) => res.json() as Promise<any>;
  const me = async (cookie: string) => (await json(await req('/auth/me', cookie))).user.id as string;
  const mine = async (cookie: string) => (await json(await req('/api/workspaces', cookie))) as { active: string; workspaces: { id: string; name: string; kind: string; role: string }[] };
  return { db, req, post, put, del, signUp, json, me, mine };
}

describe('workspaces', () => {
  it('gives every user a personal workspace they own, keyed by their user id', async () => {
    const s = setup();
    const ada = await s.signUp('Ada');
    const list = await s.mine(ada);
    expect(list.workspaces).toEqual([{ id: await s.me(ada), name: 'Ada', kind: 'personal', role: 'owner' }]);
    expect(list.active).toBe(list.workspaces[0].id);
  });

  it('shares a team workspace between members, per role, and keeps outsiders out', async () => {
    const s = setup();
    const [ada, bob, eve] = [await s.signUp('Ada'), await s.signUp('Bob'), await s.signUp('Eve')];
    const team = await s.json(await s.post('/api/workspaces', ada, { name: 'Platform' }));
    expect(team).toMatchObject({ kind: 'team', role: 'owner' });
    expect((await s.put(`/api/workspaces/${team.id}/members`, ada, { user: 'bob', role: 'viewer' })).status).toBe(200);
    await s.post('/api/workspaces/active', ada, { id: team.id });
    await s.post('/api/workspaces/active', bob, { id: team.id });

    const run = await s.json(await s.post('/api/runs', ada, { cwd: '/tmp', prompt: 'hi' }));
    expect(run.workspaceId).toBe(team.id);
    expect((await s.req(`/api/runs/${run.id}`, bob)).status).toBe(200);
    expect((await s.req(`/api/runs/${run.id}`, eve)).status).toBe(404);
    expect((await s.json(await s.req('/api/activity/me', eve))).items).toEqual([]);
  });

  it('denies a workspace you are not in, for switching and for reading its data', async () => {
    const s = setup();
    const [ada, eve] = [await s.signUp('Ada'), await s.signUp('Eve')];
    const team = await s.json(await s.post('/api/workspaces', ada, { name: 'Platform' }));
    expect((await s.post('/api/workspaces/active', eve, { id: team.id })).status).toBe(404);
    expect((await s.req(`/api/workspaces/${team.id}/members`, eve)).status).toBe(404);
    expect((await s.put(`/api/workspaces/${team.id}/members`, eve, { user: 'eve', role: 'owner' })).status).toBe(404);
    expect((await s.mine(eve)).workspaces.map((w) => w.id)).not.toContain(team.id);
    expect((await s.mine(eve)).active).toBe(await s.me(eve));
  });

  it('keeps connections, repos, work items and sessions of one workspace out of another', async () => {
    const s = setup();
    const [ada, bob] = [await s.signUp('Ada'), await s.signUp('Bob')];
    const [adaId, bobId] = [await s.me(ada), await s.me(bob)];
    new MyRepos(s.db).add(adaId, { name: 'acme/api', mainBranch: 'main' });
    new WorkItems(s.db).create(adaId, 'PROJ-1');
    expect((await s.json(await s.req('/api/my-repos', ada))).repos).toHaveLength(1);
    expect((await s.json(await s.req('/api/my-repos', bob))).repos).toEqual([]);
    expect((await s.json(await s.req('/api/work-items', ada))).items).toHaveLength(1);
    expect((await s.json(await s.req('/api/work-items', bob))).items).toEqual([]);
    expect((await s.put('/api/work-items/PROJ-1', bob, { repos: ['acme/api'] })).status).toBe(403);
    expect(bobId).not.toBe(adaId);
  });

  it('enforces roles on the server: viewers read, members run work, owners configure', async () => {
    const s = setup();
    const [ada, bob, cy] = [await s.signUp('Ada'), await s.signUp('Bob'), await s.signUp('Cy')];
    const team = await s.json(await s.post('/api/workspaces', ada, { name: 'Platform' }));
    await s.put(`/api/workspaces/${team.id}/members`, ada, { user: 'Bob', role: 'member' });
    await s.put(`/api/workspaces/${team.id}/members`, ada, { user: 'Cy', role: 'viewer' });
    for (const c of [ada, bob, cy]) await s.post('/api/workspaces/active', c, { id: team.id });

    expect((await s.req('/api/sessions', cy)).status).toBe(200);
    expect((await s.post('/api/runs', cy, { cwd: '/tmp', prompt: 'hi' })).status).toBe(403);
    expect((await s.post('/api/runs', bob, { cwd: '/tmp', prompt: 'hi' })).status).toBe(201);
    expect((await s.post('/api/connections', bob, { name: 'x', kind: 'mcp', url: 'https://x.test/mcp', auth: 'header', headers: { a: 'b' } })).status).toBe(403);
    expect((await s.post('/api/connections', ada, { name: 'x', kind: 'mcp', url: 'https://x.test/mcp', auth: 'header', headers: { a: 'b' } })).status).toBe(201);
    expect((await s.json(await s.req('/api/connections', cy))).connections).toHaveLength(1);
    expect((await s.post('/api/my-repos', bob, { repo: 'acme/api' })).status).toBe(403);
    expect((await s.put(`/api/workspaces/${team.id}/members`, bob, { user: 'Cy', role: 'owner' })).status).toBe(403);
  });

  it('lets viewers and members switch workspace and leave, but never strands a workspace without an owner', async () => {
    const s = setup();
    const [ada, bob] = [await s.signUp('Ada'), await s.signUp('Bob')];
    const [adaId, bobId] = [await s.me(ada), await s.me(bob)];
    const team = await s.json(await s.post('/api/workspaces', ada, { name: 'Platform' }));
    await s.put(`/api/workspaces/${team.id}/members`, ada, { user: 'Bob', role: 'viewer' });
    expect((await s.post('/api/workspaces/active', bob, { id: team.id })).status).toBe(200);

    expect((await s.put(`/api/workspaces/${team.id}/members`, ada, { user: 'Ada', role: 'member' })).status).toBe(409);
    expect((await s.del(`/api/workspaces/${team.id}/members/${adaId}`, ada)).status).toBe(409);
    expect((await s.del(`/api/workspaces/${team.id}/members/${adaId}`, bob)).status).toBe(403);

    expect((await s.del(`/api/workspaces/${team.id}/members/${bobId}`, bob)).status).toBe(200);
    expect((await s.mine(bob)).active).toBe(bobId);
    expect((await s.req(`/api/workspaces/${team.id}/members`, bob)).status).toBe(404);
  });

  it('refuses members, unknown users and bad roles', async () => {
    const s = setup();
    const ada = await s.signUp('Ada');
    const adaId = await s.me(ada);
    const team = await s.json(await s.post('/api/workspaces', ada, { name: 'Platform' }));
    expect((await s.put(`/api/workspaces/${team.id}/members`, ada, { user: 'nobody', role: 'member' })).status).toBe(404);
    expect((await s.put(`/api/workspaces/${team.id}/members`, ada, { user: 'Ada', role: 'boss' })).status).toBe(400);
    expect((await s.put(`/api/workspaces/${adaId}/members`, ada, { user: 'Ada', role: 'owner' })).status).toBe(409);
    expect((await s.post('/api/workspaces', ada, { name: '' })).status).toBe(400);
  });
});

describe('role table', () => {
  it('lets viewers only read, members everything but configuration, owners everything', () => {
    expect(allowed('viewer', 'GET', '/api/runs/x')).toBe(true);
    expect(allowed('viewer', 'POST', '/api/runs')).toBe(false);
    expect(allowed('viewer', 'POST', '/api/workspaces/active')).toBe(true);
    expect(allowed('member', 'POST', '/api/runs')).toBe(true);
    expect(allowed('member', 'POST', '/api/connections')).toBe(false);
    expect(allowed('member', 'DELETE', '/api/my-repos/acme/api')).toBe(false);
    expect(allowed('member', 'GET', '/api/connections')).toBe(true);
    expect(allowed('owner', 'POST', '/api/connections')).toBe(true);
  });
});

describe('workspace storage', () => {
  it('keeps a personal workspace idempotent and falls back to it when a membership is gone', () => {
    const db = openDb(':memory:');
    const users = new Users(db);
    const ws = new Workspaces(db);
    const u = users.upsertExternal('workbench', 's1', 'Ada', 'ada@acme.test');
    expect(ws.ensurePersonal(u.id, 'Ada')).toBe(u.id);
    ws.ensurePersonal(u.id, 'Ada');
    expect(ws.list(u.id)).toHaveLength(1);
    const team = ws.create('Platform', u.id);
    expect(ws.setActive(u.id, team.id)).toBe(true);
    expect(ws.active(u.id)).toEqual({ id: team.id, role: 'owner' });
    db.prepare(`delete from workspace_members where workspace_id = ?`).run(team.id);
    expect(ws.active(u.id)).toEqual({ id: u.id, role: 'owner' });
  });

  it('upgrades a database made before workspaces: rows keep their owner as workspace', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lf-ws-db-')), 'factory.db');
    const old = new DatabaseSync(path);
    old.exec(`
      create table connections (owner text not null, name text not null, data text not null, primary key (owner, name));
      create table runs (run_id text primary key, owner text not null, session_id text, item text not null, started_at text not null, last_event_at text not null);
      create index runs_owner on runs (owner, last_event_at);
      create table user_repos (owner text not null, repo_key text not null, name text not null, main_branch text, added_at text not null, jira_projects text not null default '', primary key (owner, repo_key));
      insert into user_repos (owner, repo_key, name, main_branch, added_at) values ('u1', 'acme/api', 'acme/api', 'main', '2026-10-16');
      insert into connections values ('u1', 'tools', '{}');
      insert into runs values ('r1', 'u1', 's1', '{}', 'x', 'x');`);
    old.close();
    const db = openDb(path);
    expect(new MyRepos(db).list('u1')).toEqual([expect.objectContaining({ name: 'acme/api' })]);
    expect(db.prepare(`select workspace_id from connections`).get()).toEqual({ workspace_id: 'u1' });
    expect(db.prepare(`select workspace_id from runs`).get()).toEqual({ workspace_id: 'u1' });
  });
});
