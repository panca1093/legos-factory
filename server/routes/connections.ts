import { Hono } from 'hono';
import { z } from 'zod';
import type { ConnAuth, ConnKind } from '../connections.ts';
import { domain, gitToken, parse, readBody, requireMyRepo, text, type Deps, type Env } from '../http.ts';
import { parseRepo } from '../workspace.ts';

// Headers worth passing between Claude Code and workbench on the MCP proxy.
const MCP_REQ_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const MCP_RES_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];

// kind and auth are checked by Connections.add
const newConnSchema = z.object({
  name: text(),
  kind: z.custom<ConnKind>().optional(),
  url: text(),
  auth: z.custom<ConnAuth>().optional(),
  headers: z
    .custom<Record<string, string>>((h) => !!h && typeof h === 'object')
    .optional()
    .catch(undefined),
});

export function connectionsRoutes(deps: Deps) {
  const { runs, connsFor, grants, http, hostOk } = deps;
  const routes = new Hono<Env>();

  // git's credential helper in a run's clone asks here each time; every answer is a freshly minted token for that run's own repo.
  routes.get('/git/credential', async (c) => {
    if (!hostOk(c.req.header('host'))) return c.text('forbidden host', 403);
    const run = runs.get(grants.get(c.req.header('x-legos-run') ?? '') ?? '');
    if (!run) return c.json({ error: 'unknown run' }, 403);
    const repo = run.repo && parseRepo(run.repo);
    if (!repo) return c.json({ error: 'run has no repo' }, 403);
    requireMyRepo(deps, run.workspaceId, run.repo!);
    const token = await gitToken(deps, run.workspaceId, repo);
    return c.text(`username=x-token-auth\npassword=${token}\n`, 200, { 'cache-control': 'no-store' });
  });

  // Claude Code processes reach Settings connections through here; credentials are attached fresh on every request.
  routes.all('/mcp/:name', async (c) => {
    if (!hostOk(c.req.header('host'))) return c.text('forbidden host', 403);
    const workspaceId = runs.get(grants.get(c.req.header('x-legos-run') ?? '') ?? '')?.workspaceId;
    if (workspaceId === undefined) return c.json({ error: 'unknown run' }, 403);
    const conns = connsFor(workspaceId);
    const name = c.req.param('name');
    const [url, creds] = await Promise.all([conns.url(name), conns.headersFor(name)]);
    if (!url) return c.json({ error: 'unknown connection' }, 404);
    if (!creds) return c.json({ error: `${name} needs connecting in Settings` }, 401);
    const headers = new Headers(creds);
    for (const h of MCP_REQ_HEADERS) {
      const v = c.req.header(h);
      if (v) headers.set(h, v);
    }
    const method = c.req.method;
    const upstream = await http(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer(),
    });
    const out = new Headers();
    for (const h of MCP_RES_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });

  routes.get('/api/connections', async (c) => c.json({ connections: await connsFor(c.get('ws')).all() }));

  routes.post('/api/connections', async (c) => {
    const b = parse(newConnSchema, await readBody(c));
    return c.json(await domain(connsFor(c.get('ws')).add({ name: b.name, kind: b.kind as ConnKind, url: b.url, auth: b.auth as ConnAuth, headers: b.headers })), 201);
  });

  routes.delete('/api/connections/:name', async (c) => {
    await domain(connsFor(c.get('ws')).remove(c.req.param('name')));
    return c.json({ ok: true });
  });

  routes.post('/api/connections/:name/connect', async (c) => {
    return c.json({ url: await domain(connsFor(c.get('ws')).startOAuth(c.req.param('name'))) });
  });

  routes.post('/api/connections/:name/disconnect', async (c) => {
    await domain(connsFor(c.get('ws')).disconnect(c.req.param('name')));
    return c.json({ ok: true });
  });

  return routes;
}
