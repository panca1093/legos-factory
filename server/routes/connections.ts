import { Hono } from 'hono';
import { z } from 'zod';
import type { ConnAuth, ConnKind } from '../connections.ts';
import { domain, localOnly, parse, readBody, text, type Deps, type Env } from '../http.ts';

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

export function connectionsRoutes({ runs, connsFor, grants, http }: Deps) {
  const routes = new Hono<Env>();

  // Claude Code processes reach Settings connections through here; credentials are attached fresh on every request.
  routes.all('/mcp/:name', async (c) => {
    if (!localOnly(c.req.header('host'))) return c.text('forbidden host', 403);
    const owner = runs.get(grants.get(c.req.header('x-legos-run') ?? '') ?? '')?.owner;
    if (owner === undefined) return c.json({ error: 'unknown run' }, 403);
    const conns = connsFor(owner);
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

  routes.get('/api/connections', async (c) => c.json({ connections: await connsFor(c.get('uid')).all() }));

  routes.post('/api/connections', async (c) => {
    const b = parse(newConnSchema, await readBody(c));
    return c.json(await domain(connsFor(c.get('uid')).add({ name: b.name, kind: b.kind as ConnKind, url: b.url, auth: b.auth as ConnAuth, headers: b.headers })), 201);
  });

  routes.delete('/api/connections/:name', async (c) => {
    await domain(connsFor(c.get('uid')).remove(c.req.param('name')));
    return c.json({ ok: true });
  });

  routes.post('/api/connections/:name/connect', async (c) => {
    return c.json({ url: await domain(connsFor(c.get('uid')).startOAuth(c.req.param('name'))) });
  });

  routes.post('/api/connections/:name/disconnect', async (c) => {
    await domain(connsFor(c.get('uid')).disconnect(c.req.param('name')));
    return c.json({ ok: true });
  });

  return routes;
}
