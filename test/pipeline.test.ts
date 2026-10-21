import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDeps } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { approveSpec, next, pipelineRunEnded, syncPipeline, type Action, type Facts, type State } from '../server/pipeline.ts';
import type { PipelineStage, PlanTask, Run } from '../shared/types.ts';

const task = (id = 'T1', state: PlanTask['state'] = 'waiting', needs: string[] = []): PlanTask => ({
  id, state, needs, do: 'Build feature', repo: 'acme/api', test: 'feature.test.ts', touches: [id + '.ts'],
});
const state = (stage: PipelineStage, tasks = [task()], attempt = 0): State => ({
  repos: [{ repo: 'acme/api', stage, attempt }], plan: { tasks, error: null },
});
const start = (id: string, persona = 'builder'): Action => ({ type: 'start_run', repo: 'acme/api', task: id, persona: persona as 'builder' | 'inspector' });
const stage = (value: PipelineStage): Action => ({ type: 'set_stage', repo: 'acme/api', stage: value, attempt: 0 });
const ended = (persona: 'builder' | 'inspector', verdict?: 'pass' | 'changes_requested'): Facts => ({
  reviewAttempts: 3, event: { type: 'run_ended', repo: 'acme/api', task: 'T1', persona, ok: true, verdict },
});
const pr = (kind: 'spec' | 'impl', value: 'opened' | 'approved' | 'merged' | 'declined'): Facts => ({
  reviewAttempts: 3, event: { type: 'pr', repo: 'acme/api', kind, state: value },
});

