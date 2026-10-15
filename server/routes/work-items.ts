import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { WorkItem } from '../../shared/types.ts';
import { syncWorkItem } from '../jira-sync.ts';
import { parseRepo } from '../workspace.ts';
import { HttpError, TICKET_RE, parse, readBody, requireMyRepo, requireWorkbench, text, upstream, type Deps, type Env } from '../http.ts';

const reposSchema = z.object({
  repos: z.custom<string[]>((r) => Array.isArray(r) && r.length > 0 && r.length <= 25 && r.every((x) => typeof x === 'string' && !!parseRepo(x)), 'repos must list 1–25 workspace/repo names'),
});
const linkSchema = z.object({
  repo: text().refine((r) => !!parseRepo(r), 'repo must look like workspace/repo'),
  prId: z.coerce.number().int().positive('invalid prId').catch(0).refine((n) => n > 0, 'invalid prId'),
  kind: z.enum(['spec', 'impl'], { error: 'kind must be spec or impl' }),
});

const ticketOf = (c: Context) => {
  const t = c.req.param('ticket')!.toUpperCase();
  if (!TICKET_RE.test(t)) throw new HttpError(400, 'ticket must look like PROJ-123');
  return t;
};
const repoOf = (c: Context) => `${c.req.param('ws')}/${c.req.param('slug')}`;

export function workItemsRoutes(deps: Deps) {
  const { workItems, myRepos } = deps;
  const routes = new Hono<Env>();

  const view = (owner: string, ticket: string): WorkItem => {
    const item = workItems.get(owner, ticket);
    if (!item) throw new HttpError(404, 'no work item for this ticket');
    return { ticket, repos: workItems.repos(owner, ticket), links: workItems.links(owner, ticket), events: workItems.events(owner, ticket), status: item.status };
  };

  // Every work item with its repos and links, for the Jira cards.
  routes.get('/api/work-items', (c) => {
    const uid = c.get('uid');
    return c.json({ items: workItems.list(uid).map((t) => ({ ...view(uid, t), events: [] })) });
  });

  routes.get('/api/work-items/:ticket', (c) => c.json(view(c.get('uid'), ticketOf(c))));

  routes.post('/api/work-items/:ticket', async (c) => {
    const uid = c.get('uid');
    const ticket = ticketOf(c);
    const { repos } = parse(reposSchema, await readBody(c));
    for (const r of repos) requireMyRepo(deps, uid, r);
    workItems.create(uid, ticket);
    for (const r of repos) workItems.addRepo(uid, ticket, myRepos.get(uid, r)!.name);
    return c.json(view(uid, ticket));
  });

  routes.delete('/api/work-items/:ticket/repos/:ws/:slug', (c) => {
    const uid = c.get('uid');
    const ticket = ticketOf(c);
    const repo = repoOf(c);
    if (workItems.links(uid, ticket).some((l) => l.repo.toLowerCase() === repo.toLowerCase())) throw new HttpError(409, `${repo} already has PRs linked to ${ticket}`);
    workItems.removeRepo(uid, ticket, repo);
    return c.body(null, 204);
  });

  // An existing PR, linked by hand: it must exist and carry the key in its title or branch.
  routes.post('/api/work-items/:ticket/links', async (c) => {
    const uid = c.get('uid');
    const ticket = ticketOf(c);
    const { repo, prId, kind } = parse(linkSchema, await readBody(c));
    view(uid, ticket);
    requireMyRepo(deps, uid, repo);
    if (!workItems.hasRepo(uid, ticket, repo)) throw new HttpError(409, `add ${repo} to ${ticket}'s work item first`, { needWorkItem: true });
    const wb = await requireWorkbench(deps, uid);
    const ref = parseRepo(repo)!;
    const pr = await upstream(wb.client.bitbucketPr(wb.token, ref.workspace, ref.slug, prId));
    const hit = new RegExp(`(^|[^A-Z0-9])${ticket}([^0-9]|$)`, 'i');
    if (!hit.test(pr.title) && !hit.test(pr.source)) throw new HttpError(400, `${repo} #${prId} doesn't mention ${ticket} in its title or branch`);
    workItems.link(uid, ticket, { repo, kind, prId, branch: pr.source, title: pr.title, state: pr.state, source: 'manual', runId: null });
    return c.json(view(uid, ticket), 201);
  });

  routes.delete('/api/work-items/:ticket/links/:ws/:slug/:prId', (c) => {
    const uid = c.get('uid');
    const ticket = ticketOf(c);
    const repo = repoOf(c);
    const link = workItems.links(uid, ticket).find((l) => l.repo.toLowerCase() === repo.toLowerCase() && l.prId === Number(c.req.param('prId')));
    if (!link) throw new HttpError(404, 'link not found');
    if (link.source !== 'manual') throw new HttpError(409, 'only links made by hand can be removed');
    workItems.unlink(uid, ticket, repo, link.prId);
    return c.body(null, 204);
  });

  routes.post('/api/work-items/:ticket/sync', async (c) => {
    const uid = c.get('uid');
    const ticket = ticketOf(c);
    view(uid, ticket);
    await requireWorkbench(deps, uid);
    await syncWorkItem(deps, uid, ticket);
    return c.json(view(uid, ticket));
  });

  return routes;
}
