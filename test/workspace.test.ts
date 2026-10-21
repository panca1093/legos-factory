import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDeps, createApp, sweepOrphans } from '../server/app.ts';
import { embeddedByDefault } from '../server/http.ts';
import { RunManager, type QueryFn } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import { MyRepos } from '../server/my-repos.ts';
import { WorkItems } from '../server/work-items.ts';
import { managedWorkspace, parseRepo, sweepWorkspaces, workspacePath } from '../server/workspace.ts';
import { useEnv } from './fakes.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

// A local "forge": <root>/acme/app.git with main and a feature branch.
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
  git(src, 'checkout', '-qb', 'feat/PROJ-9');
  writeFileSync(join(src, 'README.md'), 'feature\n');
  git(src, 'commit', '-qam', 'feat');
  git(src, 'checkout', '-q', 'main');
  mkdirSync(join(root, 'acme'));
  git(root, 'clone', '-q', '--bare', src, join(root, 'acme', 'app.git'));
  return `file://${root}/{workspace}/{slug}.git`;
}

// Stays alive until its input closes and reports a session id, like a real chat.
let sessions = 0;
const alive = (({ prompt }: any) => {
  const id = `sess-${++sessions}`;
  const it = (async function* () {
    yield { type: 'system', subtype: 'init', session_id: id, model: 'm' };
    for await (const _ of prompt as AsyncIterable<unknown>);
  })() as any;
  it.interrupt = async () => {};
  return it;
}) as unknown as QueryFn;

function setup() {
  const workspaces = mkdtempSync(join(tmpdir(), 'lf-ws-'));
  const runs = new RunManager(alive);
  const db = openDb(':memory:');
  const myRepos = new MyRepos(db);
  for (const name of ['acme/app', 'acme/nope']) myRepos.add('local', { name, mainBranch: 'main' });
  const app = createApp(runs, { db, workspaces, gitUrl: forge() });
  const post = (body: object) =>
    app.request('http://localhost:4317/api/runs', { method: 'POST', headers: { host: 'localhost:4317', 'x-legos': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { runs, workspaces, post, myRepos, db };
}

const settle = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

useEnv({ LEGOS_SETTINGS: join(import.meta.dirname, 'fixtures/settings/app.json') });

describe('repo workspaces', () => {
  it('parses repo refs and recognises only its own paths', () => {
    expect(parseRepo('acme/app')).toEqual({ workspace: 'acme', slug: 'app' });
    for (const bad of ['acme', 'acme/app/x', '../app', 'acme/..', 'ac me/app', '']) expect(parseRepo(bad)).toBeNull();
    expect(managedWorkspace('/ws', '/ws/u1/acme/app/PROJ-1')).toEqual({ workspaceId: 'u1', repo: { workspace: 'acme', slug: 'app' }, key: 'PROJ-1' });
    expect(managedWorkspace('/ws', '/ws/u1/acme/app')).toBeNull();
    expect(managedWorkspace('/ws', '/elsewhere/u1/acme/app/PROJ-1')).toBeNull();
  });

  it('clones a fresh checkout per ticket, refuses a second run there, and deletes it when the run ends', async () => {
    const { runs, workspaces, post, db } = setup();
    const items = new WorkItems(db);
    items.create('local', 'PROJ-1');
    items.addRepo('local', 'PROJ-1', 'acme/app');
    const res = await post({ repo: 'acme/app', prompt: 'work on it', ticket: 'PROJ-1', stage: 'design' });
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run.cwd).toBe(join(workspaces, 'local', 'acme', 'app', 'PROJ-1'));
    expect(readFileSync(join(run.cwd, 'README.md'), 'utf8')).toBe('main\n');
    expect(git(run.cwd, 'rev-list', '--count', 'HEAD')).toBe('1'); // shallow

    const again = await post({ repo: 'acme/app', prompt: 'again', ticket: 'PROJ-1', stage: 'design' });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already working/);

    await runs.end(run.id);
    await settle(() => !existsSync(run.cwd));
  });

  it('clones the asked-for branch', async () => {
    const { runs, post } = setup();
    const run = await (await post({ repo: 'acme/app', branch: 'feat/PROJ-9', prompt: 'continue PROJ-9' })).json();
    expect(readFileSync(join(run.cwd, 'README.md'), 'utf8')).toBe('feature\n');
    await runs.end(run.id);
  });

  it('continuing a session re-clones into the same path', async () => {
    const { runs, post } = setup();
    const first = await (await post({ repo: 'acme/app', prompt: 'PROJ-2 brief' })).json();
    await settle(() => !!runs.get(first.id)?.sessionId);
    const session = runs.get(first.id)!.sessionId!;
    await runs.end(first.id);
    await settle(() => !existsSync(first.cwd));

    const again = await post({ cwd: first.cwd, resume: session, prompt: 'carry on' });
    expect(again.status).toBe(201);
    expect((await again.json()).cwd).toBe(first.cwd);
    expect(existsSync(join(first.cwd, 'README.md'))).toBe(true);
  });

  it('refuses a repo that is not in my repos, also when continuing after it was removed', async () => {
    const { runs, post, myRepos } = setup();
    const res = await post({ repo: 'acme/other', prompt: 'x' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'repo is not in your repos', needRepo: true });

    const first = await (await post({ repo: 'acme/app', prompt: 'PROJ-3 brief' })).json();
    await settle(() => !!runs.get(first.id)?.sessionId);
    const session = runs.get(first.id)!.sessionId!;
    await runs.end(first.id);
    await settle(() => !existsSync(first.cwd));
    myRepos.remove('local', 'ACME/app');
    const again = await post({ cwd: first.cwd, resume: session, prompt: 'carry on' });
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ needRepo: true });
  });

  it('rejects bad input, unknown repos and other users\' workspaces', async () => {
    const { workspaces, post } = setup();
    expect((await post({ repo: 'not-a-repo', prompt: 'x' })).status).toBe(400);
    expect((await post({ repo: 'acme/app', branch: '--upload-pack=evil', prompt: 'x' })).status).toBe(400);
    const missing = await post({ repo: 'acme/nope', prompt: 'x' });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/could not clone acme\/nope/);
    expect((await post({ cwd: join(workspaces, 'someone-else', 'acme', 'app', 'PROJ-1'), prompt: 'x' })).status).toBe(404);
    mkdirSync(join(workspaces, 'someone-else', 'acme', 'app', 'PROJ-1', 'src'), { recursive: true });
    for (const cwd of [join(workspaces, 'someone-else', 'acme', 'app', 'PROJ-1', 'src'), join(workspaces, 'local', 'acme')]) {
      mkdirSync(cwd, { recursive: true });
      expect((await post({ cwd, prompt: 'x' })).status).toBe(400);
    }
  });
});

