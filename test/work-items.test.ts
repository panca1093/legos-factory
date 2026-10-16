import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDeps, createApp } from '../server/app.ts';
import { RunManager, type QueryFn, type StartRequest } from '../server/claude-runs.ts';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.ts';
import { planMoves, syncDue, syncWorkItem, type Facts } from '../server/jira-sync.ts';
import { MyRepos } from '../server/my-repos.ts';
import { WorkItems } from '../server/work-items.ts';
import { fakeServers, WB } from './fakes.ts';

const FLOW = { todo: 'To Do', inProgress: 'In Progress', codeReview: 'Code Review', readyForQa: 'Ready for QA' };
const TRANSITIONS = [
  { id: '11', name: 'Back to do', toStatus: 'To Do' },
  { id: '21', name: 'Start', toStatus: 'In Progress' },
  { id: '31', name: 'Review', toStatus: 'Code Review' },
  { id: '41', name: 'Ready', toStatus: 'Ready for QA' },
  { id: '51', name: 'Hold', toStatus: 'ON HOLD' },
];
const pr = (id: number, state: string, title = `feat: PROJ-1 part ${id}`, source = `feat/PROJ-1-${id}`) => ({ id, title, state, source, destination: 'main', url: `https://forge/pr/${id}` });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

function forge() {
  const root = mkdtempSync(join(tmpdir(), 'lf-forge-'));
  const src = join(root, 'src');
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  git(src, 'config', 'user.email', 't@t');
  git(src, 'config', 'user.name', 't');
  writeFileSync(join(src, 'README.md'), 'main\n');
  git(src, 'add', '.');
  git(src, 'commit', '-qm', 'init');
  mkdirSync(join(root, 'acme'));
  for (const slug of ['api', 'web']) git(root, 'clone', '-q', '--bare', src, join(root, 'acme', `${slug}.git`));
  return `file://${root}/{workspace}/{slug}.git`;
}

const alive = (({ prompt }: any) => {
  const it = (async function* () {
    for await (const _ of prompt as AsyncIterable<unknown>);
  })() as any;
  it.interrupt = async () => {};
  return it;
}) as unknown as QueryFn;

type Opts = { status?: string; transitions?: typeof TRANSITIONS; prs?: Record<string, object>; open?: Record<string, object[]>; delay?: number; gitUrl?: string };

function setup(o: Opts = {}) {
  const jira = { status: o.status ?? 'To Do' };
  const calls: { tool: string; args: any; cloneExists?: boolean }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const hooks: { onListPrs?: () => boolean } = {};
  const srv = fakeServers({
    exec: async (tool, args) => {
      const call: (typeof calls)[number] = { tool, args };
      calls.push(call);
      if (tool === 'jira_get_issue') {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, o.delay ?? 0));
        inFlight--;
        return { key: args.issueKey, summary: 's', status: jira.status };
      }
      if (tool === 'jira_get_transitions') return { transitions: o.transitions ?? TRANSITIONS };
      if (tool === 'jira_transition_issue') {
        jira.status = (o.transitions ?? TRANSITIONS).find((t) => t.id === args.transitionId)!.toStatus;
        return { success: true };
      }
      if (tool === 'jira_add_comment') return { id: '100', created: '2026-10-16' };
      if (tool === 'bitbucket_get_pr') {
        const p = o.prs?.[`${args.workspace}/${args.repoSlug}#${args.pullRequestId}`];
        if (!p) throw new Error('not found');
        return p;
      }
      if (tool === 'bitbucket_list_prs') {
        call.cloneExists = hooks.onListPrs?.();
        return { prs: o.open?.[`${args.workspace}/${args.repoSlug}`] ?? [], hasMore: false };
      }
      if (tool === 'bitbucket_list_repos') return { repos: [], hasMore: false };
      return null;
    },
  });
  const db = openDb(':memory:');
  const myRepos = new MyRepos(db);
  for (const name of ['acme/api', 'acme/web']) myRepos.add('local', { name, mainBranch: 'main' });
  const runs = new RunManager(alive);
  const starts: StartRequest[] = [];
  const orig = runs.start.bind(runs);
  runs.start = (r) => (starts.push(r), orig(r));
  const opts = { db, workspaces: mkdtempSync(join(tmpdir(), 'lf-ws-')), selfUrl: 'http://localhost:4317', fetch: srv.fetchFn, gitUrl: o.gitUrl };
  const deps = buildDeps(runs, opts);
  const app = createApp(runs, opts, deps);
  const req = (p: string, init: RequestInit = {}) => app.request(`http://localhost:4317${p}`, { ...init, headers: { host: 'localhost:4317', ...(init.headers as any) } });
  const send = (method: string) => (p: string, body: unknown = {}) => req(p, { method, body: JSON.stringify(body), headers: { 'x-legos': '1', 'content-type': 'application/json' } });
  const post = send('POST');
  const put = send('PUT');
  const patch = send('PATCH');
  const connectWorkbench = async (owner = 'local') => {
    if (owner !== 'local') throw new Error('only local');
    await post('/api/connections', { name: 'workbench', kind: 'workbench', url: WB, auth: 'oauth' });
    const authorize = new URL((await (await post('/api/connections/workbench/connect')).json()).url);
    srv.setChallenge(authorize.searchParams.get('code_challenge')!);
    await req(`/auth/callback?code=abc&state=${authorize.searchParams.get('state')}`);
  };
  const items = new WorkItems(db);
  const item = async (ticket = 'PROJ-1') => ((await (await req('/api/work-items')).json()).items as any[]).find((i) => i.ticket === ticket);
  const tools = (name: string) => calls.filter((c) => c.tool === name);
  return { jira, calls, tools, db, deps, runs, starts, req, post, put, patch, connectWorkbench, items, item, myRepos, hooks, max: () => maxInFlight };
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

