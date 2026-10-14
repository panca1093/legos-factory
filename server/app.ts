import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import type { DecisionAnswer, PermissionMode, PendingDecision, Run, SessionSummary, Settings, ShareLevel, StreamMessage } from '../shared/types.ts';
import { getSession, listSessions } from './claude-sessions.ts';
import { detectTicket, gitBranch, loadSettings, settingsPath, shareFor } from './policy.ts';
import { ActivityLog, toTeamItem } from './activity.ts';
import { PIN_RE, type Users } from './users.ts';
import type { RunManager } from './claude-runs.ts';
import { Connections, type Pending } from './connections.ts';
import { openDb } from './db.ts';
import { Workbench } from './workbench.ts';
import { createWorkspace, exists, managedWorkspace, parseRepo, removeWorkspace, workspacePath, workspacesDir } from './workspace.ts';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan'];
// aliases (opus, sonnet) or full ids incl. suffixes like [1m]; validated by the CLI itself
const MODEL_RE = /^[\w.\-\[\]]{1,64}$/;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const SHARES: ShareLevel[] = ['private', 'status', 'full'];
const TICKET_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const BRANCH_RE = /^(?!-)[\w./-]{1,200}$/;

const annotate = <T extends SessionSummary>(s: T, settings: Settings): T => ({
  ...s,
  ticket: detectTicket(s.title, settings.ticketKeys) ?? detectTicket(s.gitBranch, settings.ticketKeys),
  share: shareFor(s.cwd, settings),
});

const SID_COOKIE = 'lf_sid';
// whoever runs everything when sign-in is off (LEGOS_AUTH=off)
const LOCAL_UID = 'local';
// owner of sign-in's own workbench client registration; no user has an empty id
const LOGIN_OWNER = '';
const ATTEMPT_RE = /^[\w-]{16,64}$/;
const ATTEMPT_TTL_MS = 10 * 60_000;
const page = (title: string, body: string, close = false, link = '/#/settings', linkText = 'Open Settings') =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:14px system-ui;padding:40px;color:#151a29;text-align:center"><h2>${title}</h2><p>${body}</p><p><a href="${link}">${linkText}</a></p>${close ? '<script>setTimeout(()=>window.close(),800)</script>' : ''}</body>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Headers worth passing between Claude Code and workbench on the MCP proxy.
const MCP_REQ_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const MCP_RES_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];

export type AppOptions = {
  // null = no sign-in (LEGOS_AUTH=off): everything belongs to one local user
  users?: Users | null;
  // defaults to a throwaway in-memory database
  db?: DatabaseSync;
  selfUrl?: string;
  fetch?: typeof fetch;
  // team hub base URL; unset = no team activity
  hubUrl?: string | null;
  // workbench MCP URL behind "Sign in with workbench"; unset hides that option
  workbenchUrl?: string | null;
  // where repo runs get their throwaway clones, and how to reach a repo (see workspace.ts)
  workspaces?: string;
  gitUrl?: string;
  // the Bitbucket workspace repos are listed from when none is asked for (the forge can't tell us)
  bitbucketWorkspace?: string | null;
};