describe('boot sweep', () => {
  const clone = (root: string, ...parts: string[]) => {
    const dir = join(root, ...parts);
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'legos-clone'), '');
    writeFileSync(join(dir, 'work.txt'), 'uncommitted');
    return dir;
  };

  it('keeps the clone of a resumable job and removes an orphan', async () => {
    const workspaces = mkdtempSync(join(tmpdir(), 'lf-sweep-'));
    const db = openDb(':memory:');
    new MyRepos(db).add('local', { name: 'acme/app', mainBranch: 'main' });
    const manager = new RunManager(alive);
    const deps = buildDeps(manager, { db, workspaces, embeddedRunner: false });
    const app = createApp(manager, { db, workspaces, embeddedRunner: false }, deps);
    const res = await app.request('http://localhost:4317/api/runs', {
      method: 'POST',
      headers: { host: 'localhost:4317', 'x-legos': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'acme/app', prompt: 'x' }),
    });
    expect(res.status).toBe(201);
    const job = deps.runs.openJobs()[0].request.clone!;
    const kept = clone(workspaces, 'local', 'acme', 'app', job.key);
    const orphan = clone(workspaces, 'local', 'acme', 'app', 'PROJ-2');
    sweepOrphans(deps);
    expect(existsSync(join(kept, 'work.txt'))).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  it('ignores unmarked directories and never follows symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-sweep-'));
    const unmarked = join(root, 'a', 'b', 'c', 'd');
    mkdirSync(unmarked, { recursive: true });
    writeFileSync(join(unmarked, 'mine.txt'), 'x');
    const outside = clone(mkdtempSync(join(tmpdir(), 'lf-outside-')), 'x');
    mkdirSync(join(root, 'a', 'b', 'link'), { recursive: true });
    symlinkSync(outside, join(root, 'a', 'b', 'link', 'd'));
    symlinkSync(outside, join(root, 'a', 'b', 'c2'));
    sweepWorkspaces(root, new Set());
    expect(existsSync(join(unmarked, 'mine.txt'))).toBe(true);
    expect(existsSync(join(outside, 'work.txt'))).toBe(true);
    expect(workspacePath(root, 'a', { workspace: 'b', slug: 'c' }, 'd')).toBe(unmarked);
  });

  it('does not run when the app is built, so a second process cannot delete live clones', () => {
    const workspaces = mkdtempSync(join(tmpdir(), 'lf-sweep-'));
    const live = clone(workspaces, 'local', 'acme', 'app', 'PROJ-1');
    buildDeps(new RunManager(alive), { db: openDb(':memory:'), workspaces });
    expect(existsSync(join(live, 'work.txt'))).toBe(true);
  });
});

describe('a control plane reached over the network', () => {
  const run = (bind: string | null, body: object) => {
    const manager = new RunManager(alive);
    const db = openDb(':memory:');
    new MyRepos(db).add('local', { name: 'acme/app', mainBranch: 'main' });
    const options = { db, workspaces: mkdtempSync(join(tmpdir(), 'lf-ws-')), gitUrl: forge(), bind };
    return createApp(manager, options).request('http://localhost:4317/api/runs', {
      method: 'POST',
      headers: { host: 'localhost:4317', 'x-legos': '1', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  it('refuses runs in local folders but still runs repos', async () => {
    const folder = { cwd: tmpdir(), prompt: 'x' };
    expect((await run('0.0.0.0', folder)).status).toBe(403);
    expect((await run('0.0.0.0', { repo: 'acme/app', prompt: 'x' })).status).toBe(201);
    expect((await run('127.0.0.1', folder)).status).toBe(201);
  });

  it('leaves execution to remote runners unless asked', () => {
    expect([embeddedByDefault(undefined, true), embeddedByDefault(undefined, false), embeddedByDefault('on', true), embeddedByDefault('off', false)]).toEqual([false, true, true, false]);
  });
});
