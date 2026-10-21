import type { Forge, Inline, Pr, PrComment, PrFile, PrRow, PrState, RepoRow } from '../ports.ts';
import type { Workbench } from '../workbench.ts';

// Bitbucket through workbench's execute_tools, with the signed-in user's own token.

const REPO_PAGES = 30;
// pages fetched at once after the first; a 1,100-repo workspace drops from ~33 s serial to a few seconds
const REPO_PAGE_BATCH = 6;

export function tokenFromCloneUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const token = u.protocol === 'https:' && u.hostname === 'bitbucket.org' && u.username === 'x-token-auth' && u.password ? decodeURIComponent(u.password) : null;
    return token && !/[\x00-\x1f\x7f]/.test(token) ? token : null;
  } catch {
    return null;
  }
}

// Recovers the diff text from a cut-off `{"results":[{"result":"…` envelope, ending at the last whole line.
export function salvageDiff(raw: string): string | null {
  const prefix = '{"results":[{"result":"';
  if (!raw.startsWith(prefix)) return null;
  const body = raw.slice(prefix.length);
  const cut = body.lastIndexOf('\\n');
  if (cut < 0) return null;
  try {
    return JSON.parse(`"${body.slice(0, cut)}"`);
  } catch {
    return null;
  }
}

// A comment list whose JSON envelope was cut: the comments that arrived whole.
export function salvageComments(raw: string): unknown[] | null {
  const prefix = '{"results":[{"result":{"comments":[';
  if (!raw.startsWith(prefix)) return null;
  const body = raw.slice(prefix.length);
  const cut = body.lastIndexOf('},{"id":');
  if (cut < 0) return [];
  try {
    return JSON.parse(`[${body.slice(0, cut + 1)}]`);
  } catch {
    return null;
  }
}