describe('pipeline transitions', () => {
  const rows: { name: string; state: State; facts: Facts; want: Action[] }[] = [
    { name: 'brainstorm and spec review wait for a human', state: state('shaping'), facts: { reviewAttempts: 3 }, want: [] },
    { name: 'opening a spec PR enters the spec review gate', state: state('shaping'), facts: pr('spec', 'opened'), want: [stage('spec_review')] },
    { name: 'a finished foreman does not approve the spec', state: state('shaping'), facts: { reviewAttempts: 3, event: { type: 'run_ended', repo: 'acme/api', task: null, persona: 'foreman', ok: true } }, want: [] },
    { name: 'spec approval starts the first task', state: state('spec_review'), facts: { reviewAttempts: 3, event: { type: 'spec_approved' } }, want: [stage('building'), start('T1')] },
    { name: 'default builds stay sequential for independent tasks', state: state('spec_review', [task(), task('T2')]), facts: { reviewAttempts: 3, event: { type: 'spec_approved' } }, want: [stage('building'), start('T1')] },
    { name: 'fallback plans run tasks sequentially too', state: { ...state('spec_review', [task(), task('T2')]), plan: { tasks: [task(), task('T2')], error: 'no plan block' } }, facts: { reviewAttempts: 3, event: { type: 'spec_approved' } }, want: [stage('building'), start('T1')] },
    { name: 'a successful builder starts the inspector', state: state('building', [task('T1', 'running')]), facts: ended('builder'), want: [start('T1', 'inspector')] },
    { name: 'a passing inspector completes the task and starts its dependent', state: state('building', [task('T1', 'running'), task('T2', 'waiting', ['T1'])]), facts: ended('inspector', 'pass'), want: [{ type: 'set_task', task: 'T1', state: 'done' }, stage('building'), start('T2')] },
    { name: 'a completed repo waits for its implementation PR', state: state('building', [task('T1', 'running')]), facts: ended('inspector', 'pass'), want: [{ type: 'set_task', task: 'T1', state: 'done' }, stage('building')] },
    { name: 'an unrouted implementation PR becomes ready', state: state('building', [task('T1', 'done')]), facts: pr('impl', 'opened'), want: [{ type: 'mark_ready', repo: 'acme/api' }] },
    { name: 'a matched rule routes the PR to a person', state: state('building', [task('T1', 'done')]), facts: { ...pr('impl', 'opened'), ruleMatched: true }, want: [stage('pr_review')] },
    { name: 'an inspector can also route the PR to a person', state: state('building', [task('T1', 'done')]), facts: { ...pr('impl', 'opened'), inspectorReasons: ['Check compatibility'] }, want: [stage('pr_review')] },
    { name: 'an unfinished task cannot reach ready', state: state('building'), facts: pr('impl', 'opened'), want: [] },
    { name: 'a human PR approval marks ready', state: state('pr_review', [task('T1', 'done')]), facts: pr('impl', 'approved'), want: [{ type: 'mark_ready', repo: 'acme/api' }] },
    { name: 'ready waits for the human merge', state: state('ready', [task('T1', 'done')]), facts: { reviewAttempts: 3 }, want: [] },
    { name: 'a merged implementation PR marks done', state: state('ready', [task('T1', 'done')]), facts: pr('impl', 'merged'), want: [stage('done')] },
    { name: 'a declined spec escalates without a stage change or retry', state: state('spec_review'), facts: pr('spec', 'declined'), want: [{ type: 'escalate', repo: 'acme/api', reason: 'spec PR declined' }] },
    { name: 'a declined implementation escalates without a stage change or retry', state: state('pr_review'), facts: pr('impl', 'declined'), want: [{ type: 'escalate', repo: 'acme/api', reason: 'impl PR declined' }] },
  ];
  it.each(rows)('$name', ({ state, facts, want }) => {
    const before = structuredClone({ state, facts });
    expect(next(state, facts)).toEqual(want);
    expect({ state, facts }).toEqual(before);
  });

  it('one ticket spec approval moves all its repos into building', () => {
    const input: State = {
      repos: [
        { repo: 'acme/api', stage: 'spec_review', attempt: 0 },
        { repo: 'acme/web', stage: 'shaping', attempt: 0 },
      ],
      plan: { tasks: [task(), { ...task('T2', 'waiting', ['T1']), repo: 'acme/web' }], error: null },
    };
    const before = structuredClone(input);
    expect(next(input, { reviewAttempts: 3, event: { type: 'spec_approved' } })).toEqual([
      stage('building'),
      { type: 'set_stage', repo: 'acme/web', stage: 'building', attempt: 0 },
      start('T1'),
    ]);
    expect(input).toEqual(before);
    input.repos.forEach((repo) => { repo.stage = 'building'; });
    input.plan!.tasks[0].state = 'running';
    expect(next(input, ended('inspector', 'pass'))).toEqual([
      { type: 'set_task', task: 'T1', state: 'done' }, stage('building'),
      { type: 'start_run', repo: 'acme/web', task: 'T2', persona: 'builder' },
    ]);
  });

  it.each(['building', 'pr_review', 'ready', 'done'] as const)('duplicate spec approval preserves a repo already in %s', (advanced) => {
    const input: State = {
      repos: [
        { repo: 'acme/api', stage: advanced, attempt: 2 },
        { repo: 'acme/web', stage: 'shaping', attempt: 0 },
      ],
      plan: { tasks: [{ ...task('T2'), repo: 'acme/web' }], error: null },
    };
    expect(next(input, { reviewAttempts: 3, event: { type: 'spec_approved' } })).toEqual([
      { type: 'set_stage', repo: 'acme/web', stage: 'building', attempt: 0 },
      { type: 'start_run', repo: 'acme/web', task: 'T2', persona: 'builder' },
    ]);
    expect(input.repos[0]).toEqual({ repo: 'acme/api', stage: advanced, attempt: 2 });
  });

  it('escalates after reviewAttempts failed reviews', () => {
    expect(next(state('building', [task('T1', 'running')], 2), ended('inspector', 'changes_requested'))).toEqual([
      { type: 'set_stage', repo: 'acme/api', stage: 'building', attempt: 3 },
      { type: 'set_task', task: 'T1', state: 'failed' },
      { type: 'escalate', repo: 'acme/api', task: 'T1', reason: 'review attempts exhausted' },
    ]);
  });

  it('a review finding re-runs the same task', () => {
    expect(next(state('building', [task('T1', 'running'), task('T2')]), ended('inspector', 'changes_requested'))).toEqual([
      { type: 'set_stage', repo: 'acme/api', stage: 'building', attempt: 1 }, start('T1'),
    ]);
  });

  it('does not start another task while a task is running or paused', () => {
    for (const status of ['running', 'paused'] as const) {
      expect(next(state('building', [task('T1', status), task('T2')]), { reviewAttempts: 3 })).toEqual([]);
    }
  });

  it('ignores events for an unknown repo or task', () => {
    expect(next(state('building'), { ...ended('builder'), event: { type: 'run_ended', repo: 'acme/web', task: 'T1', persona: 'builder', ok: true } })).toEqual([]);
    expect(next(state('building'), { ...ended('builder'), event: { type: 'run_ended', repo: 'acme/api', task: 'missing', persona: 'builder', ok: true } })).toEqual([]);
  });
});

