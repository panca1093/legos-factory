import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildDeps } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { approveSpec, pipelineRunEnded, syncPipeline } from '../server/pipeline.ts';
import type { Run } from '../shared/types.ts';

let root: string;
let saved: NodeJS.ProcessEnv;
let deps: ReturnType<typeof buildDeps>;
let runs: RunManager;
let fakeWb: { token: string; client: any };
let plan = '';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

const task = (id: string, repo: string, test: string, touches: string) =>
  [`- id: ${id}`, `  do: Build ${id}`, `  repo: ${repo}`, `  test: ${test}`, '  needs: []', `  touches: [${touches}]`].join('\n');

const setParallel = (parallelBuilders: number) =>
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ automation: { parallelBuilders } }));

beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), 'lf-parallel-'));
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
  fakeWb = { token: 'fake', client: {
    bitbucketPr: async () => ({ state: 'OPEN', title: 'Spec', description: `\`\`\`plan\n${plan}\n\`\`\``, reviewers: [] }),
    bitbucketPrFiles: async () => [{ status: 'modified', path: 'retry.ts', oldPath: null, added: 12, removed: 3 }],
    jiraIssue: async () => ({ key: 'PROJ-123', summary: 'Retry cap', issueType: 'Story', labels: [], status: 'In Progress' }),
    jiraStatus: async () => 'In Progress', jiraTransitions: async () => [], jiraAddComment: async () => {},
  } as any };
  deps.workbench = async () => fakeWb;
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

it('runs two independent tasks at once', async () => {
  setParallel(2);
  plan = [task('T1', 'acme/api', 'retry.test.ts', 'retry.ts'), task('T2', 'acme/web', 'banner.test.ts', 'banner.ts')].join('\n');
  await approveSpec(deps, 'local', 'PROJ-123');
  expect(queued()).toHaveLength(2);
  expect(queued().map((r) => r.task)).toEqual(['T1', 'T2']);
  expect(queued().map((r) => r.persona)).toEqual(['builder', 'builder']);
  // every task works in its own workspace, on its own branch
  expect(queued()[0].cwd).toContain('PROJ-123-T1');
  expect(queued()[1].cwd).toContain('PROJ-123-T2');
  expect(queued()[0].cwd).not.toBe(queued()[1].cwd);
  expect(queued()[0].prompt).toContain('factory/PROJ-123/T1');
  expect(queued()[1].prompt).toContain('factory/PROJ-123/T2');
});

it('never runs tasks with overlapping touches together', async () => {
  setParallel(2);
  plan = [task('T1', 'acme/api', 'retry.test.ts', 'retry.ts'), task('T2', 'acme/api', 'cap.test.ts', 'retry.ts')].join('\n');
  await approveSpec(deps, 'local', 'PROJ-123');
  expect(queued()).toHaveLength(1);
  expect(queued()[0]).toMatchObject({ task: 'T1', persona: 'builder' });
  await finish(queued()[0]);
  await finish(queued()[1], 'Verdict: APPROVE');
  expect(queued()[2]).toMatchObject({ task: 'T2', persona: 'builder' });
});

it('stays sequential when parallelBuilders is 0', async () => {
  setParallel(0);
  plan = [task('T1', 'acme/api', 'retry.test.ts', 'retry.ts'), task('T2', 'acme/web', 'banner.test.ts', 'banner.ts')].join('\n');
  await approveSpec(deps, 'local', 'PROJ-123');
  expect(queued()).toHaveLength(1);
  expect(queued()[0]).toMatchObject({ task: 'T1', persona: 'builder' });
  await finish(queued()[0]);
  expect(queued()[1]).toMatchObject({ task: 'T1', persona: 'inspector' });
  await finish(queued()[1], 'Verdict: APPROVE');
  expect(queued()[2]).toMatchObject({ task: 'T2', persona: 'builder' });
});

it('merges the task branches into one pull request', async () => {
  setParallel(2);
  plan = [task('T1', 'acme/api', 'retry.test.ts', 'retry.ts'), task('T2', 'acme/api', 'cap.test.ts', 'cap.ts')].join('\n');
  await approveSpec(deps, 'local', 'PROJ-123');
  expect(queued()).toHaveLength(2);
  // the task runs push their own branch and open no pull request
  expect(queued()[0].prompt).toContain('Do not open a pull request');
  expect(queued()[1].prompt).toContain('Do not open a pull request');
  await finish(queued()[0]);
  await finish(queued()[1]);
  await finish(queued()[2], 'Verdict: APPROVE');
  await finish(queued()[3], 'Verdict: APPROVE');
  const merge = queued()[4];
  expect(merge).toMatchObject({ persona: 'builder', task: null, repo: 'acme/api' });
  expect(merge.prompt).toContain('factory/PROJ-123/T1');
  expect(merge.prompt).toContain('factory/PROJ-123/T2');
  expect(merge.prompt).toContain('factory/PROJ-123/api');
  expect(merge.prompt).toContain('retry.test.ts');
  expect(merge.prompt).toContain('cap.test.ts');
  // the merged branch carries the one pull request of the repo
  deps.workItems.link('local', 'PROJ-123', { repo: 'acme/api', kind: 'impl', prId: 2, branch: 'factory/PROJ-123/api', title: 'Build', state: 'OPEN', runId: null }, true);
  await syncPipeline(deps, 'local', 'PROJ-123');
  expect(deps.workItems.repos('local', 'PROJ-123')[0].stage).toBe('ready');
  expect(deps.workItems.links('local', 'PROJ-123').filter((l) => l.kind === 'impl')).toHaveLength(1);
  // the repo merges once
  await syncPipeline(deps, 'local', 'PROJ-123');
  expect(queued().filter((r) => r.persona === 'builder' && r.task === null)).toHaveLength(1);
});
