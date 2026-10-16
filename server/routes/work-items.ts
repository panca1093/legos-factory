import { Hono } from 'hono';
import { z } from 'zod';
import type { WorkItem } from '../../shared/types.ts';
import { parseRepo } from '../workspace.ts';
import { HttpError, TICKET_RE, parse, readBody, requireMyRepo, type Deps, type Env } from '../http.ts';

const reposSchema = z.object({
  repos: z.custom<string[]>((r) => Array.isArray(r) && r.length <= 25 && r.every((x) => typeof x === 'string' && !!parseRepo(x)), 'repos must list at most 25 workspace/repo names'),
});

export function workItemsRoutes(deps: Deps) {
  const { workItems, myRepos } = deps;
  const routes = new Hono<Env>();

  const view = (owner: string, ticket: string): WorkItem => {
    const item = workItems.get(owner, ticket)!;
    return { ticket, repos: workItems.repos(owner, ticket), links: workItems.links(owner, ticket), note: item.note, status: item.status };
  };

  routes.get('/api/work-items', (c) => {
    const uid = c.get('uid');
    return c.json({ items: workItems.list(uid).map((t) => view(uid, t)) });
  });

  routes.put('/api/work-items/:ticket', async (c) => {
    const uid = c.get('uid');
    const ticket = c.req.param('ticket').toUpperCase();
    if (!TICKET_RE.test(ticket)) throw new HttpError(400, 'ticket must look like PROJ-123');
    const { repos } = parse(reposSchema, await readBody(c));
    if (!repos.length && !workItems.get(uid, ticket)) throw new HttpError(400, 'repos required: pick at least 1');
    for (const r of repos) requireMyRepo(deps, uid, r);
    const wanted = new Set(repos.map((r) => myRepos.get(uid, r)!.name.toLowerCase()));
    const dropped = workItems.repos(uid, ticket).filter((r) => !wanted.has(r.name.toLowerCase()));
    for (const r of dropped) {
      if (workItems.links(uid, ticket).some((l) => l.repo.toLowerCase() === r.name.toLowerCase())) throw new HttpError(409, `${r.name} already has PRs linked to ${ticket}`);
    }
    workItems.create(uid, ticket);
    for (const r of dropped) workItems.removeRepo(uid, ticket, r.name);
    for (const r of repos) workItems.addRepo(uid, ticket, myRepos.get(uid, r)!.name);
    return c.json(view(uid, ticket));
  });

  return routes;
}
