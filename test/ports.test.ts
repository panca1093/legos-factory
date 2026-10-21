import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDeps, createApp } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import { syncWorkItem } from '../server/jira-sync.ts';
import { MyRepos } from '../server/my-repos.ts';
import type { Forge, WorkSource } from '../server/ports.ts';
import { bitbucketForge } from '../server/providers/bitbucket-workbench.ts';
import { githubForge } from '../server/providers/github.ts';
import { jiraWorkSource } from '../server/providers/jira-workbench.ts';
import { Workbench } from '../server/workbench.ts';
import { WorkItems } from '../server/work-items.ts';
import { stageGuide } from '../server/workflow.ts';
import { alive, fakeServers, useEnv, WB } from './fakes.ts';

const repo = { workspace: 'acme', slug: 'api' };
const DIFF = 'diff --git a/a.txt b/a.txt\n+hello\n';

function bitbucket(): Forge {
  const srv = fakeServers({
    exec: (tool, args) => {
      switch (tool) {
        case 'bitbucket_list_repos':
          return { repos: [{ full_name: 'acme/api', mainbranch: 'main', updated_on: '2026-10-01', description: 'the api' }], hasMore: false };
        case 'bitbucket_list_prs':
          return { prs: args.state === 'OPEN' ? [{ id: 7, title: 'PROJ-1 export', state: 'OPEN', author: 'Ada', source: 'feat/PROJ-1', destination: 'main', updated_on: '2026-10-02' }] : [] };
        case 'bitbucket_get_pr':
          return { id: 7, title: 'PROJ-1 export', state: 'OPEN', author: 'Ada', source: 'feat/PROJ-1', destination: 'main', description: 'd', url: 'https://forge/pr/7', comment_count: 2, reviewers: [{ display_name: 'Bob', uuid: '{b}', approved: true }] };
        case 'bitbucket_get_pr_diff':
          return args.diffstat ? { files: [{ status: 'added', new: 'a.txt', lines_added: 1, lines_removed: 0 }] } : DIFF;
        case 'bitbucket_list_pr_comments':
          return { comments: [{ id: 2, author: 'Bob', text: 'why?', inline: { path: 'a.txt', line: 1 }, created_on: '2026-10-03' }, { id: 1, author: 'Ada', text: 'hi', created_on: '2026-10-02' }] };
        case 'bitbucket_add_pr_comment':
          return { id: 9 };
        case 'bitbucket_get_clone_url':
          return 'https://x-token-auth:tok123@bitbucket.org/acme/api.git';
        case 'bitbucket_search_users':
          return { users: [{ display_name: 'Bob', uuid: '{b}' }] };
        default:
          return {};
      }
    },
  });
  return bitbucketForge(new Workbench(`${WB}/mcp`, srv.fetchFn), 'tok');
}

