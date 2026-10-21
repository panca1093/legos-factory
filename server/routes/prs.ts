import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { parseRepo, type RepoRef } from '../workspace.ts';
import type { Forge, Pr, PrRow } from '../ports.ts';
import { BRANCH_RE, HttpError, TICKET_RE, errMsg, parse, readBody, requireForge, requireMyRepo, requireWorkbench, text, upstream, type Deps, type Env, type WorkbenchClient } from '../http.ts';

// Review requests scan this many recently updated open PRs (each costs a get_pr and a comments call)
const REVIEW_SCAN = 40;
const REVIEW_TTL_MS = 5 * 60_000;

export type ReviewRequest = PrRow & { reviewers: Pr['reviewers']; approvedByMe: boolean; why: ('reviewer' | 'mentioned')[]; comments: number; url: string | null };

const ticketPrsQuery = z.object({
  ticket: text()
    .transform((t) => t.toUpperCase())
    .refine((t) => TICKET_RE.test(t), 'ticket must look like PROJ-123'),
});
const commentSchema = z.object({
  text: text().refine((t) => !!t && t.length <= 10_000, 'text is required (at most 10,000 characters)'),
  replyTo: z
    .unknown()
    .optional()
    .transform((v) => (v === undefined || v === null ? null : Number(v)))
    .refine((n) => n === null || Number.isInteger(n), 'invalid replyTo'),
});
const fixesSchema = z.object({
  commentIds: z.custom<number[]>((ids) => Array.isArray(ids) && ids.length > 0 && ids.length <= 50 && ids.every(Number.isInteger), 'commentIds must list 1–50 comment ids'),
});
const noteSchema = z.object({ note: text() });
const reviewsQuery = z.object({ as: text().transform((s) => s.slice(0, 100)) });

const prRef = (c: Context) => {
  const repo = parseRepo(`${c.req.param('ws')}/${c.req.param('slug')}`);
  const id = Number(c.req.param('id'));
  if (!repo || !Number.isInteger(id) || id <= 0) throw new HttpError(400, 'invalid pull request');
  return { ...repo, id };
};

