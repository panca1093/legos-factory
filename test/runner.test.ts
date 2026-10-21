import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDeps, createApp } from '../server/app.ts';
import { RunManager, type QueryFn } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import { Dispatcher, EMBEDDED, type RunnerRef } from '../server/dispatcher.ts';
import { MyRepos } from '../server/my-repos.ts';
import type { JobRequest } from '../server/protocol.ts';
import { Runner, httpTransport } from '../server/runner.ts';
import { workspacePath } from '../server/workspace.ts';
import { alive } from './fakes.ts';

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

const until = async (cond: () => boolean, what = 'condition') => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond(), what).toBe(true);
};

function queue(opts: { leaseMs?: number; maxAttempts?: number } = {}) {
  let now = 1_000_000;
  const d = new Dispatcher(openDb(':memory:'), { leaseMs: opts.leaseMs ?? 1000, maxAttempts: opts.maxAttempts ?? 2, now: () => now });
  const add = (runId: string, over: { priority?: number; local?: boolean; workspaceId?: string } = {}) =>
    d.enqueue({ runId, workspaceId: over.workspaceId ?? 'w1', priority: over.priority, local: over.local ?? false, request: { id: runId, cwd: '/tmp', prompt: runId } as JobRequest });
  return { d, add, tick: (ms: number) => (now += ms) };
}
const remote: RunnerRef = { id: 'r1', workspaceId: 'w1', embedded: false };
const ids = (jobs: { runId: string }[]) => jobs.map((j) => j.runId);