function github(): Forge {
  const pr = { number: 7, title: 'PROJ-1 export', state: 'open', merged_at: null, user: { login: 'Ada' }, head: { ref: 'feat/PROJ-1', sha: 'abc' }, base: { ref: 'main' }, updated_at: '2026-10-02', created_at: '2026-10-01', body: 'd', html_url: 'https://forge/pr/7', comments: 1, review_comments: 1, requested_reviewers: [{ login: 'Bob', id: 5 }] };
  const http = (async (url: string, init: any) => {
    const path = new URL(url).pathname + new URL(url).search;
    const diff = init.headers.accept === 'application/vnd.github.diff';
    if (init.headers.authorization !== 'Bearer ghtok') return new Response('no', { status: 401 });
    if (path.startsWith('/users/acme/repos')) return Response.json([{ full_name: 'acme/api', default_branch: 'main', updated_at: '2026-10-01', description: 'the api' }]);
    if (path.startsWith('/repos/acme/api/pulls?')) return Response.json(path.includes('state=open') ? [pr] : []);
    if (path === '/repos/acme/api/pulls/7') return diff ? new Response(DIFF) : Response.json(pr);
    if (path === '/repos/acme/api/commits/abc/status') return Response.json({ state: 'success', total_count: 1 });
    if (path.startsWith('/repos/acme/api/pulls/7/files')) return Response.json([{ filename: 'a.txt', status: 'added', additions: 1, deletions: 0 }]);
    if (path.startsWith('/repos/acme/api/pulls/7/comments')) return Response.json([{ id: 2, user: { login: 'Bob' }, body: 'why?', path: 'a.txt', line: 1, created_at: '2026-10-03' }]);
    if (path.startsWith('/repos/acme/api/issues/7/comments')) return Response.json([{ id: 1, user: { login: 'Ada' }, body: 'hi', created_at: '2026-10-02' }]);
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return githubForge({ token: 'ghtok', http });
}

// What any Forge must do, however it talks to its product; `writes` says whether this one may change things.
function forgeContract(name: string, make: () => Forge, writes: boolean, ci: 'passed' | null) {
  describe(`forge contract: ${name}`, () => {
    it('lists repos and pull requests in the neutral shape', async () => {
      const forge = make();
      expect(await forge.listRepos('acme')).toEqual([{ name: 'acme/api', mainBranch: 'main', updated: '2026-10-01', description: 'the api' }]);
      expect(await forge.listPrs(repo, 'OPEN')).toEqual([{ repo: 'acme/api', id: 7, title: 'PROJ-1 export', state: 'OPEN', author: 'Ada', source: 'feat/PROJ-1', destination: 'main', updated: '2026-10-02' }]);
      expect(await forge.listPrs(repo, 'MERGED')).toEqual([]);
    });

    it('reads one pull request with its reviewers and check result', async () => {
      const pr = await make().getPr(repo, 7);
      expect(pr).toMatchObject({ repo: 'acme/api', id: 7, title: 'PROJ-1 export', state: 'OPEN', source: 'feat/PROJ-1', destination: 'main', description: 'd', url: 'https://forge/pr/7' });
      expect(pr.reviewers).toHaveLength(1);
      expect(pr.ci).toBe(ci);
    });

    it('reads files, the diff and comments, oldest first with inline ones located', async () => {
      const forge = make();
      expect(await forge.files(repo, 7)).toEqual([{ status: 'added', path: 'a.txt', oldPath: null, added: 1, removed: 0 }]);
      expect(await forge.diff(repo, 7)).toEqual({ diff: DIFF, truncated: false });
      const comments = await forge.comments(repo, 7);
      expect(comments.map((c) => c.id).sort()).toEqual([1, 2]);
      expect(comments.find((c) => c.id === 2)).toMatchObject({ author: 'Bob', text: 'why?', path: 'a.txt', line: 1 });
      expect(comments.find((c) => c.id === 1)).toMatchObject({ path: null, line: null });
    });

    it('gives out a clone credential', async () => {
      expect((await make().cloneToken(repo)).length).toBeGreaterThan(3);
    });

    it(writes ? 'comments' : 'refuses to comment', async () => {
      const forge = make();
      if (writes) {
        expect(await forge.addComment(repo, 7, 'ok')).toEqual({ id: 9 });
      } else {
        await expect(forge.addComment(repo, 7, 'ok')).rejects.toThrow(/read-only/);
      }
    });
  });
}

forgeContract('Bitbucket through workbench', bitbucket, true, null);
forgeContract('GitHub', github, false, 'passed');

describe('the Jira work source', () => {
  it('moves a ticket only through a transition it finds by target status', async () => {
    const calls: string[] = [];
    const srv = fakeServers({
      exec: (tool, args) => {
        calls.push(tool);
        if (tool === 'jira_get_transitions') return { transitions: [{ id: '31', name: 'Review', toStatus: 'Code Review' }] };
        if (tool === 'jira_transition_issue') return { success: args.transitionId === '31' };
        return {};
      },
    });
    const source = jiraWorkSource(new Workbench(`${WB}/mcp`, srv.fetchFn), 'tok');
    expect(await source.transitionTo('PROJ-1', 'code review')).toBe(true);
    expect(await source.transitionTo('PROJ-1', 'Done')).toBe(false);
    expect(calls.filter((c) => c === 'jira_transition_issue')).toHaveLength(1);
    await expect(source.list({ filter: 'nope' }, 20)).rejects.toMatchObject({ status: 400 });
  });
});

describe('the core without Jira or Bitbucket', () => {
  useEnv({ LEGOS_SETTINGS: join(import.meta.dirname, 'fixtures/settings/app.json') });

  it('syncs a work item through any WorkSource and Forge', async () => {
    const db = openDb(':memory:');
    new MyRepos(db).add('local', { name: 'acme/api', mainBranch: 'main' });
    const items = new WorkItems(db);
    items.create('local', 'PROJ-1');
    items.addRepo('local', 'PROJ-1', 'acme/api');
    items.link('local', 'PROJ-1', { repo: 'acme/api', kind: 'impl', prId: 7, branch: 'feat/PROJ-1', title: 'PROJ-1 export', state: 'OPEN', runId: null }, true);
    const manager = new RunManager(alive);
    const deps = buildDeps(manager, { db, workspaces: mkdtempSync(join(tmpdir(), 'lf-ws-')) });
    createApp(manager, { db }, deps);

    const log: string[] = [];
    let status = 'In Progress';
    const source: WorkSource = {
      list: async () => ({ items: [], next: null }),
      get: async () => {
        throw new Error('unused');
      },
      status: async () => status,
      transitionTo: async (key, to) => (log.push(`${key} -> ${to}`), (status = to), true),
      comment: async (key, body) => void log.push(`comment ${key}: ${body}`),
    };
    const forge: Forge = { ...github(), getPr: async (r, id) => ({ ...(await github().getPr(r, id)), id, state: 'OPEN' }) };
    deps.workSource = async () => source;
    deps.forge = async () => forge;
    await syncWorkItem(deps, 'local', 'PROJ-1');
    expect(log).toEqual(['PROJ-1 -> Code Review']);
    expect(items.get('local', 'PROJ-1')).toMatchObject({ status: 'Code Review', done: false });
  });
});

function bareRepos() {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
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

describe('per-workspace configuration', () => {
  function app() {
    const db = openDb(':memory:');
    new MyRepos(db).add('local', { name: 'acme/api', mainBranch: 'main' });
    new WorkItems(db).create('local', 'PROJ-1');
    new WorkItems(db).addRepo('local', 'PROJ-1', 'acme/api');
    const manager = new RunManager(alive);
    const starts: { prompt: string }[] = [];
    const orig = manager.start.bind(manager);
    manager.start = (r) => (starts.push(r), orig(r));
    const options = { db, workspaces: mkdtempSync(join(tmpdir(), 'lf-ws-')), gitUrl: bareRepos() };
    const a = createApp(manager, options);
    const send = (method: string, path: string, body: unknown = {}) =>
      a.request(`http://localhost:4317${path}`, { method, ...(method !== 'GET' && { body: JSON.stringify(body) }), headers: { host: 'localhost:4317', 'x-legos': '1', 'content-type': 'application/json' } });
    return { send, starts, db };
  }

  it('keeps title rules out of the code: none unless the workspace sets one', async () => {
    const { send } = app();
    const get = async () => (await (await send('GET', '/api/workspaces')).json()).config;
    expect(await get()).toEqual({});
    const id = (await (await send('GET', '/api/workspaces')).json()).active;
    const res = await send('PUT', `/api/workspaces/${id}/config`, { prTitle: { design: 'Prefix spec PR titles with SPEC.', build: '' } });
    expect(res.status).toBe(200);
    expect(await get()).toEqual({ prTitle: { design: 'Prefix spec PR titles with SPEC.' } });
    expect((await send('PUT', `/api/workspaces/${id}/config`, { prTitle: { design: 'x'.repeat(501) } })).status).toBe(400);
    expect((await get()).prTitle?.design).toBe('Prefix spec PR titles with SPEC.');
  });

  it("adds the workspace's rule to the stage instructions, and nothing org-specific otherwise", async () => {
    expect(stageGuide('design', 'PROJ-1')).not.toMatch(/deployment/);
    expect(stageGuide('design', 'PROJ-1', 'Prefix with SPEC.')).toMatch(/title format\. Prefix with SPEC\.$/);
    const { send, starts } = app();
    const id = (await (await send('GET', '/api/workspaces')).json()).active;
    await send('PUT', `/api/workspaces/${id}/config`, { prTitle: { design: 'Prefix spec PR titles with SPEC.', build: '' } });
    const body = { repo: 'acme/api', ticket: 'PROJ-1', stage: 'design', kind: 'task', prompt: 'go' };
    expect((await send('POST', '/api/runs', body)).status).toBe(201);
    for (let i = 0; i < 200 && !starts.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(starts[0].prompt).toMatch(/Prefix spec PR titles with SPEC\./);
  });
});
