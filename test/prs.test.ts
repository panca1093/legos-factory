import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ActivityLog } from '../server/activity.ts';
import { createApp, nameFromEmail } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import { MyRepos } from '../server/my-repos.ts';
import type { Run } from '../shared/types.ts';
import { alive, fakeServers, WB } from './fakes.ts';

const PRS: Record<string, any[]> = {
  'acme/api:OPEN': [
    { id: 12, title: 'feat: PROJ-7 add export', state: 'OPEN', author: 'Ada', source: 'feat/PROJ-7', destination: 'main', updated_on: '2026-10-02' },
    { id: 13, title: 'fix: PROJ-70 unrelated', state: 'OPEN', author: 'Bob', source: 'fix/PROJ-70', destination: 'main', updated_on: '2026-10-03' },
  ],
  'acme/api:MERGED': [{ id: 9, title: 'spec for export', state: 'MERGED', author: 'Ada', source: 'feature/proj-7-spec', destination: 'main', updated_on: '2026-09-30' }],
  'acme/web:OPEN': [{ id: 4, title: 'PROJ-7 web part', state: 'OPEN', author: 'Ada', source: 'ui/x', destination: 'main', updated_on: '2026-10-01' }],
};

function setup(opts: { bitbucketWorkspace?: string; whoami?: object; repos?: string[] } = {}) {
  const calls: { tool: string; args: any }[] = [];
  const srv = fakeServers({
    whoami: opts.whoami ?? { id: 'u1', email: 'bob@acme.test', name: 'Bob Stone' },
    exec: (tool, args) => {
      calls.push({ tool, args });
      if (tool === 'bitbucket_list_repos')
        return { repos: args.page === 1 ? [{ slug: 'api', full_name: `${args.workspace}/api`, mainbranch: 'main', updated_on: '2026-10-01' }] : [], hasMore: false };
      if (tool === 'bitbucket_list_prs') return { prs: PRS[`${args.workspace}/${args.repoSlug}:${args.state}`] ?? [], hasMore: false };
      if (tool === 'bitbucket_add_pr_comment') return { id: 99, created_on: '2026-10-05' };
      if (tool === 'bitbucket_search_users')
        return { users: args.query === 'Bob Stone' ? [{ display_name: 'Bob Stone', uuid: '{b-1}' }, { display_name: 'Bob Stoneman', uuid: '{b-2}' }] : [], hasMore: false };
      if (tool === 'bitbucket_get_pr' && args.workspace === 'acme' && args.repoSlug === 'web')
        return { id: 4, title: 'PROJ-7 web part', state: 'OPEN', author: 'Ada', source: 'ui/x', destination: 'main', reviewers: [{ display_name: 'Robert S.', uuid: '{b-1}', approved: false }], url: 'https://forge/pr/4' };
      if (tool === 'bitbucket_get_pr')
        return { id: 12, title: 'feat: PROJ-7 add export', description: 'adds **export**', state: 'OPEN', author: 'Ada', source: 'feat/PROJ-7', destination: 'main', reviewers: [{ display_name: 'Bob', approved: true }], comment_count: 1, task_count: 0, url: 'https://forge/pr/12' };
      if (tool === 'bitbucket_get_pr_diff')
        return args.diffstat ? { files: [{ status: 'modified', old: 'a.go', new: 'a.go', lines_added: 2, lines_removed: 1 }], hasMore: false } : { diff: 'diff --git a/a.go b/a.go\n+x\n' };
      if (tool === 'bitbucket_list_pr_comments' && args.prId === 13) return { comments: [{ id: 5, author: 'Bob', text: 'ping @Bob Stone', created_on: '2026-10-03' }], hasMore: false };
      if (tool === 'bitbucket_list_pr_comments' && args.prId === 9) return { comments: [{ id: 6, author: 'Ada', text: 'thoughts, @bob stone?', created_on: '2026-10-03' }], hasMore: false };
      if (tool === 'bitbucket_list_pr_comments')
        return {
          comments: [
            { id: 1, author: 'Bob', text: 'nice', inline: { path: 'a.go', line: 3 }, created_on: '2026-10-02' },
            { id: 2, author: 'Eve', text: 'why?\nreally', created_on: '2026-10-02' },
          ],
          hasMore: false,
        };
      return null;
    },
  });
  const db = openDb(':memory:');
  for (const name of opts.repos ?? ['acme/api', 'acme/web']) new MyRepos(db).add('local', { name, mainBranch: 'main' });
  // no such forge: fix queues fail at the clone, which is all these tests need
  const app = createApp(new RunManager(alive), { db, selfUrl: 'http://localhost:4317', fetch: srv.fetchFn, gitUrl: 'file:///nonexistent/{workspace}/{slug}.git', bitbucketWorkspace: opts.bitbucketWorkspace });
  const req = (p: string, init: RequestInit = {}) => app.request(`http://localhost:4317${p}`, { ...init, headers: { host: 'localhost:4317', ...(init.headers as any) } });
  const post = (p: string, body: unknown = {}) => req(p, { method: 'POST', body: JSON.stringify(body), headers: { 'x-legos': '1', 'content-type': 'application/json' } });
  const connectWorkbench = async () => {
    await post('/api/connections', { name: 'workbench', kind: 'workbench', url: WB, auth: 'oauth' });
    const authorize = new URL((await (await post('/api/connections/workbench/connect')).json()).url);
    srv.setChallenge(authorize.searchParams.get('code_challenge')!);
    await req(`/auth/callback?code=abc&state=${authorize.searchParams.get('state')}`);
  };
  return { req, post, connectWorkbench, calls, db };
}

