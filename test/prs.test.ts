import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ActivityLog } from '../server/activity.ts';
import { createApp } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
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

function setup(opts: { bitbucketWorkspace?: string } = {}) {
  const calls: { tool: string; args: any }[] = [];
  const srv = fakeServers({
    exec: (tool, args) => {
      calls.push({ tool, args });
      if (tool === 'bitbucket_list_repos')
        return { repos: args.page === 1 ? [{ slug: 'api', full_name: `${args.workspace}/api`, mainbranch: 'main', updated_on: '2026-10-01' }] : [], hasMore: false };
      if (tool === 'bitbucket_list_prs') return { prs: PRS[`${args.workspace}/${args.repoSlug}:${args.state}`] ?? [], hasMore: false };
      if (tool === 'bitbucket_get_pr')
        return { id: 12, title: 'feat: PROJ-7 add export', description: 'adds **export**', state: 'OPEN', author: 'Ada', source: 'feat/PROJ-7', destination: 'main', reviewers: [{ display_name: 'Bob', approved: true }], comment_count: 1, task_count: 0, url: 'https://forge/pr/12' };
      if (tool === 'bitbucket_get_pr_diff')
        return args.diffstat ? { files: [{ status: 'modified', old: 'a.go', new: 'a.go', lines_added: 2, lines_removed: 1 }], hasMore: false } : { diff: 'diff --git a/a.go b/a.go\n+x\n' };
      if (tool === 'bitbucket_list_pr_comments') return { comments: [{ id: 1, author: 'Bob', text: 'nice', inline: { path: 'a.go', line: 3 }, created_on: '2026-10-02' }], hasMore: false };
      return null;
    },
  });
  const db = openDb(':memory:');
  const app = createApp(new RunManager(alive), { db, selfUrl: 'http://localhost:4317', fetch: srv.fetchFn, ...opts });
  const req = (p: string, init: RequestInit = {}) => app.request(`http://localhost:4317${p}`, { ...init, headers: { host: 'localhost:4317', ...(init.headers as any) } });
  const post = (p: string, body: unknown = {}) => req(p, { method: 'POST', body: JSON.stringify(body), headers: { 'x-legos': '1', 'content-type': 'application/json' } });
  const connectWorkbench = async () => {
    await post('/api/connections', { name: 'workbench', kind: 'workbench', url: WB, auth: 'oauth' });
    const authorize = new URL((await (await post('/api/connections/workbench/connect')).json()).url);
    srv.setChallenge(authorize.searchParams.get('code_challenge')!);
    await req(`/auth/callback?code=abc&state=${authorize.searchParams.get('state')}`);
  };
  return { req, connectWorkbench, calls, db };
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

  it("finds a ticket's PRs by key in branch or title across its repos, open first", async () => {
    const { req, connectWorkbench, db } = setup();
    await connectWorkbench();
    // a run on acme/web for this ticket makes that repo a candidate without the client naming it
    const now = new Date().toISOString();
    await new ActivityLog(db).record({ id: 'r1', owner: 'local', repo: 'acme/web', ticket: 'PROJ-7', sessionId: null, cwd: '/x', prompt: 'p', kind: 'task', status: 'completed', startedAt: now, lastEventAt: now } as Run, 'local');

    const res = await (await req('/api/prs?ticket=PROJ-7&repos=acme/api,bad repo')).json();
    expect(res.searched.sort()).toEqual(['acme/api', 'acme/web']);
    expect(res.prs.map((p: any) => `${p.repo}#${p.id}`)).toEqual(['acme/api#12', 'acme/web#4', 'acme/api#9']); // PROJ-70 is not PROJ-7
  });

  it('serves one PR with its files and comments, and its diff separately', async () => {
    const { req, connectWorkbench, calls } = setup();
    await connectWorkbench();
    const res = await (await req('/api/prs/acme/api/12')).json();
    expect(res.pr).toMatchObject({ repo: 'acme/api', id: 12, state: 'OPEN', reviewers: [{ name: 'Bob', approved: true }], url: 'https://forge/pr/12' });
    expect(res.files).toEqual([{ status: 'modified', path: 'a.go', oldPath: null, added: 2, removed: 1 }]);
    expect(res.comments).toEqual([{ id: 1, author: 'Bob', text: 'nice', path: 'a.go', line: 3, created: '2026-10-02' }]);
    expect(calls.find((c) => c.tool === 'bitbucket_get_pr')!.args).toEqual({ workspace: 'acme', repoSlug: 'api', pullRequestId: 12 });
    expect(await (await req('/api/prs/acme/api/12/diff')).json()).toEqual({ diff: 'diff --git a/a.go b/a.go\n+x\n', truncated: false });
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