describe('cataloger after merge', () => {
  let root: string;
  let saved: NodeJS.ProcessEnv;
  let deps: ReturnType<typeof buildDeps>;
  let runs: RunManager;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const plan = '```plan\n- id: T1\n  do: Build retry\n  repo: acme/api\n  test: retry.test.ts\n  needs: []\n  touches: [retry.ts]\n```';

  beforeEach(() => {
    saved = { ...process.env };
    root = mkdtempSync(join(tmpdir(), 'lf-cataloger-'));
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
    runs = new RunManager(undefined, undefined, 0);
    deps = buildDeps(runs, { workspaces: join(root, 'workspaces'), gitUrl: `file://${root}/{workspace}/{slug}.git` });
    deps.workbench = async () => ({ token: 'fake', client: {
      bitbucketPr: async () => ({ state: 'OPEN', title: 'Spec', description: plan, reviewers: [] }),
      bitbucketPrFiles: async () => [{ status: 'modified', path: 'retry.ts', oldPath: null, added: 12, removed: 3 }],
      jiraIssue: async () => ({ key: 'PROJ-123', summary: 'Retry cap', issueType: 'Story', labels: [], status: 'In Progress' }),
      jiraStatus: async () => 'In Progress', jiraTransitions: async () => [], jiraAddComment: async () => {},
    } as any });
    deps.workItems.create('local', 'PROJ-123');
    deps.myRepos.add('local', { name: 'acme/api', mainBranch: 'main' });
    deps.workItems.addRepo('local', 'PROJ-123', 'acme/api');
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

  // build the repo, review it and merge its pull request
  async function buildAndMerge() {
    await approveSpec(deps, 'local', 'PROJ-123');
    await finish(queued()[0]);
    deps.workItems.link('local', 'PROJ-123', { repo: 'acme/api', kind: 'impl', prId: 2, branch: 'factory/PROJ-123/api', title: 'Build', state: 'OPEN', runId: null }, true);
    await finish(queued()[1], 'Verdict: APPROVE');
    deps.workItems.link('local', 'PROJ-123', { repo: 'acme/api', kind: 'impl', prId: 2, branch: 'factory/PROJ-123/api', title: 'Build', state: 'MERGED', runId: null }, true);
  }

  it('starts the cataloger after merge', async () => {
    await buildAndMerge();
    await syncPipeline(deps, 'local', 'PROJ-123');
    const cataloger = queued().find((r) => r.persona === 'cataloger');
    expect(cataloger).toMatchObject({ repo: 'acme/api', task: null, kind: 'task', stage: 'build' });
    expect(cataloger!.prompt).toContain('Do not open a pull request');
    expect(deps.workItems.get('local', 'PROJ-123')?.plan?.tasks[0].state).toBe('done');
  });

  it('skips it when off', async () => {
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ automation: { models: { foreman: 'opus', builder: 'sonnet', inspector: 'opus', cataloger: 'off' } } }));
    await buildAndMerge();
    await syncPipeline(deps, 'local', 'PROJ-123');
    expect(queued().some((r) => r.persona === 'cataloger')).toBe(false);
  });
});
