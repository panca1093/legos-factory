import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildDeps, createApp } from '../server/app.ts';
import { RunManager, type QueryFn } from '../server/claude-runs.ts';
import { startSyncLoop } from '../server/jira-sync.ts';
import { stageGuide } from '../server/launch-run.ts';
import type { Run } from '../shared/types.ts';

let root: string;
let saved: NodeJS.ProcessEnv;
let deps: ReturnType<typeof buildDeps>;
let runs: RunManager;
let app: ReturnType<typeof createApp>;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

// Stands in for Claude Code: one answer per message, the session stays open afterwards.
const fakeQuery = (() => {
  const fn = (({ prompt }: any) => {
    async function* gen() {
      let turn = 0;
      for await (const _ of prompt as AsyncIterable<any>) {
        turn++;
        yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5-5' };
        yield { type: 'assistant', uuid: `a${turn}`, parent_tool_use_id: null, message: { content: [{ type: 'text', text: `answer ${turn}` }] } };
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01 * turn, result: `answer ${turn}` };
      }
    }
    const it = gen() as any;
    it.interrupt = async () => {};
    it.setModel = async () => {};
    it.supportedModels = async () => [];
    return it;
  }) as unknown as QueryFn;
  return fn;
})();

const fakeWb = { token: 'fake', client: {
  bitbucketPr: async () => ({ id: 7, state: 'OPEN', title: 'Spec for PROJ-123', description: '', reviewers: [] }),
  bitbucketPrs: async () => [{ id: 7, source: 'feat/spec', title: 'Spec for PROJ-123', state: 'OPEN' }],
  bitbucketPrFiles: async () => [],
  jiraIssue: async () => ({ key: 'PROJ-123', summary: 'Retry cap', issueType: 'Story', labels: [], status: 'In Progress' }),
  jiraStatus: async () => 'In Progress',
  jiraTransitions: async () => [],
  jiraAddComment: async () => {},
} as any };

beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), 'lf-brainstorm-'));
  process.env.LEGOS_SETTINGS = join(root, 'settings.json');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const src = join(root, 'src');
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  git(src, 'config', 'user.name', 'Example');
  git(src, 'config', 'user.email', 'example@example.com');
  writeFileSync(join(src, 'README.md'), 'example');
  git(src, 'add', '.');
  git(src, 'commit', '-qm', 'init');
  mkdirSync(join(root, 'acme'));
  git(root, 'clone', '-q', '--bare', src, join(root, 'acme', 'api.git'));
  runs = new RunManager(fakeQuery);
  deps = buildDeps(runs, { workspaces: join(root, 'workspaces'), gitUrl: `file://${root}/{workspace}/{slug}.git` });
  deps.workbench = async () => fakeWb;
  deps.workItems.create('local', 'PROJ-123');
  deps.myRepos.add('local', { name: 'acme/api', mainBranch: 'main' });
  deps.workItems.addRepo('local', 'PROJ-123', 'acme/api');
  const timer = startSyncLoop(deps, 60_000);
  clearInterval(timer);
  app = createApp(runs, {}, deps);
});

const post = (path: string, body: unknown) =>
  app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { host: 'localhost', 'x-legos': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean) {
  for (let i = 0; i < 400 && !cond(); i++) await delay(10);
  expect(cond()).toBe(true);
}

afterEach(async () => {
  const snapshot = runs.snapshot();
  if (snapshot.type === 'snapshot') for (const run of snapshot.runs) await runs.end(run.id);
  await delay(100);
  await Promise.all([...deps.syncs.values()]);
  deps.db.close();
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

async function startTrackedChat(): Promise<Run> {
  const res = await post('/api/runs', { ticket: 'PROJ-123', stage: 'design', kind: 'chat', repo: 'acme/api', prompt: 'What should the retry cap be?' });
  expect(res.status).toBe(201);
  return (await res.json()) as Run;
}

it('a tracked chat discusses instead of writing a spec', async () => {
  const run = await startTrackedChat();
  expect(run).toMatchObject({ kind: 'chat', ticket: 'PROJ-123', stage: 'design', repo: 'acme/api' });
  expect(run.prompt).toContain('Do not write a spec');
  expect(run.prompt).not.toContain(stageGuide('design', 'PROJ-123'));
});

it('the chat stays idle after its turn', async () => {
  const run = await startTrackedChat();
  await until(() => runs.get(run.id)?.status === 'idle');
  expect(runs.get(run.id)).toMatchObject({ kind: 'chat', status: 'idle', ticket: 'PROJ-123', endedAt: null });
  expect(deps.workItems.links('local', 'PROJ-123')).toHaveLength(0);
});

it('starting the spec turns the chat into a task', async () => {
  const run = await startTrackedChat();
  await until(() => runs.get(run.id)?.status === 'idle');
  const res = await post(`/api/runs/${run.id}/start-spec`, { text: 'now write the spec' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(runs.get(run.id)?.kind).toBe('task');
  const asked = runs.get(run.id)!.events.filter((e) => e.kind === 'user').at(-1)!;
  expect(asked.text).toContain(stageGuide('design', 'PROJ-123'));
  expect(asked.text).toContain('now write the spec');
  await until(() => runs.get(run.id)?.endedAt !== null);
  expect(runs.get(run.id)).toMatchObject({ kind: 'task', status: 'completed', result: 'answer 2' });
});

it('a chat without a ticket cannot write a spec', async () => {
  const res = await post('/api/runs', { cwd: root, prompt: 'just talk about it' });
  expect(res.status).toBe(201);
  const run = (await res.json()) as Run;
  await until(() => runs.get(run.id)?.status === 'idle');
  const spec = await post(`/api/runs/${run.id}/start-spec`, { text: 'write it' });
  expect(spec.status).toBe(409);
  expect((await spec.json()).error).toBeTruthy();
  expect(runs.get(run.id)?.kind).toBe('chat');
});

it('the spec PR reaches the gate', async () => {
  const run = await startTrackedChat();
  await until(() => runs.get(run.id)?.status === 'idle');
  expect(deps.workItems.repos('local', 'PROJ-123')[0].stage).toBe('shaping');
  git(run.cwd, 'checkout', '-qb', 'feat/spec');
  const res = await post(`/api/runs/${run.id}/start-spec`, {});
  expect(res.status).toBe(200);
  await until(() => runs.get(run.id)?.endedAt !== null);
  await until(() => deps.workItems.links('local', 'PROJ-123').some((l) => l.kind === 'spec'));
  expect(deps.workItems.links('local', 'PROJ-123')[0]).toMatchObject({ repo: 'acme/api', kind: 'spec', prId: 7, state: 'OPEN' });
  await until(() => deps.workItems.repos('local', 'PROJ-123')[0]?.stage === 'spec_review');
});