describe('status rules', () => {
  const facts = (f: Partial<Facts>): Facts => ({ started: false, repos: ['acme/api'], links: [], ...f });
  const to = (status: string, f: Partial<Facts>) => planMoves(FLOW, status, facts(f)).moves.map((m) => m.to);

  it('moves forward one row at a time', () => {
    expect(to('To Do', { started: true })).toEqual(['In Progress']);
    expect(to('In Progress', { started: true, links: [{ repo: 'acme/api', kind: 'impl', state: 'OPEN' }] })).toEqual(['Code Review']);
    expect(to('Code Review', { started: true, links: [{ repo: 'acme/api', kind: 'impl', state: 'MERGED' }] })).toEqual(['Ready for QA']);
    expect(to('To Do', {})).toEqual([]);
    expect(to('in progress', { links: [{ repo: 'acme/api', kind: 'impl', state: 'OPEN' }] })).toEqual(['Code Review']);
  });

  it('chains steps when PRs are further along than Jira', () => {
    const merged = { started: true, links: [{ repo: 'acme/api', kind: 'impl' as const, state: 'MERGED' }] };
    expect(to('In Progress', merged)).toEqual(['Code Review', 'Ready for QA']);
    expect(to('To Do', merged)).toEqual(['In Progress', 'Code Review', 'Ready for QA']);
  });

  it('counts every repo: declined or missing impl PRs hold back, spec PRs never count', () => {
    const repos = ['acme/api', 'acme/web'];
    expect(to('In Progress', { repos, links: [{ repo: 'acme/api', kind: 'impl', state: 'OPEN' }] })).toEqual([]);
    expect(to('In Progress', { repos, links: [{ repo: 'acme/api', kind: 'impl', state: 'OPEN' }, { repo: 'acme/web', kind: 'impl', state: 'DECLINED' }] })).toEqual([]);
    expect(to('In Progress', { repos, links: [{ repo: 'acme/api', kind: 'impl', state: 'OPEN' }, { repo: 'acme/web', kind: 'spec', state: 'MERGED' }] })).toEqual([]);
    expect(to('Code Review', { repos, links: [{ repo: 'acme/api', kind: 'impl', state: 'MERGED' }, { repo: 'acme/web', kind: 'impl', state: 'OPEN' }] })).toEqual([]);
    expect(to('In Progress', { repos, links: [{ repo: 'acme/api', kind: 'impl', state: 'OPEN' }, { repo: 'acme/web', kind: 'impl', state: 'MERGED' }] })).toEqual(['Code Review']);
    expect(to('In Progress', { repos: [], links: [] })).toEqual([]);
  });

  it('never moves backward or out of a status outside the flow', () => {
    const merged = { started: true, links: [{ repo: 'acme/api', kind: 'impl' as const, state: 'MERGED' }] };
    expect(planMoves(FLOW, 'Ready for QA', facts(merged))).toEqual({ moves: [], skipped: null });
    expect(planMoves(FLOW, 'Code Review', facts({ started: true }))).toEqual({ moves: [], skipped: null });
    expect(planMoves(FLOW, 'ON HOLD', facts(merged))).toEqual({ moves: [], skipped: { from: 'To Do', to: 'In Progress' } });
  });
});

