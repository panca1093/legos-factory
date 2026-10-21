import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildDeps, createApp } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { approveSpec, pipelineRunEnded } from '../server/pipeline.ts';
import { capturePr, startSyncLoop, syncWorkItem } from '../server/jira-sync.ts';
import { launchRun, launchSchema } from '../server/launch-run.ts';
import type { Run } from '../shared/types.ts';

let root: string;
let saved: NodeJS.ProcessEnv;
let deps: ReturnType<typeof buildDeps>;
let runs: RunManager;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
const plan = '```plan\n- id: T1\n  do: Build retry\n  repo: acme/api\n  test: retry.test.ts\n  needs: []\n  touches: [retry.ts]\n- id: T2\n  do: Build banner\n  repo: acme/web\n  test: banner.test.ts\n  needs: []\n  touches: [banner.ts]\n```';

beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), 'lf-wiring-'));
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
  for (const slug of ['api', 'web']) git(root, 'clone', '-q', '--bare', src, join(root, 'acme', `${slug}.git`));
  runs = new RunManager(undefined, undefined, 0);
  deps = buildDeps(runs, { workspaces: join(root, 'workspaces'), gitUrl: `file://${root}/{workspace}/{slug}.git` });
  deps.workbench = async () => ({ token: 'fake', client: {
    bitbucketPr: async () => ({ state: 'OPEN', title: 'Spec', description: plan, reviewers: [] }),
    jiraStatus: async () => 'In Progress', jiraTransitions: async () => [], jiraAddComment: async () => {},
  } as any });
  deps.workItems.create('local', 'PROJ-123');
  for (const name of ['acme/api', 'acme/web']) {
    deps.myRepos.add('local', { name, mainBranch: 'main' });
    deps.workItems.addRepo('local', 'PROJ-123', name);
  }
  deps.db.prepare(`update work_item_repos set stage = 'spec_review'`).run();
  deps.workItems.link('local', 'PROJ-123', { repo: 'acme/api', kind: 'spec', prId: 1, branch: 'main', title: 'Spec', state: 'OPEN', runId: null }, true);
});

