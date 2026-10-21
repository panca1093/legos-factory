import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildDeps, createApp } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { syncWorkItem } from '../server/jira-sync.ts';
import { pipelineRunEnded } from '../server/pipeline.ts';
import { MERGE_TOOL } from '../server/routes/prs.ts';
import type { Run } from '../shared/types.ts';

let root: string;
let saved: NodeJS.ProcessEnv;
let deps: ReturnType<typeof buildDeps>;
let runs: RunManager;
let fakeWb: { token: string; client: any };
let toolCalls: { name: string; args: any }[];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
const branchOf = (cwd: string) => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: 'pipe' }).toString().trim();
const plan = '```plan\n- id: T1\n  do: Build retry\n  repo: acme/api\n  test: retry.test.ts\n  needs: []\n  touches: [retry.ts]\n- id: T2\n  do: Build banner\n  repo: acme/web\n  test: banner.test.ts\n  needs: []\n  touches: [banner.ts]\n```';

beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), 'lf-gates-'));
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
  for (const slug of ['api', 'web']) {
    git(root, 'clone', '-q', '--bare', src, join(root, 'acme', `${slug}.git`));
    git(join(root, 'acme', `${slug}.git`), 'branch', 'feat/spec');
    git(join(root, 'acme', `${slug}.git`), 'branch', 'feat/api');
  }
  runs = new RunManager(undefined, undefined, 0);
  deps = buildDeps(runs, { workspaces: join(root, 'workspaces'), gitUrl: `file://${root}/{workspace}/{slug}.git` });
  toolCalls = [];
  fakeWb = { token: 'fake', client: {
    bitbucketPr: async (_token: string, workspace: string, slug: string, id: number) => ({ state: 'OPEN', title: 'Spec', description: plan, reviewers: [], url: `https://forge.example.com/${workspace}/${slug}/pull/${id}` }),
    bitbucketPrFiles: async () => [{ status: 'modified', path: 'retry.ts', oldPath: null, added: 12, removed: 3 }],
    jiraIssue: async () => ({ key: 'PROJ-123', summary: 'Retry cap', issueType: 'Story', labels: [], status: 'In Progress' }),
    jiraStatus: async () => 'In Progress', jiraTransitions: async () => [], jiraAddComment: async () => {},
    listTools: async () => [],
    call: async (_token: string, name: string, args: any) => (toolCalls.push({ name, args }), {}),
  } as any };
  deps.workbench = async () => fakeWb;
  deps.workItems.create('local', 'PROJ-123');
  for (const name of ['acme/api', 'acme/web']) {
    deps.myRepos.add('local', { name, mainBranch: 'main' });
    deps.workItems.addRepo('local', 'PROJ-123', name);
  }
  deps.workItems.setStage('local', 'PROJ-123', 'acme/api', 'spec_review');
  deps.workItems.setStage('local', 'PROJ-123', 'acme/web', 'spec_review');
  deps.workItems.link('local', 'PROJ-123', { repo: 'acme/api', kind: 'spec', prId: 1, branch: 'feat/spec', title: 'Spec', state: 'OPEN', runId: null }, true);
});

afterEach(async () => {
  await Promise.all([...deps.syncs.values()]);
  deps.db.close();
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

const app = () => createApp(runs, {}, deps);
const post = (path: string, body: unknown = {}) => app().request(`http://localhost${path}`, { method: 'POST', headers: { host: 'localhost', 'x-legos': '1' }, body: JSON.stringify(body) });
const queued = () => { const s = runs.snapshot(); return s.type === 'snapshot' ? s.runs : []; };
const repoOf = (name: string) => deps.workItems.repos('local', 'PROJ-123').find((r) => r.name === name)!;

async function finish(run: Run, result: string | null = null) {
  run.endedAt = new Date().toISOString();
  run.status = 'completed';
  run.result = result;
  await pipelineRunEnded(deps, run);
}

const linkImpl = (prId = 7) => deps.workItems.link('local', 'PROJ-123', { repo: 'acme/api', kind: 'impl', prId, branch: 'feat/api', title: 'Build', state: 'OPEN', runId: null }, true);

it('approve-spec starts the build wave', async () => {
  const res = await post('/api/work-items/PROJ-123/approve-spec');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(deps.workItems.repos('local', 'PROJ-123').map((r) => r.stage)).toEqual(['building', 'building']);
  expect(queued()[0]).toMatchObject({ task: 'T1', persona: 'builder', status: 'queued' });
});

it('approve marks a routed PR ready to merge', async () => {
  deps.workItems.setStage('local', 'PROJ-123', 'acme/api', 'pr_review');
  deps.workItems.setRouting('local', 'PROJ-123', 'acme/api', { at: '2026-10-21T00:00:00.000Z', reasons: ['paths: db/migrations/0042.sql'], matches: [{ id: 'r1', reason: 'paths: db/migrations/0042.sql' }], inspectorReasons: [], findings: '' });
  linkImpl();
  const res = await post('/api/work-items/PROJ-123/prs/acme%2Fapi/approve');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(repoOf('acme/api').stage).toBe('ready');
  const other = await post('/api/work-items/PROJ-123/prs/acme%2Fweb/approve');
  expect(other.status).toBe(409);
  expect(await other.json()).toEqual({ error: 'that PR is not waiting for a review' });
  const items = await (await app().request('http://localhost/api/work-items', { headers: { host: 'localhost' } })).json();
  expect(items.items[0].routing['acme/api'].reasons).toEqual(['paths: db/migrations/0042.sql']);
});

it('merge without a forge merge tool answers 409 with the PR url', async () => {
  deps.workItems.setStage('local', 'PROJ-123', 'acme/api', 'ready');
  linkImpl();
  const res = await post('/api/work-items/PROJ-123/prs/acme%2Fapi/merge');
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: 'merge in the forge', url: 'https://forge.example.com/acme/api/pull/7' });
});