describe('jira sync', () => {
  const withItem = async (s: ReturnType<typeof setup>, links: { repo?: string; kind?: 'spec' | 'impl'; prId: number; state?: string }[] = []) => {
    await s.connectWorkbench();
    await s.put('/api/work-items/PROJ-1', { repos: ['acme/api'] });
    for (const l of links)
      s.items.link('local', 'PROJ-1', { repo: l.repo ?? 'acme/api', kind: l.kind ?? 'impl', prId: l.prId, branch: `feat/PROJ-1-${l.prId}`, title: 't', state: l.state ?? 'OPEN', runId: null });
  };

  it('skips without a transition call when the status is not the expected one', async () => {
    const s = setup({ status: 'ON HOLD', prs: { 'acme/api#12': pr(12, 'OPEN') } });
    await withItem(s, [{ prId: 12 }]);
    await syncWorkItem(s.deps, 'local', 'PROJ-1');
    const body = await s.item();
    expect(body.status).toBe('ON HOLD');
    expect(body.note).toMatchObject({ text: 'Skipped In Progress → Code Review: status was ON HOLD', at: expect.any(String) });
    expect(s.tools('jira_transition_issue')).toEqual([]);
    expect(s.tools('jira_get_transitions')).toEqual([]);
  });

  it('looks the transition id up by target status name and moves', async () => {
    const s = setup({ status: 'In Progress', prs: { 'acme/api#12': pr(12, 'OPEN') } });
    await withItem(s, [{ prId: 12 }]);
    await syncWorkItem(s.deps, 'local', 'PROJ-1');
    const body = await s.item();
    expect(s.tools('jira_transition_issue').map((c) => c.args)).toEqual([{ issueKey: 'PROJ-1', transitionId: '31' }]);
    expect(s.tools('jira_get_transitions')[0].args).toEqual({ issueKey: 'PROJ-1' });
    expect(body.status).toBe('Code Review');
    expect(body.note).toBeNull();
  });

  it('refreshes PR states and chains moves, reading the status before each', async () => {
    const s = setup({ status: 'In Progress', prs: { 'acme/api#12': pr(12, 'MERGED') } });
    await withItem(s, [{ prId: 12, state: 'OPEN' }]);
    await syncWorkItem(s.deps, 'local', 'PROJ-1');
    const body = await s.item();
    expect(body.links[0]).toMatchObject({ prId: 12, state: 'MERGED', title: 'feat: PROJ-1 part 12' });
    expect(s.tools('jira_transition_issue').map((c) => c.args.transitionId)).toEqual(['31', '41']);
    const order = s.calls.map((c) => c.tool).filter((t) => t.startsWith('jira_') && t !== 'jira_add_comment');
    expect(order).toEqual(['jira_get_issue', 'jira_get_transitions', 'jira_transition_issue', 'jira_get_issue', 'jira_get_transitions', 'jira_transition_issue', 'jira_get_issue']);
    expect(body.status).toBe('Ready for QA');
  });

  it('records an error when no transition leads to the target status', async () => {
    const s = setup({ status: 'In Progress', transitions: TRANSITIONS.filter((t) => t.toStatus !== 'Code Review'), prs: { 'acme/api#12': pr(12, 'OPEN') } });
    await withItem(s, [{ prId: 12 }]);
    await syncWorkItem(s.deps, 'local', 'PROJ-1');
    const body = await s.item();
    expect(s.tools('jira_transition_issue')).toEqual([]);
    expect(body.note.text).toBe('Error: no transition to Code Review from In Progress');
  });

  it('comments each new factory link on the ticket exactly once', async () => {
    const s = setup({ status: 'ON HOLD', prs: { 'acme/api#12': pr(12, 'OPEN'), 'acme/api#9': pr(9, 'MERGED', 'docs: PROJ-1 spec') } });
    await withItem(s, [{ prId: 12 }, { prId: 9, kind: 'spec' }]);
    await syncWorkItem(s.deps, 'local', 'PROJ-1');
    await syncWorkItem(s.deps, 'local', 'PROJ-1');
    expect(s.tools('jira_add_comment').map((c) => c.args).sort((a, b) => a.body.localeCompare(b.body))).toEqual([
      { issueKey: 'PROJ-1', body: 'Implementation PR for acme/api: feat: PROJ-1 part 12 — https://forge/pr/12' },
      { issueKey: 'PROJ-1', body: 'Spec PR for acme/api: docs: PROJ-1 spec — https://forge/pr/9' },
    ]);
    const body = await s.item();
    expect(body.links.filter((l: any) => l.commented).map((l: any) => l.prId).sort()).toEqual([12, 9].sort());
  });

  it('does not retry a comment that failed and records an error', async () => {
    const s = setup({ status: 'ON HOLD', prs: { 'acme/api#12': pr(12, 'OPEN') } });
    await withItem(s, [{ prId: 12 }]);
    const orig = s.deps.workbench;
    s.deps.workbench = async (o: string) => {
      const wb = await orig(o);
      if (wb) wb.client.jiraAddComment = async () => Promise.reject(new Error('timed out'));
      return wb;
    };
    await syncWorkItem(s.deps, 'local', 'PROJ-1');
    const body = await s.item();
    expect(body.links[0].commented).toBe(true);
    expect(body.note.text).toMatch(/^Error: .*timed out/);
    s.deps.workbench = orig;
    await syncWorkItem(s.deps, 'local', 'PROJ-1');
    expect(s.tools('jira_add_comment')).toEqual([]);
  });

  it('notes failures instead of throwing', async () => {
    const s = setup({ status: 'In Progress' });
    await withItem(s, [{ prId: 77 }]);
    await expect(syncWorkItem(s.deps, 'local', 'PROJ-1')).resolves.toBeUndefined();
    expect((await s.item()).note.text).toMatch(/^Error: acme\/api #77/);
    // no work item: nothing to do
    await expect(syncWorkItem(s.deps, 'local', 'PROJ-404')).resolves.toBeUndefined();
  });

  it('a clean sync clears a skip note but keeps a PR capture failure until a link lands', async () => {
    const s = setup({ status: 'ON HOLD', prs: { 'acme/api#12': pr(12, 'OPEN') }, open: { 'acme/api': [] } });
    await withItem(s, [{ prId: 12 }]);
    await syncWorkItem(s.deps, 'local', 'PROJ-1');
    expect((await s.item()).note.text).toMatch(/^Skipped/);
    s.jira.status = 'Code Review';
    await syncWorkItem(s.deps, 'local', 'PROJ-1');
    expect((await s.item()).note).toBeNull();

    s.items.setNote('local', 'PROJ-1', 'Error: PR capture failed in acme/api: boom');
    await syncWorkItem(s.deps, 'local', 'PROJ-1');
    expect((await s.item()).note.text).toMatch(/^Error: PR capture failed/);
  });
});

describe('periodic sync', () => {
  it('skips items already at Ready for QA and owners without a workbench', async () => {
    const s = setup({ status: 'To Do' });
    await s.connectWorkbench();
    for (const t of ['PROJ-1', 'PROJ-2']) await s.put(`/api/work-items/${t}`, { repos: ['acme/api'] });
    s.items.setStatus('local', 'PROJ-1', 'Ready for QA', true);
    s.items.create('u2', 'PROJ-3');
    await syncDue(s.deps);
    expect(s.tools('jira_get_issue').map((c) => c.args.issueKey)).toEqual(['PROJ-2']);
  });

  it('stops polling items outside the flow but still syncs them on demand, and resumes when back in the flow', async () => {
    for (const status of ['Done', 'ON HOLD']) {
      const s = setup({ status });
      await s.connectWorkbench();
      await s.put('/api/work-items/PROJ-1', { repos: ['acme/api'] });
      await syncDue(s.deps);
      expect(s.tools('jira_get_issue')).toHaveLength(1);
      expect(s.items.get('local', 'PROJ-1')).toMatchObject({ status, done: true });
      await syncDue(s.deps);
      expect(s.tools('jira_get_issue')).toHaveLength(1);
      await syncWorkItem(s.deps, 'local', 'PROJ-1');
      expect(s.tools('jira_get_issue')).toHaveLength(2);
      s.jira.status = 'In Progress';
      await syncWorkItem(s.deps, 'local', 'PROJ-1');
      expect(s.items.get('local', 'PROJ-1')).toMatchObject({ done: false });
      await syncDue(s.deps);
      expect(s.tools('jira_get_issue')).toHaveLength(4);
    }
  });

  it('never syncs one item twice at once', async () => {
    const s = setup({ status: 'To Do', delay: 30 });
    await s.connectWorkbench();
    await s.put('/api/work-items/PROJ-1', { repos: ['acme/api'] });
    await Promise.all([syncWorkItem(s.deps, 'local', 'PROJ-1'), syncWorkItem(s.deps, 'local', 'PROJ-1'), syncDue(s.deps)]);
    expect(s.max()).toBe(1);
    expect(s.tools('jira_get_issue').length).toBeGreaterThanOrEqual(1);
  });
});

describe('ticket links', () => {
  const base = { repo: 'acme/api', prId: 12, branch: 'b', title: 't', state: 'OPEN', runId: 'r1' };

  it('re-linking a PR updates it in place', () => {
    const s = setup();
    s.items.create('local', 'PROJ-1');
    s.items.addRepo('local', 'PROJ-1', 'acme/api');
    s.items.link('local', 'PROJ-1', { ...base, kind: 'spec' });
    s.items.link('local', 'PROJ-1', { ...base, kind: 'impl', title: 'new', runId: 'r2' });
    expect(s.items.links('local', 'PROJ-1')).toEqual([expect.objectContaining({ kind: 'impl', runId: 'r2', title: 'new', commented: false })]);
  });

  it('a linked PR gives its ticket to fix queues; an unlinked one gives none', () => {
    const s = setup();
    s.items.create('local', 'PROJ-1');
    s.items.addRepo('local', 'PROJ-1', 'acme/api');
    s.items.link('local', 'PROJ-1', { ...base, kind: 'impl' });
    expect(s.items.ticketForPr('local', 'ACME/api', 12)).toBe('PROJ-1');
    expect(s.items.ticketForPr('local', 'acme/api', 13)).toBeNull();
    expect(s.items.ticketForPr('other', 'acme/api', 12)).toBeNull();
  });
});

describe('work-item API', () => {
  it('sets the repo list from my repos only and keeps owners apart', async () => {
    const s = setup();
    expect((await s.put('/api/work-items/nope', { repos: ['acme/api'] })).status).toBe(400);
    expect((await s.req('/api/work-items/PROJ-1')).status).toBe(404);
    const bad = await s.put('/api/work-items/PROJ-1', { repos: ['acme/api', 'acme/legacy'] });
    expect(bad.status).toBe(403);
    expect(await bad.json()).toMatchObject({ needRepo: true });
    expect(await s.item()).toBeUndefined();
    expect((await s.put('/api/work-items/PROJ-1', { repos: [] })).status).toBe(400);
    expect((await s.put('/api/work-items/PROJ-1', { repos: 'acme/api' })).status).toBe(400);
    const ok = await s.put('/api/work-items/proj-1', { repos: ['ACME/api'] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ticket: 'PROJ-1', repos: [{ name: 'acme/api' }], links: [], note: null, status: null });
    await s.put('/api/work-items/PROJ-1', { repos: ['acme/web', 'acme/api', 'acme/api'] });
    expect((await s.item()).repos.map((r: any) => r.name)).toEqual(['acme/api', 'acme/web']);

    s.items.create('u2', 'PROJ-9');
    s.items.addRepo('u2', 'PROJ-1', 'acme/other');
    s.items.link('u2', 'PROJ-1', { repo: 'acme/other', kind: 'impl', prId: 3, branch: 'b', title: 't', state: 'OPEN', runId: null });
    expect(await s.item('PROJ-9')).toBeUndefined();
    expect(await s.item()).toMatchObject({ links: [], repos: [{ name: 'acme/api' }, { name: 'acme/web' }] });
    expect((await (await s.req('/api/work-items')).json()).items.map((i: any) => i.ticket)).toEqual(['PROJ-1']);
  });

  it('drops a repo from the list only while it has no links', async () => {
    const s = setup();
    await s.put('/api/work-items/PROJ-1', { repos: ['acme/api', 'acme/web'] });
    s.items.link('local', 'PROJ-1', { repo: 'acme/api', kind: 'impl', prId: 12, branch: 'b', title: 't', state: 'OPEN', runId: 'r1' });
    const refused = await s.put('/api/work-items/PROJ-1', { repos: ['acme/web'] });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/acme\/api already has PRs linked to PROJ-1/);
    expect((await s.item()).repos.map((r: any) => r.name)).toEqual(['acme/api', 'acme/web']);
    expect((await s.put('/api/work-items/PROJ-1', { repos: ['acme/api'] })).status).toBe(200);
    expect((await s.item()).repos.map((r: any) => r.name)).toEqual(['acme/api']);
    expect((await s.put('/api/work-items/PROJ-1', { repos: ['acme/api'] })).status).toBe(200);
    expect((await s.item()).links).toHaveLength(1);
  });

  it('maps Jira projects to my repos', async () => {
    const s = setup();
    const ok = await s.patch('/api/my-repos/acme/api', { projects: ['proj', 'OPS', 'PROJ'] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ name: 'acme/api', projects: ['OPS', 'PROJ'] });
    expect((await s.patch('/api/my-repos/acme/api', { projects: ['not a key'] })).status).toBe(400);
    expect((await s.patch('/api/my-repos/acme/api', { projects: Array.from({ length: 21 }, (_, i) => `P${i}X`) })).status).toBe(400);
    expect((await s.patch('/api/my-repos/acme/legacy', { projects: ['PROJ'] })).status).toBe(403);
    expect((await (await s.req('/api/my-repos')).json()).repos.find((r: any) => r.name === 'acme/api').projects).toEqual(['OPS', 'PROJ']);
    expect((await (await s.patch('/api/my-repos/acme/api', { projects: [] })).json()).projects).toEqual([]);
  });
});

