import { Hono } from 'hono';
import type { WorkItem } from '../../shared/types.ts';
import { type Deps, type Env } from '../http.ts';
import { isOwner } from '../owners.ts';

export type TeamWorkItem = WorkItem & { owner: { id: string; name: string | null; email: string | null } };

export function teamRoutes(deps: Deps) {
  const { workItems, users } = deps;
  const routes = new Hono<Env>();

  // the local account (sign-in off) has no user row, so its name stays unknown
  const identity = (owner: string) => {
    const user = users?.get(owner);
    return { id: owner, name: user?.name ?? null, email: user?.email ?? null };
  };

  const view = (owner: string, ticket: string): TeamWorkItem => {
    const item = workItems.get(owner, ticket)!;
    return {
      ticket,
      source: item.source,
      plan: item.plan,
      repos: workItems.repos(owner, ticket),
      links: workItems.links(owner, ticket),
      note: item.note,
      status: item.status,
      routing: workItems.routingView(owner, ticket),
      owner: identity(owner),
    };
  };

  routes.get('/api/team/work-items', (c) => {
    if (users && !isOwner(users.get(c.get('uid')))) return c.json({ error: 'only owners can see the team board' }, 403);
    return c.json({ items: workItems.all().map((item) => view(item.owner, item.ticket)) });
  });

  return routes;
}