beforeAll(() => {
  process.env.LEGOS_SETTINGS = join(import.meta.dirname, 'fixtures/settings/app.json');
});

describe('pull requests', () => {
  it('need a connected workbench and valid input', async () => {
    const { req, connectWorkbench } = setup();
    expect((await req('/api/prs?ticket=PROJ-7')).status).toBe(409);
    await connectWorkbench();
    expect((await req('/api/prs?ticket=nope')).status).toBe(400);
    expect((await req('/api/prs/acme/api/abc')).status).toBe(400);
    expect((await req('/api/prs/acme/api/0')).status).toBe(400);
  });

  it("finds a ticket's PRs by key in branch or title across my repos only, open first", async () => {
    const { req, connectWorkbench, db, calls } = setup();
    await connectWorkbench();
    // a run on a repo that is not in my repos doesn't make it a candidate
    const now = new Date().toISOString();
    await new ActivityLog(db).record({ id: 'r1', owner: 'local', repo: 'acme/legacy', ticket: 'PROJ-7', sessionId: null, cwd: '/x', prompt: 'p', kind: 'task', status: 'completed', startedAt: now, lastEventAt: now } as Run, 'local');

    const res = await (await req('/api/prs?ticket=PROJ-7&repos=acme/other')).json();
    expect(res.searched).toEqual(['acme/api', 'acme/web']);
    expect(res.prs.map((p: any) => `${p.repo}#${p.id}`)).toEqual(['acme/api#12', 'acme/web#4', 'acme/api#9']); // PROJ-70 is not PROJ-7
    expect([...new Set(calls.filter((c) => c.tool === 'bitbucket_list_prs').map((c) => `${c.args.workspace}/${c.args.repoSlug}`))].sort()).toEqual(['acme/api', 'acme/web']);
  });

  it('refuses PRs of a repo that is not in my repos', async () => {
    const { req, post, connectWorkbench, calls } = setup();
    await connectWorkbench();
    for (const r of [req('/api/prs/acme/legacy/12'), req('/api/prs/acme/legacy/12/diff'), req('/api/prs/acme/legacy/12/fixes'), post('/api/prs/acme/legacy/12/comments', { text: 'hi' }), post('/api/prs/acme/legacy/12/fixes', { commentIds: [1] })]) {
      const res = await r;
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'repo is not in your repos', needRepo: true });
    }
    expect(calls).toEqual([]);
    expect((await req('/api/prs/ACME/Api/12')).status).toBe(200);
  });

  it('serves one PR with its files and comments, and its diff separately', async () => {
    const { req, connectWorkbench, calls } = setup();
    await connectWorkbench();
    const res = await (await req('/api/prs/acme/api/12')).json();
    expect(res.pr).toMatchObject({ repo: 'acme/api', id: 12, state: 'OPEN', reviewers: [{ name: 'Bob', approved: true }], url: 'https://forge/pr/12' });
    expect(res.files).toEqual([{ status: 'modified', path: 'a.go', oldPath: null, added: 2, removed: 1 }]);
    expect(res.comments[0]).toEqual({ id: 1, author: 'Bob', text: 'nice', path: 'a.go', line: 3, created: '2026-10-02' });
    expect(calls.find((c) => c.tool === 'bitbucket_get_pr')!.args).toEqual({ workspace: 'acme', repoSlug: 'api', pullRequestId: 12 });
    expect(await (await req('/api/prs/acme/api/12/diff')).json()).toEqual({ diff: 'diff --git a/a.go b/a.go\n+x\n', truncated: false });
  });

  it('replies to a comment on its line, quoting it, or posts a general comment', async () => {
    const { post, connectWorkbench, calls } = setup();
    expect((await post('/api/prs/acme/api/12/comments', { text: 'hi' })).status).toBe(409);
    await connectWorkbench();
    expect((await post('/api/prs/acme/api/12/comments', { text: '  ' })).status).toBe(400);
    expect((await post('/api/prs/acme/api/12/comments', { text: 'x', replyTo: 'one' })).status).toBe(400);
    expect((await post('/api/prs/acme/api/12/comments', { text: 'x', replyTo: 404 })).status).toBe(404);

    expect(await (await post('/api/prs/acme/api/12/comments', { text: 'Renamed, thanks', replyTo: 1 })).json()).toEqual({ id: 99 });
    const added = () => calls.filter((c) => c.tool === 'bitbucket_add_pr_comment').map((c) => c.args);
    expect(added()[0]).toEqual({ workspace: 'acme', repoSlug: 'api', prId: 12, text: '> **Bob:**\n> nice\n\nRenamed, thanks', inline: { path: 'a.go', line: 3 } });
    await post('/api/prs/acme/api/12/comments', { text: 'Because', replyTo: 2 });
    expect(added()[1]).toEqual({ workspace: 'acme', repoSlug: 'api', prId: 12, text: '> **Eve:**\n> why?\n> really\n\nBecause' });
    await post('/api/prs/acme/api/12/comments', { text: 'LGTM' });
    expect(added()[2]).toEqual({ workspace: 'acme', repoSlug: 'api', prId: 12, text: 'LGTM' });
  });

  it('starts a fix queue for chosen comments, in the order given', async () => {
    const { req, post, connectWorkbench } = setup();
    await connectWorkbench();
    expect((await post('/api/prs/acme/api/12/fixes', { commentIds: [] })).status).toBe(400);
    expect((await post('/api/prs/acme/api/12/fixes', { commentIds: ['1'] })).status).toBe(400);
    expect((await post('/api/prs/acme/api/12/fixes', { commentIds: [7] })).status).toBe(404);
    expect(await (await req('/api/prs/acme/api/12/fixes')).json()).toEqual({ queue: null });

    const res = await post('/api/prs/acme/api/12/fixes', { commentIds: [2, 1, 2] });
    expect(res.status).toBe(201);
    const q = await res.json();
    expect(q).toMatchObject({ repo: 'acme/api', prId: 12, branch: 'feat/PROJ-7', status: 'preparing' });
    expect(q.ticket ?? null).toBeNull();
    expect(q.items.map((i: any) => [i.commentId, i.status])).toEqual([[2, 'pending'], [1, 'pending']]);
    expect(q.items[1]).toMatchObject({ author: 'Bob', text: 'nice', path: 'a.go', line: 3 });

    // the forge here doesn't exist, so the clone fails and the queue says why
    let now: any;
    for (let i = 0; i < 200 && now?.status !== 'failed'; i++) {
      now = (await (await req('/api/prs/acme/api/12/fixes')).json()).queue;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(now).toMatchObject({ id: q.id, status: 'failed' });
    expect(now.error).toMatch(/could not clone acme\/api@feat\/PROJ-7/);
    expect((await post(`/api/fixes/${q.id}/items/1/approve`)).status).toBe(409);
    expect((await post('/api/fixes/nope/cancel')).status).toBe(404);
  });

  it('lists open PRs where you are a reviewer or mentioned, not your own', async () => {
    const { req, connectWorkbench, calls } = setup();
    expect((await req('/api/reviews')).status).toBe(409);
    await connectWorkbench();
    const res = await (await req('/api/reviews')).json();
    expect(res).toMatchObject({ me: 'Bob Stone', searched: ['acme/api', 'acme/web'], scanned: 3 });
    // web#4 has him as reviewer; api#13 (by a different Bob) mentions him; api#12 does neither
    expect(res.items.map((p: any) => [`${p.repo}#${p.id}`, p.why])).toEqual([
      ['acme/api#13', ['mentioned']],
      ['acme/web#4', ['reviewer']],
    ]);
    // web#4 lists him under another display name: his Bitbucket account id still matches
    expect(res.matchedById).toBe(true);
    expect(res.items[1]).toMatchObject({ approvedByMe: false, reviewers: [{ name: 'Robert S.', uuid: '{b-1}', approved: false }], url: 'https://forge/pr/4' });
    // cached for a few minutes unless refreshed
    const scans = () => calls.filter((c) => c.tool === 'bitbucket_list_prs').length;
    const before = scans();
    await req('/api/reviews');
    expect(scans()).toBe(before);
    await req('/api/reviews?refresh=1');
    expect(scans()).toBe(before + 2);
  });

  it("matches you by the name in your email when workbench gives none, or by the name you set", async () => {
    expect(nameFromEmail('saifullah.panca@amartha.com')).toBe('Saifullah Panca');
    expect(nameFromEmail('JANE_doe2+ci@x.io')).toBe('Jane Doe2');
    expect(nameFromEmail('42@x.io')).toBe('');

    const { req, connectWorkbench } = setup({ whoami: { id: 'u1', email: 'bob.stone@acme.test' }, repos: ['acme/web'] });
    await connectWorkbench();
    const guessed = await (await req('/api/reviews')).json();
    expect(guessed.me).toBe('Bob Stone');
    expect(guessed.items.map((p: any) => p.id)).toEqual([4]);
    const set = await (await req('/api/reviews?as=Somebody%20Else')).json();
    expect(set).toMatchObject({ me: 'Somebody Else', items: [] });

    const anon = setup({ whoami: { id: 'u1', email: '42@acme.test' }, repos: ['acme/web'] });
    await anon.connectWorkbench();
    const r = await anon.req('/api/reviews');
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ needName: true });
  });

  it('scans only my repos, looking you up in the first one\'s workspace', async () => {
    const { req, connectWorkbench, calls } = setup({ bitbucketWorkspace: 'acme', repos: ['ACME/api'] });
    await connectWorkbench();
    const res = await (await req('/api/reviews?workspace=other&repos=acme/web')).json();
    expect(res).toMatchObject({ searched: ['ACME/api'] });
    expect(calls.filter((c) => c.tool === 'bitbucket_list_repos')).toEqual([]);
    expect(calls.filter((c) => c.tool === 'bitbucket_list_prs').map((c) => c.args.repoSlug)).toEqual(['api']);
    expect(calls.find((c) => c.tool === 'bitbucket_search_users')!.args.workspace).toBe('ACME');

    const empty = setup({ repos: [] });
    await empty.connectWorkbench();
    const r = await empty.req('/api/reviews');
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ needRepos: true });
  });

  it('lists repos from the configured workspace, sharing one load between concurrent callers', async () => {
    const { req, connectWorkbench, calls } = setup({ bitbucketWorkspace: 'acme' });
    await connectWorkbench();
    const [a, b] = await Promise.all([req('/api/repos'), req('/api/repos')]);
    expect(await a.json()).toEqual({ workspace: 'acme', repos: [{ name: 'acme/api', mainBranch: 'main', updated: '2026-10-01', description: null }] });
    expect((await b.json()).workspace).toBe('acme');
    expect(calls.filter((c) => c.tool === 'bitbucket_list_repos')).toHaveLength(1);
    expect((await (await req('/api/repos?workspace=other')).json()).workspace).toBe('other');
  });

  it('asks for a workspace when none is configured', async () => {
    const { req, connectWorkbench } = setup();
    await connectWorkbench();
    const r = await req('/api/repos');
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ needWorkspace: true });
  });
});

describe('my repos api', () => {
  it('adds a repo found in its workspace, with the forge spelling and main branch', async () => {
    const { req, post, connectWorkbench } = setup({ repos: [] });
    await connectWorkbench();
    expect((await post('/api/my-repos', { repo: 'not a repo' })).status).toBe(400);
    const unknown = await post('/api/my-repos', { repo: 'acme/nope' });
    expect(unknown.status).toBe(404);

    const added = await post('/api/my-repos', { repo: 'acme/API' });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ name: 'acme/api', mainBranch: 'main' });
    expect((await post('/api/my-repos', { repo: 'ACME/api' })).status).toBe(409);
    const { repos } = await (await req('/api/my-repos')).json();
    expect(repos).toEqual([{ name: 'acme/api', mainBranch: 'main', addedAt: expect.any(String), projects: [] }]);

    const del = await req('/api/my-repos/acme/api', { method: 'DELETE', headers: { 'x-legos': '1' } });
    expect(del.status).toBe(204);
    expect(await (await req('/api/my-repos')).json()).toEqual({ repos: [] });
  });
});