export function prsRoutes(deps: Deps) {
  const { fixes } = deps;
  const routes = new Hono<Env>();
  const reviewCache = new Map<string, { at: number; body: object }>();
  const myRepoRefs = (ws: string) => deps.myRepos.list(ws).map((r) => parseRepo(r.name)).filter((r) => r !== null);
  const myPr = (c: Context<Env>) => {
    const ref = prRef(c);
    requireMyRepo(deps, c.get('ws'), `${ref.workspace}/${ref.slug}`);
    return ref;
  };

  // PRs for a ticket: its key in the source branch or title, looked up in my repos. The forge API can't search across repos.
  routes.get('/api/prs', async (c) => {
    const { ticket } = parse(ticketPrsQuery, c.req.query());
    const forge = await requireForge(deps, c.get('ws'));
    const repos = myRepoRefs(c.get('ws'));
    const hit = new RegExp(`(^|[^A-Z0-9])${ticket}([^0-9]|$)`, 'i');
    const prs = await upstream(
      Promise.all(repos.flatMap((r) => (['OPEN', 'MERGED'] as const).map((st) => forge.listPrs(r, st, st === 'OPEN' ? 50 : 30)))).then((found) =>
        found
          .flat()
          .filter((p) => hit.test(p.source) || hit.test(p.title))
          .sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || (b.updated ?? '').localeCompare(a.updated ?? '')),
      ),
    );
    return c.json({ prs, searched: repos.map((r) => `${r.workspace}/${r.slug}`) });
  });

  routes.get('/api/prs/:ws/:slug/:id', async (c) => {
    const ref = myPr(c);
    const forge = await requireForge(deps, c.get('ws'));
    const [pr, files, comments] = await upstream(Promise.all([forge.getPr(ref, ref.id), forge.files(ref, ref.id), forge.comments(ref, ref.id)]));
    return c.json({ pr, files, comments });
  });

  routes.get('/api/prs/:ws/:slug/:id/diff', async (c) => {
    const ref = myPr(c);
    const forge = await requireForge(deps, c.get('ws'));
    return c.json(await upstream(forge.diff(ref, ref.id)));
  });

  // Reply to a review comment, or post a general one. A reply lands on the same line, quoting the original.
  routes.post('/api/prs/:ws/:slug/:id/comments', async (c) => {
    const ref = myPr(c);
    const { text, replyTo } = parse(commentSchema, await readBody(c));
    const forge = await requireForge(deps, c.get('ws'));
    const comment = await upstream(postComment(forge, ref, text, replyTo));
    return c.json(comment, 201);
  });

  // Ask factory: work through the chosen comments one at a time (see pr-fixes.ts)
  routes.get('/api/prs/:ws/:slug/:id/fixes', (c) => {
    const ref = myPr(c);
    return c.json({ queue: fixes.forPr(c.get('ws'), `${ref.workspace}/${ref.slug}`, ref.id) });
  });

  routes.post('/api/prs/:ws/:slug/:id/fixes', async (c) => {
    const ref = myPr(c);
    if (!deps.embedded) throw new HttpError(409, 'Ask factory works in a checkout on this machine: it needs the runner inside this app');
    const { commentIds } = parse(fixesSchema, await readBody(c));
    const forge = await requireForge(deps, c.get('ws'));
    const queue = await upstream(
      startFixes(deps, { uid: c.get('uid'), ws: c.get('ws') }, forge, ref, commentIds).catch((err) => {
        // FixQueues says 409 when the factory is already on this PR
        throw (err as { status?: number })?.status === 409 ? new HttpError(409, errMsg(err)) : err;
      }),
    );
    return c.json(queue, 201);
  });

  const myQueue = (c: Context<Env>) => {
    const q = fixes.get(c.req.param('id')!);
    if (!q || q.workspaceId !== c.get('ws')) throw new HttpError(404, 'fix queue not found');
    return q;
  };
  for (const action of ['approve', 'skip', 'retry'] as const) {
    routes.post(`/api/fixes/:id/items/:cid/${action}`, async (c) => {
      const q = myQueue(c);
      const cid = Number(c.req.param('cid'));
      const { note } = parse(noteSchema, await readBody(c));
      const ok = action === 'approve' ? fixes.approve(q.id, cid, note) : action === 'skip' ? fixes.skip(q.id, cid) : fixes.retry(q.id, cid);
      if (!ok) throw new HttpError(409, `that comment can't be ${action === 'approve' ? 'approved' : action === 'skip' ? 'skipped' : 'retried'} now`);
      return c.json(q);
    });
  }

  routes.post('/api/fixes/:id/cancel', async (c) => {
    const q = myQueue(c);
    if (!(await fixes.cancel(q.id))) throw new HttpError(409, 'the queue has already finished');
    return c.json(q);
  });

  routes.get('/api/reviews', async (c) => {
    const ws = c.get('ws');
    const wb = await requireWorkbench(deps, ws);
    const forge = await requireForge(deps, ws);
    const { as } = parse(reviewsQuery, c.req.query());
    const repos = myRepoRefs(ws);
    if (!repos.length) throw new HttpError(409, 'add the repos you review in Settings', { needRepos: true });
    const key = `${ws}|${as}|${repos.map((r) => `${r.workspace}/${r.slug}`).join(',')}`;
    const hit = reviewCache.get(key);
    if (hit && Date.now() - hit.at < REVIEW_TTL_MS && c.req.query('refresh') !== '1') return c.json(hit.body);
    const body = await upstream(reviewRequests(wb, forge, repos, as));
    reviewCache.set(key, { at: Date.now(), body });
    return c.json(body);
  });

  return routes;
}