afterEach(async () => {
  await Promise.all([...deps.syncs.values()]);
  deps.db.close();
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

const queued = () => { const s = runs.snapshot(); return s.type === 'snapshot' ? s.runs : []; };
async function finish(run: Run, result: string | null = null) {
  run.endedAt = new Date().toISOString();
  run.status = 'completed';
  run.result = result;
  await pipelineRunEnded(deps, run);
}

it('approving the spec starts the first wave', async () => {
  await approveSpec(deps, 'local', 'PROJ-123');
  expect(deps.workItems.repos('local', 'PROJ-123').map((r) => r.stage)).toEqual(['building', 'building']);
  expect(queued()).toHaveLength(1);
  expect(queued()[0]).toMatchObject({ task: 'T1', persona: 'builder', status: 'queued' });
  expect(deps.workItems.get('local', 'PROJ-123')?.plan?.tasks[0].state).toBe('running');
  await syncWorkItem(deps, 'local', 'PROJ-123');
  await approveSpec(deps, 'local', 'PROJ-123');
  expect(queued()).toHaveLength(1);
});

it('a passing review with no matching rule marks the repo ready', async () => {
  await approveSpec(deps, 'local', 'PROJ-123');
  await finish(queued()[0]);
  expect(queued()[1]).toMatchObject({ task: 'T1', persona: 'inspector' });
  deps.workItems.link('local', 'PROJ-123', { repo: 'acme/api', kind: 'impl', prId: 2, branch: 'main', title: 'Build', state: 'OPEN', runId: null }, true);
  await finish(queued()[1], 'Verdict: APPROVE');
  expect(deps.workItems.repos('local', 'PROJ-123')[0].stage).toBe('ready');
  expect(deps.workItems.get('local', 'PROJ-123')?.plan?.tasks[0].state).toBe('done');
  expect(queued()[2]).toMatchObject({ task: 'T2', persona: 'builder' });
});

it('a failing review starts the same task again', async () => {
  await approveSpec(deps, 'local', 'PROJ-123');
  await finish(queued()[0]);
  const inspector = queued()[1];
  await finish(inspector, 'Finding: retry cap is ignored.\nVerdict: REQUEST_CHANGES');
  expect(queued()[2]).toMatchObject({ task: 'T1', persona: 'builder' });
  expect(queued()[2].prompt).toContain('retry cap is ignored');
  expect(deps.workItems.repos('local', 'PROJ-123')[0].attempt).toBe(1);
  await pipelineRunEnded(deps, inspector);
  expect(queued()).toHaveLength(3);
});

it('backfills stages of existing work items from their links', () => {
  deps.db.prepare(`update work_item_repos set stage = 'building'`).run();
  deps.workItems.link('local', 'PROJ-123', { repo: 'acme/web', kind: 'impl', prId: 3, branch: 'main', title: 'Build', state: 'MERGED', runId: null }, true);
  const timer = startSyncLoop(deps, 60_000);
  clearInterval(timer);
  expect(deps.workItems.repos('local', 'PROJ-123').map((r) => r.stage)).toEqual(['spec_review', 'done']);
});

it('an unreadable stored plan does not break the list', async () => {
  deps.db.prepare(`update work_items set plan = '{broken'`).run();
  const app = createApp(runs, {}, deps);
  const res = await app.request('http://localhost/api/work-items', { headers: { host: 'localhost' } });
  expect(res.status).toBe(200);
  expect((await res.json()).items[0].plan).toEqual({ tasks: [], error: 'stored plan is unreadable' });
});

it('does not treat ABSTAIN as a passing review', async () => {
  await approveSpec(deps, 'local', 'PROJ-123');
  await finish(queued()[0]);
  await finish(queued()[1], 'Verdict: ABSTAIN');
  expect(queued()).toHaveLength(2);
  expect(deps.workItems.get('local', 'PROJ-123')?.plan?.tasks[0].state).toBe('failed');
  await syncWorkItem(deps, 'local', 'PROJ-123');
  expect(queued()).toHaveLength(2);
  expect(deps.workItems.get('local', 'PROJ-123')?.note?.text).toContain('Escalated:');
});

it('does not retry an Inspector stopped by the person', async () => {
  await approveSpec(deps, 'local', 'PROJ-123');
  await finish(queued()[0]);
  queued()[1].endedBy = 'user';
  await finish(queued()[1]);
  expect(queued()).toHaveLength(2);
  expect(deps.workItems.get('local', 'PROJ-123')?.note?.text).toContain('Escalated:');
});

it('a declined PR escalates without retrying the current task or changing its stage', async () => {
  await approveSpec(deps, 'local', 'PROJ-123');
  await finish(queued()[0]);
  deps.workItems.link('local', 'PROJ-123', { repo: 'acme/api', kind: 'impl', prId: 2, branch: 'main', title: 'Build', state: 'DECLINED', runId: null }, true);
  await finish(queued()[1], 'Verdict: REQUEST_CHANGES');
  expect(queued()).toHaveLength(2);
  expect(deps.workItems.repos('local', 'PROJ-123')[0]).toMatchObject({ stage: 'building', attempt: 0 });
  expect(deps.workItems.get('local', 'PROJ-123')?.note?.text).toContain('impl PR declined');
});

it('backfill leaves pipeline runs and explicit stages alone and handles open implementation PRs', async () => {
  await approveSpec(deps, 'local', 'PROJ-123');
  deps.workItems.link('local', 'PROJ-123', { repo: 'acme/api', kind: 'impl', prId: 2, branch: 'main', title: 'Build', state: 'MERGED', runId: null }, true);
  deps.workItems.setStage('local', 'PROJ-123', 'acme/web', 'ready', 2);
  deps.workItems.create('local', 'PROJ-124');
  deps.workItems.addRepo('local', 'PROJ-124', 'acme/api');
  deps.workItems.addRepo('local', 'PROJ-124', 'acme/web');
  deps.workItems.link('local', 'PROJ-124', { repo: 'acme/api', kind: 'impl', prId: 3, branch: 'main', title: 'Build', state: 'OPEN', runId: null }, true);
  deps.workItems.backfillStages();
  expect(deps.workItems.repos('local', 'PROJ-123').map((r) => r.stage)).toEqual(['building', 'ready']);
  expect(deps.workItems.repos('local', 'PROJ-124').map((r) => r.stage)).toEqual(['pr_review', 'building']);
});

it('initial design shapes all untouched repos and captured spec opens the ticket gate', async () => {
  deps.db.prepare(`delete from ticket_links`).run();
  deps.db.prepare(`update work_item_repos set stage = 'building'`).run();
  deps.workItems.addRepo('local', 'PROJ-123', 'acme/advanced');
  deps.workItems.setStage('local', 'PROJ-123', 'acme/advanced', 'ready', 1);
  const timer = startSyncLoop(deps, 60_000);
  clearInterval(timer);
  const run = await launchRun(deps, 'local', launchSchema.parse({ ticket: 'PROJ-123', stage: 'design', kind: 'task', persona: 'foreman', repo: 'acme/api', prompt: 'Write the ticket spec' }));
  expect(deps.workItems.repos('local', 'PROJ-123').map((r) => r.stage)).toEqual(['ready', 'shaping', 'shaping']);
  git(run.cwd, 'checkout', '-qb', 'feat/spec');
  const wb = (await deps.workbench('local'))!;
  wb.client.bitbucketPrs = async () => [{ id: 1, source: 'feat/spec', title: 'Spec', state: 'OPEN' } as any];
  deps.workbench = async () => wb;
  run.endedAt = new Date().toISOString();
  run.status = 'completed';
  await capturePr(deps, run, run.cwd);
  await syncWorkItem(deps, 'local', 'PROJ-123');
  expect(deps.workItems.repos('local', 'PROJ-123').map((r) => r.stage)).toEqual(['ready', 'spec_review', 'shaping']);
  await approveSpec(deps, 'local', 'PROJ-123');
  expect(deps.workItems.repos('local', 'PROJ-123').map((r) => r.stage)).toEqual(['ready', 'building', 'building']);
  expect(queued().filter((r) => r.persona === 'builder')).toHaveLength(1);
});
