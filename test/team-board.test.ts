import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import { Users } from '../server/users.ts';
import { WorkItems } from '../server/work-items.ts';

let original: Record<string, string | undefined>;
const databases: ReturnType<typeof openDb>[] = [];

beforeEach(() => {
  original = Object.fromEntries(['LEGOS_AUTH', 'LEGOS_OWNERS'].map((key) => [key, process.env[key]]));
  delete process.env.LEGOS_AUTH;
  delete process.env.LEGOS_OWNERS;
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const db of databases.splice(0)) db.close();
});

function setup(signedIn = true) {
  const db = openDb(':memory:');
  databases.push(db);
  const users = signedIn ? new Users(db) : null;
  const app = createApp(new RunManager(), { db, users });
  const ada = users?.upsertExternal('workbench', 'ext-ada', 'Ada', 'ada@example.com');
  const bob = users?.upsertExternal('workbench', 'ext-bob', 'Bob', 'bob@example.com');
  const items = new WorkItems(db);
  const request = (endpoint: string, init: RequestInit = {}) =>
    app.request(`http://localhost${endpoint}`, {
      ...init,
      headers: { host: 'localhost', 'x-legos': '1', 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    });
  const asUser = (userId: string, endpoint: string, init: RequestInit = {}) =>
    request(endpoint, { ...init, headers: { ...(init.headers as Record<string, string>), cookie: `lf_sid=${users!.issue(userId)}` } });
  return { db, users, ada, bob, items, request, asUser };
}

describe('team board', () => {
  it('a non-owner gets 403 on the team board', async () => {
    const { ada, asUser } = setup();
    process.env.LEGOS_OWNERS = 'someone-else@example.com';
    const response = await asUser(ada!.id, '/api/team/work-items');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'only owners can see the team board' });

    const local = setup(false);
    expect((await local.request('/api/team/work-items')).status).toBe(200);
  });

  it('an owner sees every user\'s work items with their owner', async () => {
    const { db, ada, bob, items, asUser } = setup();
    process.env.LEGOS_OWNERS = 'ada@example.com';
    items.create(ada!.id, 'PROJ-123');
    items.addRepo(ada!.id, 'PROJ-123', 'acme/api');
    items.link(ada!.id, 'PROJ-123', { repo: 'acme/api', kind: 'impl', prId: 7, branch: 'feature/proj-123', title: 'feat: PROJ-123 retry', state: 'OPEN', runId: null });
    items.create(bob!.id, 'PROJ-124');
    db.prepare(`update work_items set created_at = '2026-10-20T09:00:00.000Z' where ticket = 'PROJ-123'`).run();
    db.prepare(`update work_items set created_at = '2026-10-21T09:00:00.000Z' where ticket = 'PROJ-124'`).run();

    const response = await asUser(ada!.id, '/api/team/work-items');
    expect(response.status).toBe(200);
    const { items: board } = (await response.json()) as { items: any[] };
    expect(board).toHaveLength(2);
    expect(board[0]).toMatchObject({ ticket: 'PROJ-124', source: 'jira', plan: null, status: null, note: null, repos: [], links: [], owner: { id: bob!.id, name: 'Bob', email: 'bob@example.com' } });
    expect(board[1]).toMatchObject({
      ticket: 'PROJ-123',
      source: 'jira',
      plan: null,
      status: null,
      note: null,
      repos: [{ name: 'acme/api', stage: 'building', attempt: 0 }],
      links: [{ repo: 'acme/api', kind: 'impl', prId: 7, state: 'OPEN' }],
      owner: { id: ada!.id, name: 'Ada', email: 'ada@example.com' },
    });
  });

  it('the team board is read-only', async () => {
    const { ada, asUser } = setup();
    process.env.LEGOS_OWNERS = 'ada@example.com';
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await asUser(ada!.id, '/api/team/work-items', { method });
      expect(response.status).toBe(404);
    }
  });

  it('the team board lists nothing when there are no work items', async () => {
    const { ada, asUser } = setup();
    process.env.LEGOS_OWNERS = 'ada@example.com';
    const response = await asUser(ada!.id, '/api/team/work-items');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });
});
