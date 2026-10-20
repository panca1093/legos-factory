import { Hono } from 'hono';
import { z } from 'zod';
import type { RunnerRef } from '../dispatcher.ts';
import { HttpError, parse, readBody, text, type Deps } from '../http.ts';

const pollSchema = z.object({
  capacity: z.number().int().min(0).max(64),
  running: z.array(z.string().max(64)).max(1000),
});
const reportSchema = z.object({ messages: z.array(z.custom<{ type: string }>((m) => !!m && typeof (m as { type?: unknown }).type === 'string')).max(500) });
const nameSchema = z.object({ name: text().refine((n) => !!n && n.length <= 64, 'name is required (max 64)') });

type RunnerEnv = { Variables: { runner: RunnerRef; ws: string } };

// What runners call (bearer token) and what owners call to mint and revoke those tokens.
export function runnerRoutes(deps: Deps) {
  const { runners, runs } = deps;
  const routes = new Hono<RunnerEnv>();

  routes.use('/runner/*', async (c, next) => {
    if (!deps.hostOk(c.req.header('host'))) return c.json({ error: 'forbidden host' }, 403);
    const who = runners.authenticate(c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]);
    if (!who) return c.json({ error: 'unknown runner token' }, 401);
    c.set('runner', { id: who.id, workspaceId: who.workspaceId, embedded: false });
    await next();
  });

  routes.post('/runner/poll', async (c) => {
    const req = parse(pollSchema, await readBody(c));
    return c.json(await runs.poll(c.get('runner'), req, deps.opts.pollWaitMs ?? 25_000));
  });

  routes.post('/runner/report', async (c) => {
    const { messages } = parse(reportSchema, await readBody(c));
    runs.report(c.get('runner'), messages as Parameters<typeof runs.report>[1]);
    return c.json({ ok: true });
  });

  routes.get('/api/runners', (c) => {
    const now = Date.now();
    return c.json({ runners: runners.list(c.get('ws')).map((r) => ({ ...r, online: !!r.lastSeenAt && now - Date.parse(r.lastSeenAt) < 90_000 })) });
  });

  routes.post('/api/runners', async (c) => {
    const { name } = parse(nameSchema, await readBody(c));
    return c.json(runners.create(c.get('ws'), name), 201);
  });

  routes.delete('/api/runners/:id', (c) => {
    const id = c.req.param('id');
    if (!runners.revoke(c.get('ws'), id)) throw new HttpError(404, 'runner not found');
    runs.reap(id);
    return c.json({ ok: true });
  });

  return routes;
}
