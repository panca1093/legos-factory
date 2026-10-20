import { Hono } from 'hono';
import { z } from 'zod';
import type { WorkItem } from '../../shared/types.ts';
import { parseRepo } from '../workspace.ts';
import { HttpError, TICKET_RE, parse, readBody, requireMyRepo, requireWorkbench, upstream, type Deps, type Env } from '../http.ts';

const reposSchema = z.object({
  repos: z.custom<string[]>((r) => Array.isArray(r) && r.length <= 25 && r.every((x) => typeof x === 'string' && !!parseRepo(x)), 'repos must list at most 25 workspace/repo names'),
});

const linkSchema = z.object({
  repo: z.string().refine((r) => !!parseRepo(r), 'repo must look like workspace/repo'),
  prId: z.number().int().positive(),
  kind: z.enum(['spec', 'impl']),
});

export function workItemsRoutes(deps: Deps) {
  const { workItems, myRepos } = deps;
  const routes = new Hono<Env>();

  const view = (owner: string, ticket: string): WorkItem => {
    const item = workItems.get(owner, ticket)!;
    return { ticket, repos: workItems.repos(owner, ticket), links: workItems.links(owner, ticket), note: item.note, status: item.status };
  };

  routes.get('/api/work-items', (c) => {
    const ws = c.get('ws');
    return c.json({ items: workItems.list(ws).map((t) => view(ws, t)) });
  });

  routes.put('/api/work-items/:ticket', async (c) => {
    const ws = c.get('ws');
    const ticket = c.req.param('ticket').toUpperCase();
    if (!TICKET_RE.test(ticket)) throw new HttpError(400, 'ticket must look like PROJ-123');
    const { repos } = parse(reposSchema, await readBody(c));
    if (!repos.length && !workItems.get(ws, ticket)) throw new HttpError(400, 'repos required: pick at least 1');
    for (const r of repos) requireMyRepo(deps, ws, r);
    const wanted = new Set(repos.map((r) => myRepos.get(ws, r)!.name.toLowerCase()));
    const dropped = workItems.repos(ws, ticket).filter((r) => !wanted.has(r.name.toLowerCase()));
    for (const r of dropped) {
      if (workItems.links(ws, ticket).some((l) => l.repo.toLowerCase() === r.name.toLowerCase())) throw new HttpError(409, `${r.name} already has PRs linked to ${ticket}`);
    }
    workItems.create(ws, ticket);
    for (const r of dropped) workItems.removeRepo(ws, ticket, r.name);
    for (const r of repos) workItems.addRepo(ws, ticket, myRepos.get(ws, r)!.name);
    return c.json(view(ws, ticket));
  });

  routes.post('/api/work-items/:ticket/links', async (c) => {
    const ws = c.get('ws');
    const ticket = c.req.param('ticket').toUpperCase();
    if (!TICKET_RE.test(ticket)) throw new HttpError(400, 'ticket must look like PROJ-123');
    const { repo, prId, kind } = parse(linkSchema, await readBody(c));
    if (!workItems.get(ws, ticket)) throw new HttpError(404, 'work item not found');
    requireMyRepo(deps, ws, repo);
    const name = myRepos.get(ws, repo)!.name;
    if (!workItems.hasRepo(ws, ticket, name)) throw new HttpError(409, `add ${name} to ${ticket} first`, { needWorkItem: true });
    const ref = parseRepo(name)!;
    const wb = await requireWorkbench(deps, ws);
    const pr = await upstream(wb.client.bitbucketPr(wb.token, ref.workspace, ref.slug, prId));
    const hit = new RegExp(`(^|[^A-Z0-9])${ticket}([^0-9]|$)`, 'i');
    if (!hit.test(pr.source) && !hit.test(pr.title)) throw new HttpError(400, `that PR does not mention ${ticket}`);
    workItems.link(ws, ticket, { repo: name, kind, prId, branch: pr.source, title: pr.title, state: pr.state, runId: null }, true);
    return c.json(view(ws, ticket));
  });

  return routes;
}