describe('ticket runs', () => {
  it('need a stage and a repo in the work item', async () => {
    const s = setup({ gitUrl: forge() });
    const noStage = await s.post('/api/runs', { repo: 'acme/api', prompt: 'go', ticket: 'PROJ-1' });
    expect(noStage.status).toBe(400);
    expect((await noStage.json()).error).toMatch(/stage/);
    expect((await s.post('/api/runs', { cwd: '/tmp', prompt: 'go', ticket: 'PROJ-1' })).status).toBe(400);
    const notInItem = await s.post('/api/runs', { repo: 'acme/api', prompt: 'go', ticket: 'PROJ-1', stage: 'build' });
    expect(notInItem.status).toBe(409);
    expect(await notInItem.json()).toMatchObject({ needWorkItem: true });
    expect(s.starts).toEqual([]);

    const plain = await (await s.post('/api/runs', { cwd: '/tmp', prompt: 'hi', stage: 'build' })).json();
    expect(plain.stage).toBeNull();
  });

  it('carry the stage and its guidance, and move the ticket to In Progress', async () => {
    const s = setup({ gitUrl: forge() });
    await s.connectWorkbench();
    await s.put('/api/work-items/PROJ-1', { repos: ['acme/api'] });
    const res = await s.post('/api/runs', { repo: 'acme/api', prompt: 'Work on PROJ-1', ticket: 'PROJ-1', stage: 'design', kind: 'task' });
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run).toMatchObject({ ticket: 'PROJ-1', stage: 'design' });
    expect(s.starts[0].prompt.startsWith('Work on PROJ-1\n')).toBe(true);
    expect(s.starts[0].prompt).toMatch(/CLAUDE\.md/);
    expect(s.starts[0].prompt).toMatch(/spec/);
    await settle(() => s.jira.status === 'In Progress');
    const items = (await (await s.req('/api/activity/me')).json()).items;
    expect(items[0].stage).toBe('design');
    await s.runs.end(run.id);
  });
});

