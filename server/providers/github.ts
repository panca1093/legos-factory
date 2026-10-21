import type { Forge, Pr, PrComment, PrFile, PrRow, PrState, RepoRow } from '../ports.ts';

// GitHub's REST API, read-only: enough to look at pull requests and clone, nothing that writes.

const API = 'https://api.github.com';

const readOnly = (what: string) => Object.assign(new Error(`the GitHub provider is read-only: it cannot ${what}`), { status: 405 });
const ci = (state: unknown): Pr['ci'] => (state === 'success' ? 'passed' : state === 'failure' || state === 'error' ? 'failed' : state === 'pending' ? 'pending' : null);

export function githubForge(opts: { token: string; http?: typeof fetch; apiUrl?: string }): Forge {
  const http = opts.http ?? fetch;
  const base = opts.apiUrl ?? API;
  const get = async (path: string, accept = 'application/vnd.github+json'): Promise<Response> => {
    const res = await http(`${base}${path}`, { headers: { authorization: `Bearer ${opts.token}`, accept, 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw Object.assign(new Error(`GitHub answered HTTP ${res.status} for ${path.split('?')[0]}`), { status: res.status === 404 ? 404 : 502 });
    return res;
  };
  const json = async (path: string) => (await get(path)).json() as Promise<any>;
  const row = (repo: string, p: any): PrRow => ({
    repo,
    id: Number(p.number),
    title: String(p.title ?? ''),
    state: p.merged_at ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'DECLINED',
    author: p.user?.login ?? null,
    source: String(p.head?.ref ?? ''),
    destination: String(p.base?.ref ?? ''),
    updated: p.updated_at ?? null,
  });
  const name = ({ workspace, slug }: { workspace: string; slug: string }) => `${workspace}/${slug}`;

  return {

    async listRepos(owner): Promise<RepoRow[]> {
      const repos = (await json(`/users/${owner}/repos?per_page=100&sort=updated`)) as any[];
      return repos.map((r) => ({ name: String(r.full_name), mainBranch: r.default_branch ?? null, updated: r.updated_at ?? null, description: r.description || null }));
    },

    async listPrs(repo, state: PrState, limit = 50) {
      const found = (await json(`/repos/${name(repo)}/pulls?state=${state === 'OPEN' ? 'open' : 'closed'}&per_page=${limit}&sort=updated&direction=desc`)) as any[];
      return found.map((p) => row(name(repo), p)).filter((p) => p.state === state);
    },

    async getPr(repo, id): Promise<Pr> {
      const p = await json(`/repos/${name(repo)}/pulls/${id}`);
      const status = p.head?.sha ? await json(`/repos/${name(repo)}/commits/${p.head.sha}/status`).catch(() => null) : null;
      return {
        ...row(name(repo), p),
        created: p.created_at ?? null,
        description: String(p.body ?? ''),
        url: p.html_url ?? null,
        reviewers: (p.requested_reviewers ?? []).map((r: any) => ({ name: String(r.login), uuid: String(r.id), approved: false })),
        comments: Number(p.comments ?? 0) + Number(p.review_comments ?? 0),
        tasks: 0,
        ci: status?.total_count ? ci(status.state) : null,
      };
    },

    async files(repo, id): Promise<PrFile[]> {
      const files = (await json(`/repos/${name(repo)}/pulls/${id}/files?per_page=100`)) as any[];
      return files.map((f) => ({
        status: String(f.status ?? 'modified'),
        path: String(f.filename),
        oldPath: f.previous_filename ? String(f.previous_filename) : null,
        added: Number(f.additions ?? 0),
        removed: Number(f.deletions ?? 0),
      }));
    },

    async diff(repo, id) {
      return { diff: await (await get(`/repos/${name(repo)}/pulls/${id}`, 'application/vnd.github.diff')).text(), truncated: false };
    },

    async comments(repo, id): Promise<PrComment[]> {
      const [review, general] = (await Promise.all([json(`/repos/${name(repo)}/pulls/${id}/comments?per_page=100`), json(`/repos/${name(repo)}/issues/${id}/comments?per_page=100`)])) as any[][];
      const map = (c: any): PrComment => ({ id: Number(c.id), author: c.user?.login ?? null, text: String(c.body ?? ''), path: c.path ?? null, line: c.line ?? c.original_line ?? null, created: c.created_at ?? null });
      return [...review, ...general].map(map).sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''));
    },

    async addComment() {
      throw readOnly('comment');
    },

    // a token authorises HTTPS git as x-access-token; this provider holds one for the whole deployment
    async cloneToken() {
      return opts.token;
    },

    async searchUsers() {
      return [];
    },
  };
}