it('merge calls the forge merge tool when there is one', async () => {
  fakeWb.client.listTools = async () => [{ name: 'bitbucket_merge_pr' }];
  deps.workItems.setStage('local', 'PROJ-123', 'acme/api', 'ready');
  linkImpl();
  const res = await post('/api/work-items/PROJ-123/prs/acme%2Fapi/merge');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(toolCalls).toEqual([{ name: 'bitbucket_merge_pr', args: { workspace: 'acme', repoSlug: 'api', pullRequestId: 7 } }]);
});

it('an unrelated tool with merge in its name is never called', async () => {
  fakeWb.client.listTools = async () => [{ name: 'bitbucket_merge_pull_request' }];
  deps.workItems.setStage('local', 'PROJ-123', 'acme/api', 'ready');
  linkImpl();
  const res = await post('/api/work-items/PROJ-123/prs/acme%2Fapi/merge');
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: 'merge in the forge', url: 'https://forge.example.com/acme/api/pull/7' });
  expect(toolCalls).toEqual([]);
});

it('the merge is called with the exact tool name', async () => {
  fakeWb.client.listTools = async () => [{ name: MERGE_TOOL }];
  deps.workItems.setStage('local', 'PROJ-123', 'acme/api', 'ready');
  linkImpl();
  const res = await post('/api/work-items/PROJ-123/prs/acme%2Fapi/merge');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(toolCalls).toEqual([{ name: MERGE_TOOL, args: { workspace: 'acme', repoSlug: 'api', pullRequestId: 7 } }]);
});

it('request spec changes sends the spec back to the Foreman', async () => {
  const res = await post('/api/work-items/PROJ-123/request-spec-changes', { comment: 'name the failure mode' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  const run = queued()[0];
  expect(run).toMatchObject({ persona: 'foreman', stage: 'design', kind: 'task', repo: 'acme/api' });
  expect(run.prompt).toContain('name the failure mode');
  expect(branchOf(run.cwd)).toBe('feat/spec');
  expect(repoOf('acme/api').stage).toBe('shaping');
});

it('request PR changes runs the same task again on the same branch', async () => {
  await post('/api/work-items/PROJ-123/approve-spec');
  await finish(queued()[0]);
  linkImpl(2);
  await finish(queued()[1], 'Verdict: APPROVE');
  expect(repoOf('acme/api').stage).toBe('ready');
  const before = queued().length;
  const res = await post('/api/work-items/PROJ-123/prs/acme%2Fapi/request-changes', { comment: 'the retry cap is ignored' });
  expect(res.status).toBe(200);
  const run = queued()[before];
  expect(run).toMatchObject({ task: 'T1', persona: 'builder' });
  expect(run.prompt).toContain('the retry cap is ignored');
  expect(branchOf(run.cwd)).toBe('feat/api');
  expect(repoOf('acme/api')).toMatchObject({ stage: 'building', attempt: 0 });
});

it('request changes without a comment answers 400', async () => {
  const spec = await post('/api/work-items/PROJ-123/request-spec-changes');
  expect(spec.status).toBe(400);
  expect(await spec.json()).toEqual({ error: 'comment is required' });
  const impl = await post('/api/work-items/PROJ-123/prs/acme%2Fapi/request-changes', { comment: '   ' });
  expect(impl.status).toBe(400);
  expect(await impl.json()).toEqual({ error: 'comment is required' });
  expect(queued()).toHaveLength(0);
});

it('the spec waits for the Foreman before it is ready for review', async () => {
  await post('/api/work-items/PROJ-123/request-spec-changes', { comment: 'tighten the wording' });
  expect(repoOf('acme/api').stage).toBe('shaping');
  await syncWorkItem(deps, 'local', 'PROJ-123');
  expect(repoOf('acme/api').stage).toBe('shaping');
  queued()[0].endedAt = new Date().toISOString();
  await syncWorkItem(deps, 'local', 'PROJ-123');
  expect(repoOf('acme/api').stage).toBe('spec_review');
});
