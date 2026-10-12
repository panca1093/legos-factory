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
import type { Auth } from './auth.ts';
import type { RunManager } from './claude-runs.ts';
import type { Workbench } from './workbench.ts';

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
// Only bounce back to this app after login, never to an arbitrary site.
const safeReturn = (u: string | undefined) => {
  try {
    const url = new URL(u ?? '');
    return LOCAL_HOSTS.has(url.hostname) || LOCAL_HOSTS.has(`[${url.hostname}]`) ? url.toString() : '/';
  } catch {
    return '/';
  }
};
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:14px system-ui;padding:40px;color:#151a29"><h2>${title}</h2><p>${body}</p><p><a href="/auth/login">Try again</a></p></body>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Headers worth passing between Claude Code and workbench on the MCP proxy.
const MCP_REQ_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const MCP_RES_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];

export type AppOptions = {
  auth?: Auth | null;
  // shown on the sign-in button: "Sign in with <name>"
  ssoName?: string;
  workbenchUrl?: string | null;
  workbench?: Workbench | null;
  workbenchMcpUrl?: string;
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

type Env = { Variables: { sid: string | null } };

export function createApp(runs: RunManager, opts: AppOptions = {}) {
  const app = new Hono<Env>();
  const auth = opts.auth ?? null;
  // per-run secret -> login session, so a run's workbench calls carry its owner's token
  const grants = new Map<string, { sid: string; runId: string }>();
  // run -> its owner's login session, for pushing status to the hub as that user
  const owners = new Map<string, string>();
  const http = opts.fetch ?? fetch;
  runs.on('message', (m: StreamMessage) => {
    if (m.type !== 'run') return;
    if (m.run.endedAt) for (const [k, g] of grants) if (g.runId === m.run.id) grants.delete(k);
    void opts.activity
      ?.record(m.run)
      .then(async (item) => {
        const sid = owners.get(m.run.id);
        if (!item || item.share === 'private' || !opts.hubUrl || !auth || !sid) return;
        const token = await auth.accessToken(sid);
        if (!token) return;
        const res = await http(`${opts.hubUrl}/hub/events`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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
    const sid = getCookie(c, SID_COOKIE) ?? null;
    if (auth && (!sid || !(await auth.accessToken(sid)))) return c.json({ error: 'sign in required' }, 401);
    c.set('sid', sid);
    await next();
  });

  app.use('/auth/*', async (c, next) => {
    if (!localOnly(c.req.header('host'))) return c.text('forbidden host', 403);
    await next();
  });

  app.get('/auth/me', async (c) => {
    const provider = { ssoName: opts.ssoName ?? 'workbench', workbenchUrl: opts.workbenchUrl ?? null };
    if (!auth) return c.json({ authEnabled: false, authenticated: true, user: null, ...provider });
    const sid = getCookie(c, SID_COOKIE);
    const ok = !!sid && !!(await auth.accessToken(sid));
    return c.json({ authEnabled: true, authenticated: ok, user: ok ? await auth.user(sid) : null, ...provider });
  });

  app.get('/auth/login', async (c) => {
    if (!auth) return c.redirect('/');
    try {
      const attempt = c.req.query('attempt');
      if (attempt && !/^[\w-]{32,128}$/.test(attempt)) return c.text('bad attempt id', 400);
      return c.redirect(await auth.loginUrl(safeReturn(c.req.query('returnTo')), attempt ?? null));
    } catch (err) {
      return c.html(page('Could not reach the sign-in server', esc(err instanceof Error ? err.message : String(err))), 502);
    }
  });

  app.get('/auth/callback', async (c) => {
    if (!auth) return c.redirect('/');
    const { code, state, error, error_description } = c.req.query();
    if (error || !code || !state) return c.html(page('Sign-in was not completed', esc(error_description ?? error ?? 'missing code')), 400);
    try {
      const { sid, returnTo, attempt } = await auth.callback(code, state);
      setCookie(c, SID_COOKIE, sid, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 30 * 24 * 3600 });
      // The app window is polling /auth/claim and will sign itself in, even if this is a different browser.
      if (attempt)
        return c.html(
          `<!doctype html><meta charset="utf-8"><title>Signed in</title><body style="font:14px system-ui;padding:40px;color:#151a29;text-align:center"><h2>Signed in to legos-factory</h2><p>You can close this window and go back to the app.</p><p><a href="${esc(returnTo)}">Open legos-factory</a></p><script>setTimeout(()=>window.close(),800)</script></body>`,
        );
      return c.redirect(returnTo);
    } catch (err) {
      return c.html(page('Sign-in failed', esc(err instanceof Error ? err.message : String(err))), 400);
    }
  });

  app.post('/auth/claim', async (c) => {
    if (!auth) return c.json({ ok: true });
    if (c.req.header('x-legos') !== '1') return c.json({ error: 'missing x-legos header' }, 403);
    const attempt = str((await c.req.json().catch(() => null))?.attempt);
    const sid = attempt ? auth.claim(attempt) : null;
    if (!sid) return c.json({ done: false });
    setCookie(c, SID_COOKIE, sid, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 30 * 24 * 3600 });
    return c.json({ done: true });
  });

  app.post('/auth/logout', async (c) => {
    if (c.req.header('x-legos') !== '1') return c.json({ error: 'missing x-legos header' }, 403);
    await auth?.logout(getCookie(c, SID_COOKIE));
    deleteCookie(c, SID_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // Claude Code processes call workbench through here; the user's token is attached fresh on every request.
  app.all('/mcp/workbench', async (c) => {
    if (!auth || !opts.workbenchMcpUrl) return c.json({ error: 'workbench proxy disabled' }, 404);
    if (!localOnly(c.req.header('host'))) return c.text('forbidden host', 403);
    const grant = grants.get(c.req.header('x-legos-run') ?? '');
    if (!grant) return c.json({ error: 'unknown run' }, 403);
    const token = await auth.accessToken(grant.sid);
    if (!token) return c.json({ error: 'owner signed out' }, 401);
    const headers = new Headers({ authorization: `Bearer ${token}` });
    for (const h of MCP_REQ_HEADERS) {
      const v = c.req.header(h);
      if (v) headers.set(h, v);
    }
    const method = c.req.method;
    const upstream = await (opts.fetch ?? fetch)(opts.workbenchMcpUrl, {
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
    let mcp: { name: string; url: string; headers: Record<string, string> } | undefined;
    const sid = c.get('sid');
    if (auth && sid && opts.workbenchMcpUrl && opts.selfUrl) {
      const secret = randomBytes(24).toString('base64url');
      mcp = { name: 'workbench', url: `${opts.selfUrl}/mcp/workbench`, headers: { 'x-legos-run': secret } };
      const run = runs.start({ kind, cwd, prompt, permissionMode, resume, model, ticket, share, mcp });
      grants.set(secret, { sid, runId: run.id });
      owners.set(run.id, sid);
      return c.json(run, 201);
    }
    return c.json(runs.start({ kind, cwd, prompt, permissionMode, resume, model, ticket, share }), 201);
  });

  // Workbench calls run as the signed-in user; without sign-in there is no identity to act as.
  const wbToken = async (c: any): Promise<string | null> => (auth && c.get('sid') ? auth.accessToken(c.get('sid')) : null);
  const wbError = (c: any, err: unknown) => c.json({ error: err instanceof Error ? err.message : String(err) }, 502);

  app.get('/api/workbench/integrations', async (c) => {
    const token = await wbToken(c);
    if (!token || !opts.workbench) return c.json({ error: 'sign in to see workbench integrations' }, 409);
    try {
      return c.json({ integrations: await opts.workbench.integrations(token) });
    } catch (err) {
      return wbError(c, err);
    }
  });

  app.post('/api/workbench/connect', async (c) => {
    const integration = str((await c.req.json().catch(() => null))?.integration);
    if (!/^[a-z0-9-]{1,64}$/.test(integration)) return c.json({ error: 'invalid integration' }, 400);
    const token = await wbToken(c);
    if (!token || !opts.workbench) return c.json({ error: 'sign in first' }, 409);
    try {
      return c.json(await opts.workbench.connect(token, integration));
    } catch (err) {
      return wbError(c, err);
    }
  });

  app.get('/api/jira/issues', async (c) => {
    const custom = str(c.req.query('jql'));
    const jql = custom || JQL_PRESETS[c.req.query('filter') ?? 'mine'];
    if (!jql || jql.length > 1000) return c.json({ error: 'unknown filter or JQL too long' }, 400);
    const token = await wbToken(c);
    if (!token || !opts.workbench) return c.json({ error: 'sign in to see Jira issues' }, 409);
    try {
      return c.json(await opts.workbench.jiraSearch(token, jql, 20, c.req.query('pageToken') || undefined));
    } catch (err) {
      return wbError(c, err);
    }
  });

  app.get('/api/jira/issues/:key', async (c) => {
    const key = c.req.param('key').toUpperCase();
    if (!TICKET_RE.test(key)) return c.json({ error: 'invalid issue key' }, 400);
    const token = await wbToken(c);
    if (!token || !opts.workbench) return c.json({ error: 'sign in first' }, 409);
    try {
      return c.json(await opts.workbench.jiraIssue(token, key));
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
    const token = await wbToken(c);
    if (!token) return c.json({ error: 'sign in to see your team' }, 409);
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 7) || 7, 1), 90);
    try {
      const res = await http(`${opts.hubUrl}/hub/team?days=${days}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
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
