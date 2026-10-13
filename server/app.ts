import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import type { DecisionAnswer, PermissionMode, SessionSummary, Settings, ShareLevel, StreamMessage } from '../shared/types.ts';
import { getSession, listSessions } from './claude-sessions.ts';
import { detectTicket, gitBranch, loadSettings, settingsPath, shareFor } from './policy.ts';
import { type ActivityLog, toTeamItem } from './activity.ts';
import { PIN_RE, type Account } from './account.ts';
import type { RunManager } from './claude-runs.ts';
import type { Connections } from './connections.ts';
import { Workbench } from './workbench.ts';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan'];
// aliases (opus, sonnet) or full ids incl. suffixes like [1m]; validated by the CLI itself
const MODEL_RE = /^[\w.\-\[\]]{1,64}$/;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const SHARES: ShareLevel[] = ['private', 'status', 'full'];
const TICKET_RE = /^[A-Z][A-Z0-9]+-\d+$/;

const annotate = <T extends SessionSummary>(s: T, settings: Settings): T => ({
  ...s,
  ticket: detectTicket(s.title, settings.ticketKeys) ?? detectTicket(s.gitBranch, settings.ticketKeys),
  share: shareFor(s.cwd, settings),
});

const SID_COOKIE = 'lf_sid';
const page = (title: string, body: string, close = false) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:14px system-ui;padding:40px;color:#151a29;text-align:center"><h2>${title}</h2><p>${body}</p><p><a href="/#/settings">Open Settings</a></p>${close ? '<script>setTimeout(()=>window.close(),800)</script>' : ''}</body>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Headers worth passing between Claude Code and workbench on the MCP proxy.
const MCP_REQ_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const MCP_RES_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];

export type AppOptions = {
  // null = no PIN gate (LEGOS_AUTH=off)
  account?: Account | null;
  connections?: Connections | null;
  selfUrl?: string;
  fetch?: typeof fetch;
  activity?: ActivityLog | null;
  // team hub base URL; unset = no team activity
  hubUrl?: string | null;
};

const JQL_PRESETS: Record<string, string> = {
  mine: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
  sprint: 'assignee = currentUser() AND sprint in openSprints() ORDER BY status ASC, updated DESC',
};