export function bitbucketForge(wb: Workbench, token: string): Forge {
  const run = (tool: string, args: object, salvage?: (raw: string) => unknown) => wb.execute(token, tool, args, salvage);
  return {

    // Every repo in a workspace, most recently updated first. The tool has no search, so page through all.
    async listRepos(workspace): Promise<RepoRow[]> {
      const page = (n: number) => run('bitbucket_list_repos', { workspace, pagelen: 100, page: n });
      const pages = [await page(1)];
      for (let next = 2; pages.at(-1)?.hasMore && next <= REPO_PAGES; next += REPO_PAGE_BATCH) {
        const batch = await Promise.all(Array.from({ length: Math.min(REPO_PAGE_BATCH, REPO_PAGES - next + 1) }, (_, i) => page(next + i)));
        // an empty page past the end has hasMore false; keep everything up to the first such page
        const end = batch.findIndex((p) => !p?.hasMore);
        pages.push(...(end < 0 ? batch : batch.slice(0, end + 1)));
      }
      const out: RepoRow[] = pages.flatMap((r) =>
        (r?.repos ?? []).map((x: any) => ({ name: String(x.full_name ?? `${workspace}/${x.slug}`), mainBranch: x.mainbranch ?? null, updated: x.updated_on ?? null, description: x.description || null })),
      );
      return out.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
    },

    async listPrs({ workspace, slug }, state: PrState, pagelen = 50): Promise<PrRow[]> {
      const r = await run('bitbucket_list_prs', { workspace, repoSlug: slug, state, pagelen });
      return (r?.prs ?? []).map((p: any) => ({
        repo: `${workspace}/${slug}`,
        id: Number(p.id),
        title: String(p.title ?? ''),
        state: String(p.state ?? state),
        author: p.author ?? null,
        source: String(p.source ?? ''),
        destination: String(p.destination ?? ''),
        updated: p.updated_on ?? null,
      }));
    },

    async getPr({ workspace, slug }, id): Promise<Pr> {
      const p = await run('bitbucket_get_pr', { workspace, repoSlug: slug, pullRequestId: id });
      return {
        repo: `${workspace}/${slug}`,
        id: Number(p.id),
        title: String(p.title ?? ''),
        state: String(p.state ?? ''),
        author: p.author ?? null,
        source: String(p.source ?? ''),
        destination: String(p.destination ?? ''),
        updated: p.updated_on ?? null,
        created: p.created_on ?? null,
        description: String(p.description ?? ''),
        url: p.url ?? null,
        reviewers: (p.reviewers ?? []).map((r: any) => ({ name: String(r.display_name ?? 'Reviewer'), uuid: r.uuid ?? null, approved: r.approved === true })),
        comments: Number(p.comment_count ?? 0),
        tasks: Number(p.task_count ?? 0),
        // the PR tool reports no pipeline result
        ci: null,
      };
    },

    async files({ workspace, slug }, id): Promise<PrFile[]> {
      const r = await run('bitbucket_get_pr_diff', { workspace, repoSlug: slug, prId: id, diffstat: true });
      return (r?.files ?? []).map((f: any) => ({
        status: String(f.status ?? 'modified'),
        path: String(f.new ?? f.old ?? ''),
        oldPath: f.old && f.old !== f.new ? String(f.old) : null,
        added: Number(f.lines_added ?? 0),
        removed: Number(f.lines_removed ?? 0),
      }));
    },

    // The whole unified diff, or as much of it as workbench returns: workbench cuts tool text at ~60,000 characters,
    // which breaks the JSON of a big diff.
    async diff({ workspace, slug }, id) {
      const out = await wb.call(token, 'execute_tools', { executions: [{ tool: 'bitbucket_get_pr_diff', args: { workspace, repoSlug: slug, prId: id } }] });
      if (typeof out === 'string') {
        const partial = salvageDiff(out);
        if (partial === null) throw new Error('bitbucket_get_pr_diff returned an unreadable result');
        return { diff: partial, truncated: true };
      }
      const first = out?.results?.[0];
      if (!first) throw new Error('bitbucket_get_pr_diff returned nothing');
      if (first.error) throw new Error(first.message ?? 'bitbucket_get_pr_diff failed');
      const r = first.result;
      return { diff: typeof r === 'string' ? r : String(r?.diff ?? r?.text ?? ''), truncated: false };
    },

    async comments({ workspace, slug }, id): Promise<PrComment[]> {
      const r = await run('bitbucket_list_pr_comments', { workspace, repoSlug: slug, prId: id, pagelen: 100 }, (raw) => {
        const comments = salvageComments(raw);
        return comments && { comments };
      });
      return (r?.comments ?? []).map((c: any) => ({
        id: Number(c.id),
        author: c.author ?? null,
        text: String(c.text ?? ''),
        path: c.inline?.path ?? null,
        line: c.inline?.line ?? null,
        created: c.created_on ?? null,
      }));
    },

    // The tool has no parent id, so a reply is a new comment on the same line (or a general one).
    async addComment({ workspace, slug }, id, text, inline?: Inline) {
      const r = await run('bitbucket_add_pr_comment', { workspace, repoSlug: slug, prId: id, text, ...(inline && { inline }) });
      return { id: Number(r?.id) };
    },

    // workbench hands out https://x-token-auth:<token>@bitbucket.org/<ws>/<slug>.git, good for ≤2h; never log or persist it
    async cloneToken({ workspace, slug }) {
      const r = await run('bitbucket_get_clone_url', { workspace, repoSlug: slug });
      const token = tokenFromCloneUrl(String((typeof r === 'string' ? r : (r?.url ?? r?.cloneUrl ?? r?.clone_url)) ?? ''));
      if (!token) throw new Error('workbench sent an unexpected clone URL');
      return token;
    },

    async searchUsers(workspace, query) {
      const r = await run('bitbucket_search_users', { workspace, query, pagelen: 20 });
      return (r?.users ?? []).map((u: any) => ({ name: String(u.display_name ?? ''), uuid: String(u.uuid ?? '') })).filter((u: { uuid: string }) => u.uuid);
    },
  };
}
