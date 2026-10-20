import { Hono } from 'hono';
import { z } from 'zod';
import { isRole } from '../tenancy.ts';
import { HttpError, parse, readBody, text, type Deps, type Env } from '../http.ts';

const nameSchema = z.object({ name: text().refine((n) => !!n && n.length <= 64, 'name is required (max 64)') });
const switchSchema = z.object({ id: text() });
const memberSchema = z.object({
  user: text().refine((u) => !!u, 'user is required: a name or e-mail address'),
  role: z.custom<'owner' | 'member' | 'viewer'>(isRole, 'role must be owner, member or viewer'),
});

export function workspacesRoutes({ users, workspaces }: Deps) {
  const routes = new Hono<Env>();
  const teams = () => {
    if (!users) throw new HttpError(409, 'sign-in is off: there is only your personal workspace');
  };
  // Workspaces you don't belong to look like they don't exist.
  const mine = (uid: string, id: string) => {
    const role = workspaces.roleOf(id, uid);
    const ws = workspaces.get(id);
    if (!role || !ws) throw new HttpError(404, 'workspace not found');
    return { role, ws };
  };
  const manage = (uid: string, id: string) => {
    teams();
    const { role, ws } = mine(uid, id);
    if (ws.kind === 'personal') throw new HttpError(409, 'a personal workspace has just you; create a team workspace to share');
    if (role !== 'owner') throw new HttpError(403, 'only owners manage members');
  };

  routes.get('/api/workspaces', (c) => c.json({ active: c.get('ws'), workspaces: workspaces.list(c.get('uid')) }));

  routes.post('/api/workspaces', async (c) => {
    teams();
    const { name } = parse(nameSchema, await readBody(c));
    return c.json(workspaces.create(name, c.get('uid')), 201);
  });

  routes.post('/api/workspaces/active', async (c) => {
    const { id } = parse(switchSchema, await readBody(c));
    if (!workspaces.setActive(c.get('uid'), id)) throw new HttpError(404, 'workspace not found');
    return c.json({ ok: true });
  });

  routes.get('/api/workspaces/:id/members', (c) => {
    mine(c.get('uid'), c.req.param('id'));
    return c.json({ members: workspaces.members(c.req.param('id')) });
  });

  routes.put('/api/workspaces/:id/members', async (c) => {
    const id = c.req.param('id');
    manage(c.get('uid'), id);
    const { user, role } = parse(memberSchema, await readBody(c));
    const found = users!.find(user);
    if (!found.length) throw new HttpError(404, 'no such user: they must sign in once first');
    if (found.length > 1) throw new HttpError(409, 'that matches several users: use their e-mail address or exact name');
    if (!workspaces.setMember(id, found[0].id, role)) throw new HttpError(409, 'a workspace needs at least one owner');
    return c.json({ members: workspaces.members(id) });
  });

  routes.delete('/api/workspaces/:id/members/:userId', (c) => {
    const id = c.req.param('id');
    const target = c.req.param('userId');
    if (target === c.get('uid')) mine(c.get('uid'), id);
    else manage(c.get('uid'), id);
    if (workspaces.get(id)?.kind === 'personal') throw new HttpError(409, 'you cannot leave your personal workspace');
    if (!workspaces.removeMember(id, target)) throw new HttpError(409, 'a workspace needs at least one owner');
    return c.json({ members: workspaces.members(id) });
  });

  return routes;
}
