import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildDeps, createApp } from '../server/app.ts';
import { RunManager, type QueryFn } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';

const alive = (({ prompt }: any) => {
  const it = (async function* () {
    for await (const _ of prompt as AsyncIterable<unknown>);
  })() as any;
  it.interrupt = async () => {};
  return it;
}) as unknown as QueryFn;

function setup() {
  const db = openDb(':memory:');
  const runs = new RunManager(alive);
  const deps = buildDeps(runs, { workspaces: mkdtempSync(join(tmpdir(), 'lf-undo-')), selfUrl: 'http://localhost:4317' });
  const app = createApp(runs, {}, deps);
  deps.workItems.create('local', 'PROJ-123');
  deps.myRepos.add('local', { name: 'acme/api', mainBranch: 'main' });
  deps.workItems.addRepo('local', 'PROJ-123', 'acme/api');
  const req = (p: string, init: RequestInit = {}) => app.request(`http://localhost:4317${p}`, { ...init, headers: { host: 'localhost:4317', ...(init.headers as any) } });
  const post = (p: string, body: unknown = {}) => req(p, { method: 'POST', body: JSON.stringify(body), headers: { 'x-legos': '1', 'content-type': 'application/json' } });
  const startRun = (prompt: string) =>
    runs.start({ cwd: deps.wsRoot, prompt, ticket: 'PROJ-123', stage: 'build', repo: 'acme/api', kind: 'task' });
  return { db, deps, runs, req, post, startRun };
}

const settle = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

const saved = { ...process.env };
beforeAll(() => {
  process.env.LEGOS_SETTINGS = join(import.meta.dirname, 'fixtures/settings/app.json');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});
afterAll(() => {
  process.env = saved;
});

it('the undo resets a started work item to the backlog', async () => {
  const s = setup();
  s.deps.workItems.setStage('local', 'PROJ-123', 'acme/api', 'building', 1);
  s.deps.workItems.setPlan('local', 'PROJ-123', {
    tasks: [{ id: 'T1', do: 'Build retry', repo: 'acme/api', test: 'retry.test.ts', needs: [], touches: ['retry.ts'], state: 'running' }],
    error: null,
  });
  s.deps.workItems.setNote('local', 'PROJ-123', 'Skipped In Progress → Code Review');
  const res = await s.post('/api/work-items/PROJ-123/undo');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(s.deps.workItems.repos('local', 'PROJ-123')).toEqual([expect.objectContaining({ name: 'acme/api', stage: 'backlog', attempt: 0 })]);
  expect(s.deps.workItems.get('local', 'PROJ-123')!.plan!.tasks[0].state).toBe('waiting');
  expect(s.deps.workItems.get('local', 'PROJ-123')!.note).toBeNull();
});

it("the undo ends the ticket's active run", async () => {
  const s = setup();
  const run = s.startRun('build the retry cap');
  const res = await s.post('/api/work-items/PROJ-123/undo');
  expect(res.status).toBe(200);
  await settle(() => s.deps.runs.get(run.id)?.status === 'completed');
  expect(s.deps.runs.get(run.id)).toMatchObject({ ticket: 'PROJ-123', endedBy: 'user', endedAt: expect.any(String) });
});

it('the undo removes the session of the run it ended', async () => {
  const s = setup();
  const run = s.startRun('build the retry cap');
  run.sessionId = 'sess-1';
  await s.deps.activity.record(run, 'local');
  expect(s.deps.activity.sessionIds('local', 100)).toEqual(['sess-1']);
  await s.post('/api/work-items/PROJ-123/undo');
  await settle(() => s.deps.activity.sessionIds('local', 100).length === 0);
  expect(s.deps.activity.sessionIds('local', 100)).toEqual([]);
  expect(await (await s.req('/api/activity/me')).json()).toEqual({ items: [] });
});

it('the undo leaves the finished runs and the links alone', async () => {
  const s = setup();
  s.deps.workItems.link('local', 'PROJ-123', { repo: 'acme/api', kind: 'impl', prId: 12, branch: 'feat/PROJ-123', title: 't', state: 'OPEN', runId: null });
  const done = s.startRun('first attempt');
  done.sessionId = 'sess-done';
  await s.deps.activity.record(done, 'local');
  await s.deps.runs.end(done.id);
  await settle(() => s.deps.runs.get(done.id)?.status === 'completed');
  const live = s.startRun('second attempt');
  live.sessionId = 'sess-live';
  await s.deps.activity.record(live, 'local');
  await s.post('/api/work-items/PROJ-123/undo');
  await settle(() => s.deps.activity.sessionIds('local', 100).length === 1);
  expect(s.deps.activity.sessionIds('local', 100)).toEqual(['sess-done']);
  const items = (await (await s.req('/api/activity/me')).json()).items as { sessionId: string }[];
  expect(items.map((i) => i.sessionId)).toEqual(['sess-done']);
  expect(s.deps.workItems.links('local', 'PROJ-123')).toEqual([expect.objectContaining({ prId: 12, state: 'OPEN' })]);
});

it('the undo of a missing work item answers 404', async () => {
  const s = setup();
  const res = await s.post('/api/work-items/PROJ-999/undo');
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: 'work item not found' });
});