describe('dispatcher', () => {
  it('hands out the highest priority first, then first come first served', () => {
    const { d, add } = queue();
    add('a');
    add('b', { priority: 5 });
    add('c');
    add('d', { priority: 5 });
    expect(ids(d.claim(remote, 10))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('never gives a runner more than its capacity', () => {
    const { d, add } = queue();
    for (const id of ['a', 'b', 'c']) add(id);
    expect(ids(d.claim(remote, 2))).toEqual(['a', 'b']);
    expect(d.claim(remote, 2)).toEqual([]);
    d.finish('a');
    expect(ids(d.claim(remote, 2))).toEqual(['c']);
    expect(ids(d.claim({ ...remote, id: 'r2' }, 2))).toEqual([]);
  });

  it('keeps a lease alive with heartbeats and reports the jobs a runner no longer holds', () => {
    const { d, add, tick } = queue();
    add('a');
    d.claim(remote, 1);
    tick(800);
    expect(d.heartbeat('r1', ['a'])).toEqual([]);
    tick(800);
    expect(d.expire()).toEqual({ requeued: [], failed: [] });
    expect(d.heartbeat('r2', ['a'])).toEqual(['a']);
    expect(d.heartbeat('r1', ['nope'])).toEqual(['nope']);
  });

  it('returns a job whose lease ran out to the queue, ahead of newer ones, and fails it after too many claims', () => {
    const { d, add, tick } = queue({ maxAttempts: 2 });
    add('a');
    d.claim(remote, 1);
    add('b');
    tick(1500);
    expect(ids(d.expire().requeued)).toEqual(['a']);
    expect(ids(d.claim(remote, 1))).toEqual(['a']);
    tick(1500);
    const { requeued, failed } = d.expire();
    expect(requeued).toEqual([]);
    expect(failed).toEqual([expect.objectContaining({ runId: 'a', attempts: 2 })]);
    expect(ids(d.claim(remote, 5))).toEqual(['b']);
  });

  it("lets a late runner's report be refused once its job moved on", () => {
    const { d, add, tick } = queue();
    add('a');
    d.claim(remote, 1);
    tick(1500);
    d.expire();
    d.claim({ ...remote, id: 'r2' }, 1);
    expect(d.holds('r1', 'a')).toBe(false);
    expect(d.holds('r2', 'a')).toBe(true);
  });

  it('keeps folder jobs on the embedded runner and workspace jobs on their workspace', () => {
    const { d, add } = queue();
    add('folder', { local: true });
    add('mine');
    add('theirs', { workspaceId: 'w2' });
    expect(ids(d.claim(remote, 5))).toEqual(['mine']);
    expect(ids(d.claim({ id: EMBEDDED, workspaceId: null, embedded: true }, 5))).toEqual(['folder', 'theirs']);
  });

  it('frees every lease of a runner at once', () => {
    const { d, add } = queue();
    add('a');
    add('b');
    d.claim(remote, 2);
    expect(ids(d.expire('r1').requeued)).toEqual(['a', 'b']);
    expect(ids(d.claim({ ...remote, id: 'r2' }, 2))).toEqual(['a', 'b']);
  });
});

// a chat that works until told to stop, like a real session; `idle` picks the prompts whose turn finishes instead
function agent(opts: { idle?: (prompt: string) => boolean } = {}) {
  const starts: any[] = [];
  const fn = (({ prompt, options }: any) => {
    starts.push(options);
    async function* gen() {
      for await (const m of prompt as AsyncIterable<any>) {
        yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5-5' };
        if (opts.idle?.(m.message.content)) yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, result: `done ${m.message.content}` };
        else await new Promise(() => {});
      }
    }
    const it = gen() as any;
    it.interrupt = async () => {};
    return it;
  }) as unknown as QueryFn;
  return { fn, starts };
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown = {}) =>
  app.request(`http://localhost:4317${path}`, { method: 'POST', body: JSON.stringify(body), headers: { host: 'localhost:4317', 'x-legos': '1', 'content-type': 'application/json' } });

describe('restart', () => {
  const boot = (path: string, a: ReturnType<typeof agent>, extra: object = {}) => {
    const manager = new RunManager(a.fn);
    const opts = { db: openDb(path), pollWaitMs: 50, ...extra };
    const deps = buildDeps(manager, opts);
    return { manager, deps, app: createApp(manager, opts, deps) };
  };
  const dbPath = () => join(mkdtempSync(join(tmpdir(), 'lf-restart-')), 'factory.db');

  it('resumes the Claude session of a run that was working when the server stopped', async () => {
    const path = dbPath();
    const first = boot(path, agent());
    const run = await (await post(first.app, '/api/runs', { cwd: '/tmp', prompt: 'build it', kind: 'task' })).json();
    await until(() => first.deps.runs.get(run.id)?.sessionId === 'sess-1');
    await until(() => first.deps.activity.get(run.id)?.sessionId === 'sess-1');

    const a = agent();
    const second = boot(path, a);
    await until(() => a.starts.length === 1, 'the run is started again');
    expect(a.starts[0]).toMatchObject({ resume: 'sess-1' });
    const again = second.deps.runs.get(run.id)!;
    expect(again.prompt).toBe('build it');
    expect(['queued', 'starting', 'running']).toContain(again.status);
    expect(second.deps.activity.get(run.id)!.status).not.toBe('failed');
    expect((await second.app.request(`http://localhost:4317/api/runs/${run.id}`, { headers: { host: 'localhost:4317' } })).status).toBe(200);
  });

  it('lets go of a chat that was only waiting for you, and fails a run that cannot resume', async () => {
    const path = dbPath();
    const first = boot(path, agent({ idle: (p) => p === 'hi' }));
    const chat = await (await post(first.app, '/api/runs', { cwd: '/tmp', prompt: 'hi' })).json();
    await until(() => first.deps.activity.get(chat.id)?.status === 'idle');
    const loose = first.deps.startRun({ cwd: '/tmp', prompt: 'ask', kind: 'task', recoverable: false });
    await until(() => first.deps.activity.get(loose.id)?.sessionId === 'sess-1');

    const a = agent();
    const second = boot(path, a);
    expect(second.deps.runs.get(chat.id)).toMatchObject({ status: 'completed' });
    expect(second.deps.runs.get(loose.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/restart/) });
    await until(() => second.deps.activity.get(chat.id)?.status === 'completed');
    expect(a.starts).toEqual([]);
  });

  it('fails a run that keeps losing its runner, after the attempts it is allowed', async () => {
    const path = dbPath();
    const first = boot(path, agent(), { maxAttempts: 1 });
    const run = await (await post(first.app, '/api/runs', { cwd: '/tmp', prompt: 'x', kind: 'task' })).json();
    await until(() => first.deps.runs.get(run.id)?.sessionId === 'sess-1');
    const second = boot(path, agent(), { maxAttempts: 1 });
    expect(second.deps.runs.get(run.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/1 attempts/) });
  });

  it('replays the end of a run whose stage handling was cut off by a crash, so its stage is not stuck in run', async () => {
    const path = dbPath();
    const first = boot(path, agent({ idle: (p) => p === 'go' }));
    first.deps.stages.put('local', 'PROJ-1', 'acme/api', { stage: 'design', phase: 'run', loops: 0, prId: null, note: null, owner: 'local' });
    first.deps.runs.removeAllListeners('finished');
    const run = first.deps.startRun({ workspaceId: 'local', owner: 'local', repo: 'acme/api', cwd: '/tmp', kind: 'task', prompt: 'go', ticket: 'PROJ-1', stage: 'design' });
    await until(() => first.deps.activity.get(run.id)?.endedAt != null, 'the run ended');
    expect(first.deps.stages.get('local', 'PROJ-1', 'acme/api')!.phase).toBe('run');

    const second = boot(path, agent());
    await until(() => second.deps.stages.get('local', 'PROJ-1', 'acme/api')!.phase === 'escalated', 'the stage heard about the end');
    await until(() => second.deps.runs.openJobs().length === 0, 'the job is done');
    expect(second.deps.runs.get(run.id)).toMatchObject({ status: 'completed', endedAt: expect.any(String) });
  });

  it('marks runs from before the dispatcher existed as failed', async () => {
    const path = dbPath();
    const db = openDb(path);
    db.prepare(`insert into runs (run_id, workspace_id, session_id, item, started_at, last_event_at) values ('old', 'local', null, ?, 'x', 'x')`).run(JSON.stringify({ runId: 'old', status: 'running' }));
    const { deps } = boot(path, agent());
    expect(deps.activity.get('old')!.status).toBe('failed');
  });
});

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
  git(root, 'clone', '-q', '--bare', src, join(root, 'acme', 'api.git'));
  return `file://${root}/{workspace}/{slug}.git`;
}

