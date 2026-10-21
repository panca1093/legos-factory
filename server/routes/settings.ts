import { Hono } from 'hono';
import { parse, readBody, type Deps, type Env } from '../http.ts';
import { isOwner } from '../owners.ts';
import { automationSchema, loadSettings, saveAutomation } from '../policy.ts';

export function settingsRoutes({ users }: Pick<Deps, 'users'>) {
  const routes = new Hono<Env>();
  routes.get('/api/settings/automation', async (c) => c.json((await loadSettings()).automation));
  routes.put('/api/settings/automation', async (c) => {
    if (users && !isOwner(users.get(c.get('uid')))) return c.json({ error: 'only owners can change automation' }, 403);
    const automation = parse(automationSchema, await readBody(c));
    await saveAutomation(automation);
    return c.json(automation);
  });
  return routes;
}