describe('PR capture', () => {
  const launch = async (o: Opts, branch: string | null) => {
    const s = setup({ gitUrl: forge(), ...o });
    await s.connectWorkbench();
    await s.put('/api/work-items/PROJ-1', { repos: ['acme/api'] });
    const run = await (await s.post('/api/runs', { repo: 'acme/api', prompt: 'build it', ticket: 'PROJ-1', stage: 'build' })).json();
    s.items.setNote('local', 'PROJ-1', 'Error: PR capture failed in acme/api: earlier');
    s.hooks.onListPrs = () => existsSync(join(run.cwd, 'README.md'));
    if (branch) git(run.cwd, 'checkout', '-qb', branch);
    await s.runs.end(run.id);
    await settle(() => !existsSync(run.cwd));
    return { s, run };
  };

  it('stores the open PR of the run branch as a link of the run stage, before the clone is deleted', async () => {
    const open = { 'acme/api': [pr(7, 'OPEN', 'other', 'feat/other'), pr(12, 'OPEN', 'feat: PROJ-1 export', 'feat/PROJ-1')] };
    const { s, run } = await launch({ open, prs: { 'acme/api#12': pr(12, 'OPEN', 'feat: PROJ-1 export', 'feat/PROJ-1') } }, 'feat/PROJ-1');
    expect(s.tools('bitbucket_list_prs').map((c) => [c.args.state, c.cloneExists])).toEqual([['OPEN', true]]);
    const links = s.items.links('local', 'PROJ-1');
    expect(links).toEqual([expect.objectContaining({ repo: 'acme/api', prId: 12, kind: 'impl', branch: 'feat/PROJ-1', runId: run.id })]);
    expect(s.items.get('local', 'PROJ-1')!.note).toBeNull();
    await settle(() => s.tools('jira_add_comment').length === 1);
  });

  it('stores nothing on the base branch or without an open PR', async () => {
    const base = await launch({ open: { 'acme/api': [pr(12, 'OPEN', 'x', 'main')] } }, null);
    expect(base.s.tools('bitbucket_list_prs')).toEqual([]);
    expect(base.s.items.links('local', 'PROJ-1')).toEqual([]);
    const none = await launch({ open: { 'acme/api': [pr(7, 'OPEN', 'other', 'feat/other')] } }, 'feat/PROJ-1');
    expect(none.s.tools('bitbucket_list_prs')).toHaveLength(1);
    expect(none.s.items.links('local', 'PROJ-1')).toEqual([]);
  });
});