describe('embedded runner', () => {
  it('relays a permission request to the control plane and the answer back', async () => {
    let answer: any;
    const fn = (({ prompt, options }: any) => {
      async function* gen() {
        for await (const _ of prompt as AsyncIterable<any>) {
          yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm' };
          answer = await options.canUseTool('Bash', { command: 'ls' }, { signal: options.abortController.signal, toolUseID: 't1', requestId: 'r1' });
          yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, result: 'ok' };
        }
      }
      const it = gen() as any;
      it.interrupt = async () => {};
      return it;
    }) as unknown as QueryFn;
    const manager = new RunManager(fn);
    const opts = { db: openDb(':memory:'), pollWaitMs: 50 };
    const deps = buildDeps(manager, opts);
    const app = createApp(manager, opts, deps);
    const run = await (await post(app, '/api/runs', { cwd: '/tmp', prompt: 'go', kind: 'task' })).json();

    const open = () => (deps.runs.snapshot() as { decisions: { id: string }[] }).decisions;
    await until(() => open().length === 1, 'the request reached the control plane');
    expect(deps.runs.get(run.id)!.status).toBe('awaiting_decision');
    expect((await post(app, `/api/decisions/${open()[0].id}`, { behavior: 'allow' })).status).toBe(200);
    await until(() => deps.runs.get(run.id)!.status === 'completed', 'the run went on');
    expect(answer).toMatchObject({ behavior: 'allow' });
    expect(open()).toEqual([]);
    expect(deps.runs.get(run.id)!.result).toBe('ok');
  });
});

