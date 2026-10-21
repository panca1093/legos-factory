import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDeps, createApp } from '../server/app.ts';
import { RunManager, type QueryFn, type StartRequest } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import { syncWorkItem } from '../server/jira-sync.ts';
import { MyRepos } from '../server/my-repos.ts';
import { MAX_REVIEW_LOOPS, current, parseVerdict } from '../server/stages.ts';
import { loadWorkflow, parseWorkflow, workflowDir } from '../server/workflow.ts';
import { WB, fakeServers } from './fakes.ts';

// a missing directory must fail, not run git in whatever repository the tests are started from
const git = (cwd: string, ...args: string[]) => {
  if (!cwd) throw new Error('git needs a directory');
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
};

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
  git(root, 'clone', '-q', '--bare', src, join(root, 'acme', 'api.git'));
  return `file://${root}/{workspace}/{slug}.git`;
}

const TRANSITIONS = [
  { id: '21', name: 'Start', toStatus: 'In Progress' },
  { id: '31', name: 'Review', toStatus: 'Code Review' },
  { id: '41', name: 'Ready', toStatus: 'Ready for QA' },
];

type Pr = { id: number; title: string; state: string; source: string; destination: string; url: string };

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond(), what).toBe(true);
};

// A fake agent per run: it starts, then waits for the test to finish it with a result.
type Agent = { req: StartRequest; options: any; finish: (result: string) => void };

function setup(opts: { workflowDir?: string } = {}) {
  const jira = { status: 'To Do' };
  const prs = new Map<string, Pr>();
  const srv = fakeServers({
    exec: (tool, args) => {
      if (tool === 'jira_get_issue') return { key: args.issueKey, summary: 's', status: jira.status };
      if (tool === 'jira_get_transitions') return { transitions: TRANSITIONS };
      if (tool === 'jira_transition_issue') {
        jira.status = TRANSITIONS.find((t) => t.id === args.transitionId)!.toStatus;
        return { success: true };
      }
      if (tool === 'jira_add_comment') return { id: '1' };
      if (tool === 'bitbucket_list_prs') return { prs: [...prs.values()].filter((p) => p.state === args.state), hasMore: false };
      if (tool === 'bitbucket_get_pr') {
        const p = prs.get(`${args.workspace}/${args.repoSlug}#${args.pullRequestId}`);
        if (!p) throw new Error('not found');
        return p;
      }
      return null;
    },
  });
  const agents: Agent[] = [];
  const fn = (({ prompt, options }: any) => {
    let finish!: (result: string) => void;
    const done = new Promise<string>((resolve) => (finish = resolve));
    const agent = { options, finish } as Agent;
    async function* gen() {
      for await (const _ of prompt as AsyncIterable<unknown>) {
        yield { type: 'system', subtype: 'init', session_id: `s${agents.length}`, model: 'm' };
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, result: await done };
      }
    }
    agents.push(agent);
    const it = gen() as any;
    it.interrupt = async () => {};
    return it;
  }) as unknown as QueryFn;
  const db = openDb(':memory:');
  new MyRepos(db).add('local', { name: 'acme/api', mainBranch: 'main' });
  const manager = new RunManager(fn);
  const starts: StartRequest[] = [];
  const orig = manager.start.bind(manager);
  manager.start = (r) => (starts.push(r), orig(r));
  const gitUrl = forge();
  const options = { db, workspaces: mkdtempSync(join(tmpdir(), 'lf-ws-')), selfUrl: 'http://localhost:4317', fetch: srv.fetchFn, gitUrl, pollWaitMs: 50, workflowDir: opts.workflowDir };
  const deps = buildDeps(manager, options);
  const app = createApp(manager, options, deps);
  const req = (p: string, init: RequestInit = {}) => app.request(`http://localhost:4317${p}`, { ...init, headers: { host: 'localhost:4317', ...(init.headers as any) } });
  const send = (method: string) => (p: string, body: unknown = {}) => req(p, { method, body: JSON.stringify(body), headers: { 'x-legos': '1', 'content-type': 'application/json' } });
  const post = send('POST');
  const put = send('PUT');
  return {
    jira,
    prs,
    gitUrl,
    deps,
    starts,
    agents,
    manager,
    req,
    post,
    put,
    async ready() {
      await post('/api/connections', { name: 'workbench', kind: 'workbench', url: WB, auth: 'oauth' });
      const authorize = new URL((await (await post('/api/connections/workbench/connect')).json()).url);
      srv.setChallenge(authorize.searchParams.get('code_challenge')!);
      await req(`/auth/callback?code=abc&state=${authorize.searchParams.get('state')}`);
      await put('/api/work-items/PROJ-1', { repos: ['acme/api'] });
    },
    stage: async () => ((await (await req('/api/work-items')).json()).items[0].stages[0] ?? null) as any,
    // the n-th run of the stage engine starts; the test does what an agent would, then finishes it
    async run(n: number, o: { branch?: string; result: string }) {
      await until(() => agents.length > n && starts.length > n, `run ${n} started`);
      const cwd = starts[n].cwd;
      if (o.branch) {
        git(cwd, 'checkout', '-qb', o.branch);
        git(cwd, 'push', '-q', 'origin', o.branch);
      }
      agents[n].finish(o.result);
      await until(() => manager.get(starts[n].id!)?.endedAt != null, `run ${n} ended`);
    },
    openPr(id: number, source: string, state = 'OPEN') {
      prs.set(`acme/api#${id}`, { id, title: `feat: PROJ-1 part ${id}`, state, source, destination: 'main', url: `https://forge/pr/${id}` });
    },
    sync: () => syncWorkItem(deps, 'local', 'PROJ-1'),
  };
}