type Env = { Variables: { uid: string } };

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
  const app = new Hono<Env>();
  const users = opts.users ?? null;
  const db = opts.db ?? openDb(':memory:');
  const activity = new ActivityLog(db);
  const http = opts.fetch ?? fetch;
  const callbackUrl = `${opts.selfUrl ?? 'http://localhost:4317'}/auth/callback`;
  const pending = new Map<string, Pending>();
  const connsByOwner = new Map<string, Connections>();
  const connsFor = (owner: string) => {
    if (!connsByOwner.has(owner)) connsByOwner.set(owner, new Connections({ callbackUrl, db, owner, fetch: http, pending }));
    return connsByOwner.get(owner)!;
  };
  // per-run secret -> run, so only runs launched here reach the connections proxy
  const grants = new Map<string, string>();
  const wsRoot = opts.workspaces ?? workspacesDir();
  // run -> its throwaway clone, deleted once no live run works in it
  const clones = new Map<string, string>();
  const busyIn = (path: string) => [...runs.activeRunBySession().values(), ...clones.keys()].some((id) => runs.get(id)?.cwd === path && !runs.get(id)?.endedAt);
  // workbench sign-in: OAuth state -> the attempt the app is polling, and finished attempts -> cookie
  const attempts = new Map<string, { attempt: string; at: number }>();
  const claims = new Map<string, { cookie: string; at: number }>();
  const clients = new Map<string, Workbench>();
  // the owner's connected workbench, if any: apps, Jira and the team hub go through it
  const workbench = async (owner: string) => {
    const wb = await connsFor(owner).workbench();
    if (!wb) return null;
    if (!clients.has(wb.url)) clients.set(wb.url, new Workbench(wb.url, http));
    return { client: clients.get(wb.url)!, token: wb.token };
  };
  const decisionById = (id: string): PendingDecision | undefined => {
    const snap = runs.snapshot();
    return snap.type === 'snapshot' ? snap.decisions.find((d) => d.id === id) : undefined;
  };
  const ownsRun = (uid: string, runId: string) => runs.get(runId)?.owner === uid;
  runs.on('message', (m: StreamMessage) => {
    if (m.type !== 'run') return;
    if (m.run.endedAt) for (const [k, runId] of grants) if (runId === m.run.id) grants.delete(k);
    const clone = m.run.endedAt ? clones.get(m.run.id) : undefined;
    if (clone) {
      clones.delete(m.run.id);
      if (!busyIn(clone)) void removeWorkspace(wsRoot, clone).catch((err) => console.warn('workspace cleanup failed:', err.message));
    }
    void activity
      .record(m.run, m.run.owner)
      .then(async (item) => {
        if (!item || item.share === 'private' || !opts.hubUrl) return;
        const wb = await workbench(m.run.owner);
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
    const user = users?.verify(getCookie(c, SID_COOKIE)) ?? null;
    if (users && !user) return c.json({ error: 'sign in required' }, 401);
    c.set('uid', user?.id ?? LOCAL_UID);
    await next();
  });

  // Other users' runs and decisions look like they don't exist.
  app.use('/api/runs/:id/*', async (c, next) => {
    const r = runs.get(c.req.param('id'));
    if (r && r.owner !== c.get('uid')) return c.json({ error: 'run not found' }, 404);
    await next();
  });
  app.use('/api/decisions/:id/*', async (c, next) => {
    const d = decisionById(c.req.param('id'));
    if (d && !ownsRun(c.get('uid'), d.runId)) return c.json({ error: 'decision no longer open' }, 410);
    await next();
  });

  app.use('/auth/*', async (c, next) => {
    if (!localOnly(c.req.header('host'))) return c.text('forbidden host', 403);
    await next();
  });

  app.get('/auth/me', async (c) => {
    const workbenchLogin = !!(users && opts.workbenchUrl);
    if (!users) return c.json({ authEnabled: false, workbenchLogin, users: [], authenticated: true, user: null });
    const user = users.verify(getCookie(c, SID_COOKIE));
    return c.json({ authEnabled: true, workbenchLogin, users: users.pinNames(), authenticated: !!user, user });
  });

  // Lax, not Strict: the workbench callback is a cross-site redirect that must still set it.
  const signedIn = (c: any, cookie: string) => setCookie(c, SID_COOKIE, cookie, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 30 * 24 * 3600 });
  const authWrite = (c: any) => (c.req.header('x-legos') !== '1' ? c.json({ error: 'missing x-legos header' }, 403) : !users ? c.json({ error: 'sign-in is off' }, 409) : null);

  // Anyone at this machine may add a local user; each user only ever sees their own runs and connections.
  app.post('/auth/users', async (c) => {
    const denied = authWrite(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const name = str(body?.name);
    const pin = str(body?.pin);
    if (!name || name.length > 64) return c.json({ error: 'name is required (max 64)' }, 400);
    if (!PIN_RE.test(pin)) return c.json({ error: 'PIN must be 6 digits' }, 400);
    try {
      signedIn(c, (await users!.createPin(name, pin)).cookie);
    } catch (err) {
      return c.json({ error: errMsg(err) }, 409);
    }
    return c.json({ ok: true });
  });

  app.post('/auth/login', async (c) => {
    const denied = authWrite(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const r = await users!.loginPin(str(body?.name), str(body?.pin));
    if (r.ok) {
      signedIn(c, r.cookie);
      return c.json({ ok: true });
    }
    if (r.retryAfterMs) return c.json({ error: `Too many wrong PINs — try again in ${Math.ceil(r.retryAfterMs / 1000)}s`, retryAfterMs: r.retryAfterMs }, 429);
    return c.json({ error: 'Wrong name or PIN' }, 401);
  });

  app.post('/auth/logout', async (c) => {
    if (c.req.header('x-legos') !== '1') return c.json({ error: 'missing x-legos header' }, 403);
    deleteCookie(c, SID_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  const prune = (m: Map<string, { at: number }>) => {
    for (const [k, v] of m) if (Date.now() - v.at > ATTEMPT_TTL_MS) m.delete(k);
  };

  // Starts "Sign in with workbench". The desktop pane opens the link in the system browser, where the
  // app can't receive the cookie: it polls /auth/claim with its attempt id instead.
  app.post('/auth/workbench', async (c) => {
    const denied = authWrite(c);
    if (denied) return denied;
    if (!opts.workbenchUrl) return c.json({ error: 'workbench sign-in is not configured' }, 404);
    const attempt = str((await c.req.json().catch(() => null))?.attempt);
    if (attempt && !ATTEMPT_RE.test(attempt)) return c.json({ error: 'invalid attempt' }, 400);
    const lc = connsFor(LOGIN_OWNER);
    try {
      if (!(await lc.all()).some((x) => x.name === 'workbench')) await lc.add({ name: 'workbench', kind: 'workbench', url: opts.workbenchUrl, auth: 'oauth' });
      const url = await lc.startOAuth('workbench');
      prune(attempts);
      if (attempt) attempts.set(new URL(url).searchParams.get('state')!, { attempt, at: Date.now() });
      return c.json({ url });
    } catch (err) {
      return c.json({ error: errMsg(err) }, errStatus(err));
    }
  });

  app.get('/auth/claim', (c) => {
    const attempt = c.req.query('attempt') ?? '';
    const hit = claims.get(attempt);
    if (!hit || Date.now() - hit.at > ATTEMPT_TTL_MS) return c.json({ ok: false }, 404);
    claims.delete(attempt);
    signedIn(c, hit.cookie);
    return c.json({ ok: true });
  });

  // OAuth redirect for a connection or a workbench sign-in. May land in another browser than the app
  // (desktop panes open links in the system browser), so it needs no app session: the one-time state is the proof.
  app.get('/auth/callback', async (c) => {
    const { code, state, error, error_description } = c.req.query();
    if (error || !code || !state) return c.html(page('Connection was not completed', esc(error_description ?? error ?? 'missing code')), 400);
    const owner = pending.get(state)?.owner;
    if (owner === LOGIN_OWNER && users) {
      try {
        const r = await connsFor(LOGIN_OWNER).redeem(code, state);
        const who = r.oauth.user;
        if (!who?.id) throw new Error('workbench did not say who you are');
        const user = users.upsertExternal('workbench', who.id, who.name || who.email || who.id, who.email);
        // the sign-in tokens double as this user's workbench connection
        await connsFor(user.id).putOAuth('workbench', 'workbench', r.url, r.oauth);
        const cookie = users.issue(user.id);
        signedIn(c, cookie);
        const a = attempts.get(state);
        attempts.delete(state);
        if (a) {
          prune(claims);
          claims.set(a.attempt, { cookie, at: Date.now() });
        }
        return c.html(page(`Signed in as ${esc(user.name)}`, 'You can close this window and go back to legos-factory.', true, '/', 'Open legos-factory'));
      } catch (err) {
        return c.html(page('Sign-in failed', esc(errMsg(err)), false, '/', 'Back to sign-in'), 400);
      }
    }
    if (owner === undefined || owner === LOGIN_OWNER) return c.html(page('Connection failed', 'connect expired or was not started here — try again from Settings'), 400);
    try {
      const name = await connsFor(owner).callback(code, state);
      return c.html(page(`Connected ${esc(name)}`, 'You can close this window and go back to legos-factory.', true));
    } catch (err) {
      return c.html(page('Connection failed', esc(errMsg(err))), 400);
    }
  });

  // Claude Code processes reach Settings connections through here; credentials are attached fresh on every request.
  app.all('/mcp/:name', async (c) => {
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

  app.get('/api/connections', async (c) => c.json({ connections: await connsFor(c.get('uid')).all() }));

  app.post('/api/connections', async (c) => {
    const b = await c.req.json().catch(() => null);
    try {
      const headers = b?.headers && typeof b.headers === 'object' ? b.headers : undefined;
      return c.json(await connsFor(c.get('uid')).add({ name: str(b?.name), kind: b?.kind, url: str(b?.url), auth: b?.auth, headers }), 201);
    } catch (err) {
      return c.json({ error: errMsg(err) }, errStatus(err));
    }
  });

  app.delete('/api/connections/:name', async (c) => {
    try {
      await connsFor(c.get('uid')).remove(c.req.param('name'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errMsg(err) }, errStatus(err));
    }
  });

  app.post('/api/connections/:name/connect', async (c) => {
    try {
      return c.json({ url: await connsFor(c.get('uid')).startOAuth(c.req.param('name')) });
    } catch (err) {
      return c.json({ error: errMsg(err) }, errStatus(err));
    }
  });

  app.post('/api/connections/:name/disconnect', async (c) => {
    try {
      await connsFor(c.get('uid')).disconnect(c.req.param('name'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: errMsg(err) }, errStatus(err));
    }
  });

  app.get('/api/sessions', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 200) || 200, 1000);
    const active = runs.activeRunBySession();
    const [list, settings] = await Promise.all([listSessions(activity.sessionIds(c.get('uid'), limit)), loadSettings()]);
    return c.json(list.map((s) => ({ ...annotate(s, settings), activeRunId: active.get(s.id) ?? null })));
  });

  app.get('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const s = activity.ownsSession(c.get('uid'), id) ? await getSession(id) : null;
    if (!s) return c.json({ error: 'session not found' }, 404);
    return c.json({ ...annotate(s, await loadSettings()), activeRunId: runs.activeRunBySession().get(s.id) ?? null });
  });

  app.get('/api/runs/:id', (c) => {
    const r = runs.get(c.req.param('id'));
    return r && r.owner === c.get('uid') ? c.json(r) : c.json({ error: 'run not found' }, 404);
  });

  app.post('/api/runs', async (c) => {
    const body = await c.req.json().catch(() => null);
    let cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : '';
    const repoIn = str(body?.repo);
    const branch = str(body?.branch) || undefined;
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    const permissionMode: PermissionMode = MODES.includes(body?.permissionMode) ? body.permissionMode : 'default';
    const resume = typeof body?.resume === 'string' && body.resume ? body.resume : undefined;
    const model = str(body?.model) || undefined;
    const kind = body?.kind === 'task' ? 'task' : 'chat';
    const ticketIn = str(body?.ticket).toUpperCase();
    if (ticketIn && !TICKET_RE.test(ticketIn)) return c.json({ error: 'ticket must look like PROJ-123' }, 400);
    if (!prompt) return c.json({ error: 'prompt is required' }, 400);
    if (model && !MODEL_RE.test(model)) return c.json({ error: 'invalid model' }, 400);
    if (branch && !BRANCH_RE.test(branch)) return c.json({ error: 'invalid branch' }, 400);
    const uid = c.get('uid');
    if (resume && !activity.ownsSession(uid, resume)) return c.json({ error: 'session not found' }, 404);
    if (resume && runs.activeRunBySession().has(resume)) return c.json({ error: 'session already has an active run' }, 409);
    const settings = await loadSettings();

    // A repo run works in a fresh clone; continuing one re-clones into the same path.
    let clone: { path: string; repo: NonNullable<ReturnType<typeof parseRepo>> } | null = null;
    if (repoIn) {
      const repo = parseRepo(repoIn);
      if (!repo) return c.json({ error: 'repo must look like workspace/repo' }, 400);
      const key = ticketIn || detectTicket(prompt, settings.ticketKeys) || `run-${randomBytes(4).toString('hex')}`;
      clone = { path: workspacePath(wsRoot, uid, repo, key), repo };
    } else if (isAbsolute(cwd) && managedWorkspace(wsRoot, cwd)) {
      const m = managedWorkspace(wsRoot, cwd)!;
      if (m.owner !== uid) return c.json({ error: 'session not found' }, 404);
      clone = { path: cwd, repo: m.repo };
    }
    if (clone) {
      if (busyIn(clone.path)) return c.json({ error: `a run is already working in ${clone.path.split('/').pop()}` }, 409);
      cwd = clone.path;
      if (repoIn || !(await exists(cwd))) {
        try {
          await createWorkspace({ path: cwd, repo: clone.repo, branch, urlTemplate: opts.gitUrl });
        } catch (err) {
          return c.json({ error: errMsg(err) }, errStatus(err));
        }
      }
    } else if (!isAbsolute(cwd) || !(await stat(cwd).then((s) => s.isDirectory(), () => false))) {
      return c.json({ error: 'cwd must be an existing absolute directory, or pass repo' }, 400);
    }
    const started = (run: Run) => (clone && clones.set(run.id, clone.path), run);
    const repo = clone ? `${clone.repo.workspace}/${clone.repo.slug}` : null;
    const ticket = ticketIn || detectTicket(prompt, settings.ticketKeys) || detectTicket(await gitBranch(cwd), settings.ticketKeys);
    const share: ShareLevel = SHARES.includes(body?.share) ? body.share : shareFor(cwd, settings);
    const connected = opts.selfUrl ? (await connsFor(uid).all()).filter((x) => x.connected) : [];
    if (!connected.length) return c.json(started(runs.start({ owner: uid, repo, kind, cwd, prompt, permissionMode, resume, model, ticket, share })), 201);
    const secret = randomBytes(24).toString('base64url');
    const mcp = Object.fromEntries(connected.map((x) => [x.name, { url: `${opts.selfUrl}/mcp/${x.name}`, headers: { 'x-legos-run': secret } }]));
    const run = started(runs.start({ owner: uid, repo, kind, cwd, prompt, permissionMode, resume, model, ticket, share, mcp }));
    grants.set(secret, run.id);
    return c.json(run, 201);
  });

  const wbError = (c: any, err: unknown) => c.json({ error: errMsg(err) }, 502);
  const NO_WB = 'connect a workbench in Settings first';

  // PRs for a ticket: its key in the source branch or title, looked up in the repos it was worked in
  // (from runs here) plus the ones the client remembers. The forge API can't search across repos.
  app.get('/api/prs', async (c) => {
    const ticket = str(c.req.query('ticket')).toUpperCase();
    if (!TICKET_RE.test(ticket)) return c.json({ error: 'ticket must look like PROJ-123' }, 400);
    const wb = await workbench(c.get('uid'));
    if (!wb) return c.json({ error: NO_WB }, 409);
    const fromRuns = (await activity.list(c.get('uid'), 0)).filter((i) => i.ticket === ticket && i.repo).map((i) => i.repo!);
    const asked = str(c.req.query('repos')).split(',').filter(Boolean);
    const repos = [...new Set([...fromRuns, ...asked])].map(parseRepo).filter((r) => r !== null).slice(0, 10);
    const hit = new RegExp(`(^|[^A-Z0-9])${ticket}([^0-9]|$)`, 'i');
    try {
      const found = (
        await Promise.all(
          repos.flatMap((r) => (['OPEN', 'MERGED'] as const).map((st) => wb.client.bitbucketPrs(wb.token, r.workspace, r.slug, st, st === 'OPEN' ? 50 : 30))),
        )
      )
        .flat()
        .filter((p) => hit.test(p.source) || hit.test(p.title))
        .sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || (b.updated ?? '').localeCompare(a.updated ?? ''));
      return c.json({ prs: found, searched: repos.map((r) => `${r.workspace}/${r.slug}`) });
    } catch (err) {
      return wbError(c, err);
    }
  });

  const prRef = (c: any) => {
    const repo = parseRepo(`${c.req.param('ws')}/${c.req.param('slug')}`);
    const id = Number(c.req.param('id'));
    return repo && Number.isInteger(id) && id > 0 ? { ...repo, id } : null;
  };

  app.get('/api/prs/:ws/:slug/:id', async (c) => {
    const ref = prRef(c);
    if (!ref) return c.json({ error: 'invalid pull request' }, 400);
    const wb = await workbench(c.get('uid'));
    if (!wb) return c.json({ error: NO_WB }, 409);
    try {
      const [pr, files, comments] = await Promise.all([
        wb.client.bitbucketPr(wb.token, ref.workspace, ref.slug, ref.id),
        wb.client.bitbucketPrFiles(wb.token, ref.workspace, ref.slug, ref.id),
        wb.client.bitbucketPrComments(wb.token, ref.workspace, ref.slug, ref.id),
      ]);
      return c.json({ pr, files, comments });
    } catch (err) {
      return wbError(c, err);
    }
  });

  app.get('/api/prs/:ws/:slug/:id/diff', async (c) => {
    const ref = prRef(c);
    if (!ref) return c.json({ error: 'invalid pull request' }, 400);
    const wb = await workbench(c.get('uid'));
    if (!wb) return c.json({ error: NO_WB }, 409);
    try {
      return c.json(await wb.client.bitbucketPrDiff(wb.token, ref.workspace, ref.slug, ref.id));
    } catch (err) {
      return wbError(c, err);
    }
  });

  // listing a big workspace takes several calls; repos change rarely
  type Repos = Awaited<ReturnType<Workbench['bitbucketRepos']>>;
  const repoCache = new Map<string, { at: number; repos: Repos }>();
  // the UI warms this in the background, so a dialog opened meanwhile joins the same load
  const repoLoads = new Map<string, Promise<Repos>>();
  app.get('/api/repos', async (c) => {
    const workspace = str(c.req.query('workspace')) || opts.bitbucketWorkspace || '';
    if (!workspace) return c.json({ error: 'workspace is required', needWorkspace: true }, 400);
    if (!/^[\w.-]{1,100}$/.test(workspace)) return c.json({ error: 'invalid workspace' }, 400);
    const wb = await workbench(c.get('uid'));
    if (!wb) return c.json({ error: NO_WB }, 409);
    const key = `${c.get('uid')}:${workspace}`;
    const hit = repoCache.get(key);
    if (hit && Date.now() - hit.at < 3600_000 && c.req.query('refresh') !== '1') return c.json({ workspace, repos: hit.repos });
    let load = repoLoads.get(key);
    if (!load) {
      load = wb.client.bitbucketRepos(wb.token, workspace).finally(() => repoLoads.delete(key));
      repoLoads.set(key, load);
    }
    try {
      const repos = await load;
      repoCache.set(key, { at: Date.now(), repos });
      return c.json({ workspace, repos });
    } catch (err) {
      return wbError(c, err);
    }
  });

  app.get('/api/workbench/integrations', async (c) => {
    const wb = await workbench(c.get('uid'));
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
    const wb = await workbench(c.get('uid'));
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
    const wb = await workbench(c.get('uid'));
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
    const wb = await workbench(c.get('uid'));
    if (!wb) return c.json({ error: NO_WB }, 409);
    try {
      return c.json(await wb.client.jiraIssue(wb.token, key));
    } catch (err) {
      return wbError(c, err);
    }
  });

  app.get('/api/activity/me', async (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 7) || 7, 1), 90);
    return c.json({ items: await activity.list(c.get('uid'), Date.now() - days * 86_400_000) });
  });

  // Team view is read from the hub as the signed-in user; the hub never sees cost or transcripts.
  app.get('/api/team', async (c) => {
    if (!opts.hubUrl) return c.json({ error: 'team hub not configured', configured: false }, 409);
    const wb = await workbench(c.get('uid'));
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
      const uid = c.get('uid');
      const mine = (m: StreamMessage) =>
        m.type === 'run' ? m.run.owner === uid
        : m.type === 'run_event' ? ownsRun(uid, m.runId)
        : m.type === 'decision' ? ownsRun(uid, m.decision.runId)
        : true; // decision_closed carries only an id
      const send = (m: StreamMessage) => void (mine(m) && stream.writeSSE({ data: JSON.stringify(m) }));
      const snap = runs.snapshot();
      if (snap.type === 'snapshot')
        send({ ...snap, runs: snap.runs.filter((r) => r.owner === uid), decisions: snap.decisions.filter((d) => ownsRun(uid, d.runId)) });
      runs.on('message', send);
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 15000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      runs.off('message', send);
    }),
  );

  return app;
}