describe('remote runner', () => {
  const PUBLIC = 'https://factory.example.com';
  function hub() {
    const db = openDb(':memory:');
    new MyRepos(db).add('local', { name: 'acme/api', mainBranch: 'main' });
    const opts = { db, embeddedRunner: false, publicUrl: PUBLIC, pollWaitMs: 50, workspaces: mkdtempSync(join(tmpdir(), 'lf-hub-ws-')) };
    const deps = buildDeps(new RunManager(alive), opts);
    const app = createApp(new RunManager(alive), opts, deps);
    const call = (path: string, init: RequestInit = {}) => app.request(`${PUBLIC}${path}`, { ...init, headers: { host: 'factory.example.com', ...(init.headers as object) } });
    const api = (method: string, path: string, body: unknown = {}) =>
      call(path, { method, ...(method !== 'GET' && method !== 'DELETE' && { body: JSON.stringify(body) }), headers: { 'x-legos': '1', 'content-type': 'application/json' } });
    return { deps, call, api, fetchFn: ((url: string, init: RequestInit) => call(String(url).slice(PUBLIC.length), init)) as unknown as typeof fetch };
  }

  it('lets a report move a run along but never change whose run it is, where, or for which ticket', async () => {
    const h = hub();
    const run = await (await h.api('POST', '/api/runs', { repo: 'acme/api', prompt: 'hello' })).json();
    const runner = { id: 'r1', workspaceId: 'local', embedded: false };
    await h.deps.runs.poll(runner, { capacity: 1, running: [] });
    h.deps.runs.report(runner, [{ type: 'run', run: { ...run, repo: 'evil/x', ticket: 'EVIL-1', stage: 'build', cwd: '/', workspaceId: 'other', owner: 'mallory', prompt: 'forged', status: 'running', turns: 3 } }]);
    expect(h.deps.runs.get(run.id)).toMatchObject({ repo: 'acme/api', ticket: null, stage: null, cwd: '', workspaceId: 'local', owner: 'local', prompt: 'hello', status: 'running', turns: 3 });
  });

  it('pulls a repo run over HTTP, clones it itself, takes commands and reports back', async () => {
    const h = hub();
    const run = await (await h.api('POST', '/api/runs', { repo: 'acme/api', prompt: 'hello' })).json();
    expect(run).toMatchObject({ status: 'queued', repo: 'acme/api' });

    const { token } = await (await h.api('POST', '/api/runners', { name: 'laptop' })).json();
    const manager = new RunManager(alive);
    const wsRoot = mkdtempSync(join(tmpdir(), 'lf-runner-ws-'));
    const runner = new Runner({
      transport: httpTransport(PUBLIC, token, h.fetchFn),
      manager,
      wsRoot,
      gitUrl: forge(),
      credential: async () => {
        throw new Error('not needed for a plain clone');
      },
      retryMs: 20,
    });
    runner.start();

    await until(() => h.deps.runs.get(run.id)?.status === 'starting', 'the runner picked the run up');
    const clone = workspacePath(wsRoot, 'local', { workspace: 'acme', slug: 'api' }, h.deps.runs.openJobs()[0].request.clone!.key);
    expect(h.deps.runs.get(run.id)!.cwd).toBe('');
    expect(existsSync(join(clone, 'README.md'))).toBe(true);

    expect((await h.api('POST', `/api/runs/${run.id}/messages`, { text: 'more' })).status).toBe(200);
    await until(() => h.deps.runs.get(run.id)!.events.some((e) => e.kind === 'user' && e.text === 'more'), 'the message reached the agent');

    expect((await h.api('POST', `/api/runs/${run.id}/end`)).status).toBe(200);
    await until(() => h.deps.runs.get(run.id)!.status === 'completed', 'the run ended');
    await until(() => !existsSync(clone), 'the runner deleted its clone');
    await until(() => h.deps.runs.openJobs().length === 0, 'the job is done');
    runner.stop();
  });

  it('fails a run whose clone the runner cannot make, and tells the control plane the run is over', async () => {
    const h = hub();
    const run = await (await h.api('POST', '/api/runs', { repo: 'acme/api', prompt: 'hello' })).json();
    const finished: string[] = [];
    h.deps.runs.on('finished', (r: { id: string }) => finished.push(r.id));
    const { token } = await (await h.api('POST', '/api/runners', { name: 'laptop' })).json();
    const runner = new Runner({
      transport: httpTransport(PUBLIC, token, h.fetchFn),
      manager: new RunManager(alive),
      wsRoot: mkdtempSync(join(tmpdir(), 'lf-runner-ws-')),
      gitUrl: 'file:///nowhere/{workspace}/{slug}.git',
      credential: async () => 'unused',
      retryMs: 20,
    });
    runner.start();
    await until(() => h.deps.runs.get(run.id)?.status === 'failed', 'the run failed');
    expect(h.deps.runs.get(run.id)!.error).toMatch(/could not clone/);
    expect(finished).toEqual([run.id]);
    expect(h.deps.runs.openJobs()).toEqual([]);
    runner.stop();
  });

  it('turns away unknown tokens and gives a runner only its own workspace', async () => {
    const h = hub();
    const poll = (token: string) => h.call('/runner/poll', { method: 'POST', body: JSON.stringify({ capacity: 1, running: [] }), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    expect((await poll('lfr_nope')).status).toBe(401);
    expect((await h.call('/runner/poll', { method: 'POST', body: '{}', headers: { host: 'evil.example.com' } })).status).toBe(403);
    expect((await h.call('/runner/poll', { method: 'POST', body: '{}' })).status).toBe(401);
    const made = await (await h.api('POST', '/api/runners', { name: 'a' })).json();
    expect(made.token).toMatch(/^lfr_/);
    expect(JSON.stringify(await (await h.api('GET', '/api/runners')).json())).not.toContain(made.token);
    expect(await (await poll(made.token)).json()).toEqual({ jobs: [], commands: [], lost: [] });
    expect((await h.api('DELETE', `/api/runners/${made.id}`)).status).toBe(200);
    expect((await poll(made.token)).status).toBe(401);
  });

  it('refuses Ask factory, which works in a checkout on the control plane', async () => {
    const h = hub();
    const res = await h.api('POST', '/api/prs/acme/api/7/fixes', { commentIds: [1] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/runner inside this app/);
  });

  it('refuses a folder run when no runner of its own can see the folder', async () => {
    const h = hub();
    const res = await h.api('POST', '/api/runs', { cwd: '/tmp', prompt: 'hi' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/repo/);
  });

  it('hands a revoked runner’s jobs back to the queue', async () => {
    const h = hub();
    const run = await (await h.api('POST', '/api/runs', { repo: 'acme/api', prompt: 'hello' })).json();
    const made = await (await h.api('POST', '/api/runners', { name: 'a' })).json();
    const res = await h.call('/runner/poll', { method: 'POST', body: JSON.stringify({ capacity: 1, running: [] }), headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' } });
    const { jobs } = await res.json();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].request.env).toMatchObject({ LEGOS_URL: PUBLIC });
    expect(jobs[0].request.env.LEGOS_RUN_SECRET).toBeTruthy();
    await h.api('DELETE', `/api/runners/${made.id}`);
    expect(h.deps.runs.openJobs()).toEqual([expect.objectContaining({ runId: run.id, state: 'queued' })]);
  });
});