describe('factory.db upgrade', () => {
  it('adds the new columns to existing tables, drops the old events, projects tables and link source column', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lf-db-')), 'factory.db');
    const old = new DatabaseSync(path);
    old.exec(`
      create table user_repos (owner text not null, repo_key text not null, name text not null, main_branch text, added_at text not null, primary key (owner, repo_key));
      create table work_items (owner text not null, ticket text not null, created_at text not null, status text, done integer not null default 0, primary key (owner, ticket));
      create table work_item_events (owner text, ticket text, at text, type text, detail text);
      create table repo_projects (owner text, repo_key text, project text);
      create table ticket_links (
        owner text not null, ticket text not null, repo_key text not null, kind text not null,
        pr_id integer not null, branch text not null, title text not null, state text not null,
        source text not null, run_id text, commented integer not null default 0, updated_at text not null,
        primary key (owner, ticket, repo_key, pr_id));
      insert into ticket_links values ('local', 'PROJ-1', 'acme/api', 'impl', 12, 'b', 't', 'OPEN', 'factory', 'r1', 1, '2026-10-16');
      insert into user_repos values ('local', 'acme/api', 'acme/api', 'main', '2026-10-16');
      insert into work_items (owner, ticket, created_at) values ('local', 'PROJ-1', '2026-10-16');`);
    old.close();
    const db = openDb(path);
    const repos = new MyRepos(db);
    expect(repos.list('local')).toEqual([expect.objectContaining({ name: 'acme/api', projects: [] })]);
    repos.setProjects('local', 'acme/api', ['PROJ', 'OPS', 'PROJ']);
    expect(repos.get('local', 'ACME/api')!.projects).toEqual(['OPS', 'PROJ']);
    const items = new WorkItems(db);
    items.addRepo('local', 'PROJ-1', 'acme/api');
    expect((db.prepare(`pragma table_info(ticket_links)`).all() as { name: string }[]).map((c) => c.name)).not.toContain('source');
    expect(items.links('local', 'PROJ-1')).toEqual([expect.objectContaining({ prId: 12, runId: 'r1', commented: true })]);
    items.link('local', 'PROJ-1', { repo: 'acme/api', kind: 'spec', prId: 13, branch: 'b', title: 't', state: 'OPEN', runId: null });
    items.setNote('local', 'PROJ-1', 'Skipped x');
    expect(items.get('local', 'PROJ-1')!.note).toEqual({ text: 'Skipped x', at: expect.any(String) });
    const tables = (db.prepare(`select name from sqlite_master where type = 'table'`).all() as { name: string }[]).map((t) => t.name);
    expect(tables).not.toContain('work_item_events');
    expect(tables).not.toContain('repo_projects');
  });
});