const errStatus = (err: unknown) => {
  const s = (err as { status?: number })?.status;
  return (s && s >= 400 && s < 500 ? s : 502) as 400 | 404 | 409 | 502;
};
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createApp(runs: RunManager, opts: AppOptions = {}) {
  const app = new Hono();
  const account = opts.account ?? null;
  const conns = opts.connections ?? null;
  // per-run secret -> run, so only runs launched here reach the connections proxy
  const grants = new Map<string, string>();
  const http = opts.fetch ?? fetch;
  const clients = new Map<string, Workbench>();
  // the connected workbench, if any: apps, Jira and the team hub go through it
  const workbench = async () => {
    const wb = await conns?.workbench();
    if (!wb) return null;
    if (!clients.has(wb.url)) clients.set(wb.url, new Workbench(wb.url, http));
    return { client: clients.get(wb.url)!, token: wb.token };
  };
  runs.on('message', (m: StreamMessage) => {
    if (m.type !== 'run') return;
    if (m.run.endedAt) for (const [k, runId] of grants) if (runId === m.run.id) grants.delete(k);
    void opts.activity
      ?.record(m.run)
      .then(async (item) => {
        if (!item || item.share === 'private' || !opts.hubUrl) return;
        const wb = await workbench();
        if (!wb) return;
        const res = await http(`${opts.hubUrl}/hub/events`, {
          method: 'POST',
          headers: { authorization: `Bearer ${wb.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ items: [toTeamItem(item)] }),
        });
        if (!res.ok) console.warn(`hub rejected status update (HTTP ${res.status})`);
      })
      .catch((err) => console.warn('activity update failed:', err.message));
  });

  const localOnly = (host: string | undefined) => LOCAL_HOSTS.has((host ?? '').replace(/:\d+$/, ''));

  // Launching a run is code execution: block DNS rebinding (Host) and cross-site POSTs (custom header forces CORS preflight).
  app.use('/api/*', async (c, next) => {
    if (!localOnly(c.req.header('host'))) return c.json({ error: 'forbidden host' }, 403);
    if (c.req.method !== 'GET' && c.req.header('x-legos') !== '1') return c.json({ error: 'missing x-legos header' }, 403);
    if (account && !(await account.verify(getCookie(c, SID_COOKIE)))) return c.json({ error: 'sign in required' }, 401);
    await next();
  });

  app.use('/auth/*', async (c, next) => {
    if (!localOnly(c.req.header('host'))) return c.text('forbidden host', 403);
    await next();
  });

  app.get('/auth/me', async (c) => {
    if (!account) return c.json({ authEnabled: false, setupRequired: false, authenticated: true, user: null });
    const name = await account.name();
    const ok = await account.verify(getCookie(c, SID_COOKIE));
    return c.json({ authEnabled: true, setupRequired: !name, authenticated: ok, user: ok ? { name } : null });
  });

  const signedIn = (c: any, cookie: string) => setCookie(c, SID_COOKIE, cookie, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 30 * 24 * 3600 });

  app.post('/auth/setup', async (c) => {
    if (c.req.header('x-legos') !== '1') return c.json({ error: 'missing x-legos header' }, 403);
    if (!account) return c.json({ error: 'sign-in is off' }, 409);
    const body = await c.req.json().catch(() => null);
    const name = str(body?.name);
    const pin = str(body?.pin);
    if (!name || name.length > 64) return c.json({ error: 'name is required (max 64)' }, 400);
    if (!PIN_RE.test(pin)) return c.json({ error: 'PIN must be 6 digits' }, 400);
    try {
      signedIn(c, await account.setup(name, pin));
    } catch (err) {
      return c.json({ error: errMsg(err) }, 409);
    }
    return c.json({ ok: true });
  });

  app.post('/auth/login', async (c) => {
    if (c.req.header('x-legos') !== '1') return c.json({ error: 'missing x-legos header' }, 403);
    if (!account) return c.json({ ok: true });
    const r = await account.login(str((await c.req.json().catch(() => null))?.pin));
    if (r.ok) {
      signedIn(c, r.cookie);
      return c.json({ ok: true });
    }
    if (r.retryAfterMs) return c.json({ error: `Too many wrong PINs — try again in ${Math.ceil(r.retryAfterMs / 1000)}s`, retryAfterMs: r.retryAfterMs }, 429);
    return c.json({ error: 'Wrong PIN' }, 401);
  });

  app.post('/auth/logout', async (c) => {
    if (c.req.header('x-legos') !== '1') return c.json({ error: 'missing x-legos header' }, 403);
    deleteCookie(c, SID_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // OAuth redirect for a connection. May land in another browser than the app (desktop panes open
  // links in the system browser), so it needs no app session: the one-time state is the proof.
  app.get('/auth/callback', async (c) => {
    if (!conns) return c.redirect('/');
    const { code, state, error, error_description } = c.req.query();
    if (error || !code || !state) return c.html(page('Connection was not completed', esc(error_description ?? error ?? 'missing code')), 400);
    try {
      const name = await conns.callback(code, state);
      return c.html(page(`Connected ${esc(name)}`, 'You can close this window and go back to legos-factory.', true));
    } catch (err) {
      return c.html(page('Connection failed', esc(errMsg(err))), 400);
    }
  });

  // Claude Code processes reach Settings connections through here; credentials are attached fresh on every request.
  app.all('/mcp/:name', async (c) => {
    if (!conns) return c.json({ error: 'connections disabled' }, 404);
    if (!localOnly(c.req.header('host'))) return c.text('forbidden host', 403);
    if (!grants.has(c.req.header('x-legos-run') ?? '')) return c.json({ error: 'unknown run' }, 403);
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

  app.get('/api/connections', async (c) => c.json({ connections: (await conns?.all()) ?? [] }));

  app.post('/api/connections', async (c) => {
    if (!conns) return c.json({ error: 'connections disabled' }, 404);
    const b = await c.req.json().catch(() => null);
    try {
      const headers = b?.headers && typeof b.headers === 'object' ? b.headers : undefined;
      return c.json(await conns.add({ name: str(b?.name), kind: b?.kind, url: str(b?.url), auth: b?.auth, headers }), 201);
    } catch (err) {
      return c.json({ error: errMsg(err) }, errStatus(err));
    }
  });

  app.delete('/api/connections/:name', async (c) => {
    try {
      await conns?.remove(c.req.param('name'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errMsg(err) }, errStatus(err));
    }
  });

  app.post('/api/connections/:name/connect', async (c) => {
    if (!conns) return c.json({ error: 'connections disabled' }, 404);
    try {
      return c.json({ url: await conns.startOAuth(c.req.param('name')) });
    } catch (err) {
      return c.json({ error: errMsg(err) }, errStatus(err));
    }
  });

  app.post('/api/connections/:name/disconnect', async (c) => {
    try {
      await conns?.disconnect(c.req.param('name'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errMsg(err) }, errStatus(err));
    }
  });

  app.get('/api/sessions', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 200) || 200, 1000);
    const active = runs.activeRunBySession();
    const [list, settings] = await Promise.all([listSessions(limit), loadSettings()]);
    return c.json(list.map((s) => ({ ...annotate(s, settings), activeRunId: active.get(s.id) ?? null })));
  });

  app.get('/api/sessions/:id', async (c) => {
    const s = await getSession(c.req.param('id'));
    if (!s) return c.json({ error: 'session not found' }, 404);
    return c.json({ ...annotate(s, await loadSettings()), activeRunId: runs.activeRunBySession().get(s.id) ?? null });
  });

  app.get('/api/runs/:id', (c) => {
    const r = runs.get(c.req.param('id'));
    return r ? c.json(r) : c.json({ error: 'run not found' }, 404);
  });

  app.post('/api/runs', async (c) => {
    const body = await c.req.json().catch(() => null);
    const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : '';
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    const permissionMode: PermissionMode = MODES.includes(body?.permissionMode) ? body.permissionMode : 'default';
    const resume = typeof body?.resume === 'string' && body.resume ? body.resume : undefined;
    const model = str(body?.model) || undefined;
    const kind = body?.kind === 'task' ? 'task' : 'chat';
    const ticketIn = str(body?.ticket).toUpperCase();
    if (ticketIn && !TICKET_RE.test(ticketIn)) return c.json({ error: 'ticket must look like PROJ-123' }, 400);
    if (!prompt) return c.json({ error: 'prompt is required' }, 400);
    if (model && !MODEL_RE.test(model)) return c.json({ error: 'invalid model' }, 400);
    if (!isAbsolute(cwd) || !(await stat(cwd).then((s) => s.isDirectory(), () => false))) {
      return c.json({ error: 'cwd must be an existing absolute directory' }, 400);
    }
    if (resume && runs.activeRunBySession().has(resume)) return c.json({ error: 'session already has an active run' }, 409);
    const settings = await loadSettings();
    const ticket = ticketIn || detectTicket(prompt, settings.ticketKeys) || detectTicket(await gitBranch(cwd), settings.ticketKeys);
    const share: ShareLevel = SHARES.includes(body?.share) ? body.share : shareFor(cwd, settings);
    const connected = opts.selfUrl ? ((await conns?.all()) ?? []).filter((x) => x.connected) : [];
    if (!connected.length) return c.json(runs.start({ kind, cwd, prompt, permissionMode, resume, model, ticket, share }), 201);
    const secret = randomBytes(24).toString('base64url');
    const mcp = Object.fromEntries(connected.map((x) => [x.name, { url: `${opts.selfUrl}/mcp/${x.name}`, headers: { 'x-legos-run': secret } }]));
    const run = runs.start({ kind, cwd, prompt, permissionMode, resume, model, ticket, share, mcp });
    grants.set(secret, run.id);
    return c.json(run, 201);
  });

  const wbError = (c: any, err: unknown) => c.json({ error: errMsg(err) }, 502);
  const NO_WB = 'connect a workbench in Settings first';

  app.get('/api/workbench/integrations', async (c) => {
    const wb = await workbench();
    if (!wb) return c.json({ error: NO_WB }, 409);
    try {
      return c.json({ integrations: await wb.client.integrations(wb.token) });
    } catch (err) {
      return wbError(c, err);
    }
  });

  app.post('/api/workbench/connect', async (c) => {
    const integration = str((await c.req.json().catch(() => null))?.integration);
    if (!/^[a-z0-9-]{1,64}$/.test(integration)) return c.json({ error: 'invalid integration' }, 400);
    const wb = await workbench();
    if (!wb) return c.json({ error: NO_WB }, 409);
    try {
      return c.json(await wb.client.connect(wb.token, integration));
    } catch (err) {
      return wbError(c, err);
    }
  });

  app.get('/api/jira/issues', async (c) => {
    const custom = str(c.req.query('jql'));
    const jql = custom || JQL_PRESETS[c.req.query('filter') ?? 'mine'];
    if (!jql || jql.length > 1000) return c.json({ error: 'unknown filter or JQL too long' }, 400);
    const wb = await workbench();
    if (!wb) return c.json({ error: NO_WB }, 409);
    try {
      return c.json(await wb.client.jiraSearch(wb.token, jql, 20, c.req.query('pageToken') || undefined));
    } catch (err) {
      return wbError(c, err);
    }
  });

  app.get('/api/jira/issues/:key', async (c) => {
    const key = c.req.param('key').toUpperCase();
    if (!TICKET_RE.test(key)) return c.json({ error: 'invalid issue key' }, 400);
    const wb = await workbench();
    if (!wb) return c.json({ error: NO_WB }, 409);
    try {
      return c.json(await wb.client.jiraIssue(wb.token, key));
    } catch (err) {
      return wbError(c, err);
    }
  });

  app.get('/api/activity/me', async (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 7) || 7, 1), 90);
    return c.json({ items: (await opts.activity?.list(Date.now() - days * 86_400_000)) ?? [] });
  });

  // Team view is read from the hub as the signed-in user; the hub never sees cost or transcripts.
  app.get('/api/team', async (c) => {
    if (!opts.hubUrl) return c.json({ error: 'team hub not configured', configured: false }, 409);
    const wb = await workbench();
    if (!wb) return c.json({ error: NO_WB, configured: true }, 409);
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 7) || 7, 1), 90);
    try {
      const res = await http(`${opts.hubUrl}/hub/team?days=${days}`, { headers: { authorization: `Bearer ${wb.token}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return c.json({ error: `team hub answered HTTP ${res.status}`, configured: true }, 502);
      return c.json({ configured: true, ...(await res.json()) });
    } catch (err) {
      return c.json({ error: `team hub unreachable: ${err instanceof Error ? err.message : err}`, configured: true }, 502);
    }
  });

  app.get('/api/settings', async (c) => c.json({ path: settingsPath(), ...(await loadSettings()) }));

  // What a new run in this folder would get, so the launch dialog can prefill it.
  app.get('/api/policy', async (c) => {
    const cwd = str(c.req.query('cwd'));
    if (!isAbsolute(cwd)) return c.json({ error: 'cwd must be absolute' }, 400);
    const settings = await loadSettings();
    const branch = await gitBranch(cwd);
    return c.json({ share: shareFor(cwd, settings), branch, ticket: detectTicket(branch, settings.ticketKeys) });
  });

  app.get('/api/models', async (c) => {
    try {
      return c.json(await runs.models());
    } catch (err) {
      return c.json({ error: `could not list models: ${err instanceof Error ? err.message : err}` }, 502);
    }
  });

  app.post('/api/runs/:id/messages', async (c) => {
    const text = str((await c.req.json().catch(() => null))?.text);
    if (!text) return c.json({ error: 'text is required' }, 400);
    return runs.send(c.req.param('id'), text) ? c.json({ ok: true }) : c.json({ error: 'session has ended or is a task (tasks take no follow-ups)' }, 409);
  });

  app.post('/api/runs/:id/model', async (c) => {
    const model = str((await c.req.json().catch(() => null))?.model);
    if (!MODEL_RE.test(model)) return c.json({ error: 'invalid model' }, 400);
    return (await runs.setModel(c.req.param('id'), model)) ? c.json({ ok: true }) : c.json({ error: 'session has ended' }, 409);
  });

  app.post('/api/runs/:id/interrupt', async (c) => {
    return (await runs.interrupt(c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'no turn in progress' }, 409);
  });

  app.post('/api/runs/:id/end', async (c) => {
    return (await runs.end(c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'session already ended' }, 409);
  });

  app.post('/api/decisions/:id', async (c) => {
    const body = await c.req.json().catch(() => null);
    let answer: DecisionAnswer;
    if (body?.behavior === 'allow') answer = { behavior: 'allow', answers: body.answers };
    else if (body?.behavior === 'deny') answer = { behavior: 'deny', message: body.message };
    else return c.json({ error: 'behavior must be allow or deny' }, 400);
    // 410: expired, withdrawn, or answered elsewhere — the UI must drop it, not retry
    return runs.decide(c.req.param('id'), answer) ? c.json({ ok: true }) : c.json({ error: 'decision no longer open' }, 410);
  });

  app.post('/api/runs/:id/resume-task', async (c) => {
    const text = str((await c.req.json().catch(() => null))?.text);
    return runs.resumeTask(c.req.param('id'), text) ? c.json({ ok: true }) : c.json({ error: 'only an idle chat that started as a task can resume it' }, 409);
  });

  app.post('/api/decisions/:id/discuss', async (c) => {
    const text = str((await c.req.json().catch(() => null))?.text);
    if (!text) return c.json({ error: 'text is required' }, 400);
    const runId = runs.discuss(c.req.param('id'), text);
    return runId ? c.json({ runId }) : c.json({ error: 'decision no longer open' }, 410);
  });

  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const send = (m: StreamMessage) => void stream.writeSSE({ data: JSON.stringify(m) });
      send(runs.snapshot());
      runs.on('message', send);
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 15000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      runs.off('message', send);
    }),
  );

  return app;
}
