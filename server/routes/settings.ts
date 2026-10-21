import { Hono } from 'hono';
import { parse, readBody, type Env } from '../http.ts';
import { automationSchema, loadSettings, saveAutomation } from '../policy.ts';

export function settingsRoutes() {
  const routes = new Hono<Env>();
  routes.get('/api/settings/automation', async (c) => c.json((await loadSettings()).automation));
  routes.put('/api/settings/automation', async (c) => {
    const automation = parse(automationSchema, await readBody(c));
    await saveAutomation(automation);
    return c.json(automation);
  });
  return routes;
}