// Open PRs that want you: you're a reviewer, or someone @-mentioned you in a comment. The forge can't search
// for that, so scan the latest open PRs of my repos. You are matched by Bitbucket user id when your name
// resolves to one (looked up in the first repo's workspace), else by display name.
async function reviewRequests(wb: WorkbenchClient, forge: Forge, repos: RepoRef[], as: string) {
  const me = as ? null : await wb.client.whoami(wb.token);
  const name = (as.includes('@') ? nameFromEmail(as) : as) || (me?.name ?? '').trim() || nameFromEmail(me?.email);
  if (!name) throw new HttpError(400, 'set your Bitbucket name to match review requests', { needName: true });
  const norm = (x: string | null) => (x ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const same = (a: string | null) => norm(a) === norm(name);
  const uuid = (await forge.searchUsers(repos[0].workspace, name).catch(() => [])).find((u) => same(u.name))?.uuid ?? null;
  const isMe = (r: { name: string; uuid: string | null }) => (uuid && r.uuid ? r.uuid === uuid : same(r.name));
  const bareUuid = uuid?.replace(/[{}]/g, '');
  const mention = new RegExp(`@\\{?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')}`, 'i');
  const open = (await pool(repos, 6, (r) => forge.listPrs(r, 'OPEN', 50)))
    .flat()
    .filter((p) => !same(p.author))
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
    .slice(0, REVIEW_SCAN);
  const failed: string[] = [];
  const rows = await pool(open, 6, async (p): Promise<ReviewRequest | null> => {
    const [workspace, slug] = p.repo.split('/');
    const read = await Promise.all([forge.getPr({ workspace, slug }, p.id), forge.comments({ workspace, slug }, p.id)]).catch(() => null);
    if (!read) return (failed.push(`${p.repo}#${p.id}`), null);
    const [pr, comments] = read;
    const mine = pr.reviewers.find(isMe);
    const why: ReviewRequest['why'] = [];
    if (mine) why.push('reviewer');
    if (comments.some((x) => !same(x.author) && (mention.test(x.text) || (!!bareUuid && x.text.includes(bareUuid))))) why.push('mentioned');
    return why.length ? { ...p, reviewers: pr.reviewers, approvedByMe: mine?.approved === true, why, comments: comments.length, url: pr.url } : null;
  });
  return { me: name, matchedById: !!uuid, items: rows.filter((r) => r !== null), failed, searched: repos.map((r) => `${r.workspace}/${r.slug}`), scanned: open.length, at: new Date().toISOString() };
}

// workbench's whoami has no display name; "jane.doe+x@acme.com" -> "Jane Doe", which is usually the Bitbucket name
export function nameFromEmail(email: string | null | undefined): string {
  const local = (email ?? '').split('@')[0].split('+')[0];
  return local
    .split(/[._-]+/)
    .filter((w) => w && !/^\d+$/.test(w))
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Runs fn over items, at most `limit` at a time, keeping order.
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

type PrRef = ReturnType<typeof prRef>;

async function postComment(forge: Forge, ref: PrRef, text: string, replyTo: number | null) {
  let inline: { path: string; line: number } | undefined;
  let full = text;
  if (replyTo !== null) {
    const parent = (await forge.comments(ref, ref.id)).find((x) => x.id === replyTo);
    if (!parent) throw new HttpError(404, 'comment not found');
    if (parent.path && parent.line) inline = { path: parent.path, line: parent.line };
    const quoted = parent.text.split('\n').slice(0, 4).map((l) => `> ${l}`).join('\n');
    full = `${parent.author ? `> **${parent.author}:**\n` : ''}${quoted}\n\n${text}`;
  }
  return forge.addComment(ref, ref.id, full, inline);
}

async function startFixes({ fixes, workItems }: Deps, who: { uid: string; ws: string }, forge: Forge, ref: PrRef, commentIds: number[]) {
  const [pr, comments] = await Promise.all([forge.getPr(ref, ref.id), forge.comments(ref, ref.id)]);
  if (pr.state !== 'OPEN') throw new HttpError(409, 'only an open PR can take fixes');
  if (!BRANCH_RE.test(pr.source)) throw new HttpError(409, 'the PR branch name is not usable');
  const picked = [...new Set(commentIds)].map((id) => comments.find((x) => x.id === id));
  if (picked.some((x) => !x)) throw new HttpError(404, 'comment not found');
  return fixes.create({
    workspaceId: who.ws,
    owner: who.uid,
    repo: `${ref.workspace}/${ref.slug}`,
    prId: ref.id,
    branch: pr.source,
    ticket: workItems.ticketForPr(who.ws, `${ref.workspace}/${ref.slug}`, ref.id),
    comments: picked.map((x) => ({ commentId: x!.id, author: x!.author, text: x!.text, path: x!.path, line: x!.line })),
  });
}