const saved = { ...process.env };
beforeAll(() => {
  process.env.LEGOS_SETTINGS = join(import.meta.dirname, 'fixtures/settings/app.json');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});
afterAll(() => {
  process.env = saved;
});

const startBuild = (s: ReturnType<typeof setup>) => s.post('/api/work-items/PROJ-1/repos/acme/api/start-build', {});

describe('the factory workflow', () => {
  it('walks design, gate, build, inspect and catalog, opening each gate only on facts', async () => {
    const s = setup();
    await s.ready();
    const design = await (await s.post('/api/runs', { repo: 'acme/api', ticket: 'PROJ-1', stage: 'design', kind: 'task', prompt: 'Work on PROJ-1' })).json();
    expect(design).toMatchObject({ stage: 'design', kind: 'task' });
    expect(await s.stage()).toMatchObject({ stage: 'design', phase: 'run' });

    // the agent says everything is merged and approved: none of that counts
    s.openPr(1, 'feat/PROJ-1');
    await s.run(0, { branch: 'feat/PROJ-1', result: 'Spec PR merged, gate passed, build approved.' });
    await until(() => s.deps.stages.get('local', 'PROJ-1', 'acme/api')?.phase === 'gate', 'waiting on the spec PR');
    expect(await s.stage()).toMatchObject({ stage: 'design', phase: 'gate', prId: 1, missing: ['pr.merged'] });
    expect((await startBuild(s)).status).toBe(409);
    expect((await s.post('/api/runs', { repo: 'acme/api', ticket: 'PROJ-1', stage: 'build', prompt: 'x' })).status).toBe(409);
    expect(s.starts).toHaveLength(1);

    // the forge says it merged: Build unlocks, and still waits for the button
    s.prs.get('acme/api#1')!.state = 'MERGED';
    await s.sync();
    await until(() => s.deps.stages.get('local', 'PROJ-1', 'acme/api')?.phase === 'ready', 'build unlocked');
    expect(await s.stage()).toMatchObject({ stage: 'build', phase: 'ready' });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.starts).toHaveLength(1);

    const build = await startBuild(s);
    expect(build.status).toBe(201);
    expect(await build.json()).toMatchObject({ stage: 'build', kind: 'task' });
    expect(s.deps.stages.has('local', 'PROJ-1', 'acme/api', 'human.approved', 1)).toBe(true);
    expect(s.starts[1].prompt).toMatch(/Builder/);
    s.openPr(2, 'feat/PROJ-1-build');
    await s.run(1, { branch: 'feat/PROJ-1-build', result: 'built' });

    // opening the build PR starts the read-only review of that branch
    await until(() => s.starts.length === 3, 'inspect started');
    expect(s.starts[2]).toMatchObject({ stage: 'inspect', readOnly: true });
    expect(s.starts[2].prompt).toMatch(/Inspector/);
    expect(git(s.starts[2].cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).not.toBe('main');
    await s.run(2, { result: 'No blockers.\nVerdict: APPROVE' });
    await until(() => s.deps.stages.get('local', 'PROJ-1', 'acme/api')?.phase === 'gate', 'waiting on the build PR');

    // the reviewer's approval is not a person's: the gate still wants checks and a human
    expect(await s.stage()).toMatchObject({ stage: 'build', phase: 'gate', prId: 2, missing: ['ci.passed', 'human.approved'] });
    expect((await s.post('/api/work-items/PROJ-1/repos/acme/api/approve', {})).status).toBe(200);
    expect(await s.stage()).toMatchObject({ missing: ['ci.passed'] });
    s.deps.stages.observe('local', 'PROJ-1', { repo: 'acme/api', prId: 2 }, { state: 'OPEN', ci: 'passed' });
    expect(await s.stage()).toMatchObject({ missing: [] });

    // merging starts Catalog, and Jira has followed the whole way
    s.prs.get('acme/api#2')!.state = 'MERGED';
    await s.sync();
    await until(() => s.starts.length === 4, 'catalog started');
    expect(s.starts[3]).toMatchObject({ stage: 'catalog' });
    await s.run(3, { result: 'cataloged' });
    await until(() => s.deps.stages.get('local', 'PROJ-1', 'acme/api')?.phase === 'done', 'done');
    await s.sync();
    expect(s.jira.status).toBe('Ready for QA');
  });

  it('sends a rejected review back to Build at most three times, then leaves it to a person', async () => {
    const s = setup();
    await s.ready();
    s.deps.stages.put('local', 'PROJ-1', 'acme/api', { stage: 'build', phase: 'ready', loops: 0, prId: 1, note: null, owner: 'local' });
    s.openPr(2, 'feat/PROJ-1-build');
    expect((await startBuild(s)).status).toBe(201);
    await s.run(0, { branch: 'feat/PROJ-1-build', result: 'built' });

    for (let round = 0; round < MAX_REVIEW_LOOPS; round++) {
      const inspect = 1 + round * 2;
      await until(() => s.starts.length === inspect + 1, `review ${round + 1} started`);
      expect(s.starts[inspect].stage).toBe('inspect');
      await s.run(inspect, { result: `BLOCKER: tests missing (round ${round + 1}).\nVerdict: REQUEST_CHANGES` });
      await until(() => s.starts.length === inspect + 2, `fix ${round + 1} started`);
      expect(s.starts[inspect + 1]).toMatchObject({ stage: 'build' });
      expect(s.starts[inspect + 1].prompt).toMatch(new RegExp(`tests missing \\(round ${round + 1}\\)`));
      expect(s.deps.stages.get('local', 'PROJ-1', 'acme/api')!.loops).toBe(round + 1);
      await s.run(inspect + 1, { result: 'fixed' });
    }
    const last = 1 + MAX_REVIEW_LOOPS * 2;
    await until(() => s.starts.length === last + 1, 'final review started');
    await s.run(last, { result: 'Still wrong.\nVerdict: REQUEST_CHANGES' });
    await until(() => s.deps.stages.get('local', 'PROJ-1', 'acme/api')?.phase === 'escalated', 'escalated');
    expect(await s.stage()).toMatchObject({ stage: 'inspect', phase: 'escalated', loops: MAX_REVIEW_LOOPS, note: expect.stringMatching(/3 rounds/) });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.starts).toHaveLength(last + 1);
  });

  it('resumes an escalated build on its pull request branch with the findings, and approves nothing', async () => {
    const s = setup();
    await s.ready();
    const seed = mkdtempSync(join(tmpdir(), 'lf-seed-'));
    git(seed, 'clone', '-q', s.gitUrl.replace('{workspace}', 'acme').replace('{slug}', 'api'), 'work');
    git(join(seed, 'work'), 'checkout', '-qb', 'feat/PROJ-1-build');
    git(join(seed, 'work'), 'push', '-q', 'origin', 'feat/PROJ-1-build');
    s.deps.workItems.link('local', 'PROJ-1', { repo: 'acme/api', kind: 'impl', prId: 2, branch: 'feat/PROJ-1-build', title: 't', state: 'OPEN', runId: null });
    s.deps.stages.put('local', 'PROJ-1', 'acme/api', { stage: 'build', phase: 'escalated', loops: 1, prId: 2, note: 'could not start build: busy', owner: 'local' });
    expect((await startBuild(s)).status).toBe(201);
    await until(() => s.starts.length === 1, 'build started');
    expect(git(s.starts[0].cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/PROJ-1-build');
    expect(s.starts[0].prompt).toMatch(/could not start build: busy/);
    expect(s.starts[0].prompt).toMatch(/Never force-push and never open a new pull request/);
    expect(s.deps.stages.has('local', 'PROJ-1', 'acme/api', 'human.approved', 2)).toBe(false);
    expect(s.deps.stages.get('local', 'PROJ-1', 'acme/api')).toMatchObject({ phase: 'run', loops: 1 });
  });

  it('stops for a person when a review has no verdict or a run fails', async () => {
    const s = setup();
    await s.ready();
    s.deps.stages.put('local', 'PROJ-1', 'acme/api', { stage: 'build', phase: 'ready', loops: 0, prId: 1, note: null, owner: 'local' });
    s.openPr(2, 'feat/PROJ-1-build');
    await startBuild(s);
    await s.run(0, { branch: 'feat/PROJ-1-build', result: 'built' });
    await until(() => s.starts.length === 2, 'inspect started');
    await s.run(1, { result: 'Looks fine to me.' });
    await until(() => s.deps.stages.get('local', 'PROJ-1', 'acme/api')?.phase === 'escalated', 'escalated');
    expect((await s.stage()).note).toMatch(/without a verdict/);
    expect(s.starts).toHaveLength(2);
  });

  it('escalates a design run that ends without a PR, and lets a new design run start over', async () => {
    const s = setup();
    await s.ready();
    await s.post('/api/runs', { repo: 'acme/api', ticket: 'PROJ-1', stage: 'design', kind: 'task', prompt: 'go' });
    await s.run(0, { result: 'I could not do it' });
    await until(() => s.deps.stages.get('local', 'PROJ-1', 'acme/api')?.phase === 'escalated', 'escalated');
    expect((await s.stage()).note).toMatch(/without opening a pull request/);
    await s.post('/api/runs', { repo: 'acme/api', ticket: 'PROJ-1', stage: 'design', kind: 'task', prompt: 'again' });
    expect(await s.stage()).toMatchObject({ stage: 'design', phase: 'run', note: null });
  });

  it('knows where a work item stands from PRs linked by hand', async () => {
    const s = setup();
    await s.ready();
    s.deps.workItems.link('local', 'PROJ-1', { repo: 'acme/api', kind: 'spec', prId: 5, branch: 'b', title: 't', state: 'OPEN', runId: null });
    expect(current(s.deps, 'local', 'PROJ-1', 'acme/api')).toMatchObject({ stage: 'design', phase: 'gate', prId: 5 });
    s.deps.stages.record('local', 'PROJ-1', 'acme/api', 'pr.merged', 5, null);
    expect(current(s.deps, 'local', 'PROJ-1', 'acme/api')).toMatchObject({ stage: 'build', phase: 'ready' });
    expect((await startBuild(s)).status).toBe(201);
  });

  it('refuses stage buttons for repos outside the work item', async () => {
    const s = setup();
    await s.ready();
    const res = await s.post('/api/work-items/PROJ-1/repos/acme/web/start-build', {});
    expect(res.status).toBe(403);
    expect((await s.post('/api/work-items/PROJ-1/repos/acme/api/approve', {})).status).toBe(409);
  });
});

describe('the manifest', () => {
  it('reads the shipped workflow', () => {
    const wf = loadWorkflow();
    expect(wf.stages.map((st) => st.id)).toEqual(['design', 'build', 'inspect', 'catalog']);
    expect(wf.stages.map((st) => [st.id, st.manual, st.gate, st.onPrOpen, st.after, st.readOnly])).toEqual([
      ['design', false, ['pr.merged'], null, null, false],
      ['build', true, ['ci.passed', 'human.approved'], 'inspect', null, false],
      ['inspect', false, [], null, null, true],
      ['catalog', false, [], null, 'pr.merged', false],
    ]);
  });

  it('rejects unknown stages and facts, so a typo cannot open a gate', () => {
    expect(() => parseWorkflow('stages: [{ id: deploy, persona: p.md }]', '.')).toThrow(/unknown stage/);
    expect(() => parseWorkflow('stages: [{ id: design, persona: p.md, gate: [agent.said.so] }]', '.')).toThrow(/unknown fact/);
    expect(() => parseWorkflow('stages: [{ id: design }]', '.')).toThrow(/persona/);
    expect(() => parseWorkflow('stages: []', '.')).toThrow(/at least one/);
  });

  it('drives the engine: a workflow whose build is not manual starts it by itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-wf-'));
    cpSync(workflowDir(), dir, { recursive: true });
    writeFileSync(join(dir, 'factory.yaml'), readFileSync(join(dir, 'factory.yaml'), 'utf8').replace('    start: manual', '    start: auto'));
    const s = setup({ workflowDir: dir });
    await s.ready();
    s.deps.stages.put('local', 'PROJ-1', 'acme/api', { stage: 'design', phase: 'gate', loops: 0, prId: 1, note: null, owner: 'local' });
    s.deps.stages.observe('local', 'PROJ-1', { repo: 'acme/api', prId: 1 }, { state: 'MERGED' });
    await until(() => s.starts.length === 1 && s.starts[0].stage === 'build', 'build started without a button');
  });
});

describe('verdicts', () => {
  it('reads the last Verdict line, however it is dressed', () => {
    expect(parseVerdict('x\nVerdict: APPROVE')).toBe('approve');
    expect(parseVerdict('**Verdict:** REQUEST_CHANGES\n')).toBe('request_changes');
    expect(parseVerdict('Verdict: APPROVE\nthen on reflection\nVerdict: abstain')).toBe('abstain');
    expect(parseVerdict('> verdict : approve')).toBe('approve');
    expect(parseVerdict('The verdict is that it is fine')).toBeNull();
    expect(parseVerdict(null)).toBeNull();
  });
});
