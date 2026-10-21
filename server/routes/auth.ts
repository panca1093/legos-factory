import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { PIN_RE } from '../users.ts';
import type { User } from '../users.ts';
import { HttpError, domain, errMsg, localOnly, parse, peerIsLocal, readBody, text, type Deps, type Env } from '../http.ts';

export const SID_COOKIE = 'lf_sid';
// workspace id of sign-in's own workbench client registration; no workspace has an empty id
const LOGIN_WORKSPACE = '';
const ATTEMPT_RE = /^[\w-]{16,64}$/;
const ATTEMPT_TTL_MS = 10 * 60_000;
// begin is unauthenticated, so what it leaves in memory is capped and the calls are rate limited
const MAX_OPEN = 1000;
const BEGINS_PER_MINUTE = 30;
const page = (title: string, body: string, close = false, link = '/#/settings', linkText = 'Open Settings') =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:14px system-ui;padding:40px;color:#151a29;text-align:center"><h2>${title}</h2><p>${body}</p><p><a href="${link}">${linkText}</a></p>${close ? '<script>setTimeout(()=>window.close(),800)</script>' : ''}</body>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const newUserSchema = z.object({
  name: text().refine((n) => !!n && n.length <= 64, 'name is required (max 64)'),
  pin: text().refine((p) => PIN_RE.test(p), 'PIN must be 6 digits'),
});
const loginSchema = z.object({ name: text(), pin: text() });
const attemptSchema = z.object({ attempt: text().refine((a) => !a || ATTEMPT_RE.test(a), 'invalid attempt') });

export function authRoutes({ users, workspaces, opts, connsFor, pending, oidc, hostOk, networked, selfUrl }: Deps) {
  const routes = new Hono<Env>();
  // Lax, not Strict: the sign-in callbacks are cross-site redirects that must still set it.
  const signedIn = (c: Context, cookie: string) =>
    setCookie(c, SID_COOKIE, cookie, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 30 * 24 * 3600, secure: !!opts.publicUrl?.startsWith('https:') });
  // PIN users are for this machine: a control plane reached over the network signs people in through a provider
  const pinAllowed = (c: Context) => !networked && localOnly(c.req.header('host')) && peerIsLocal(c);
  const localPin = (c: Context) => {
    if (!pinAllowed(c)) throw new HttpError(403, 'PIN sign-in is only for this machine');
  };
  const providers = () => [...(opts.workbenchUrl ? [{ id: 'workbench', label: 'workbench' }] : []), ...(oidc ? [{ id: 'oidc', label: oidc.label }] : [])];
  // workbench sign-in: OAuth state -> the attempt the app is polling; every provider: finished attempts -> cookie
  const attempts = new Map<string, { attempt: string; at: number }>();
  const claims = new Map<string, { secret: string; cookie?: string; at: number }>();
  const prune = (m: Map<string, { at: number }>) => {
    for (const [k, v] of m) if (Date.now() - v.at > ATTEMPT_TTL_MS) m.delete(k);
    if (m.size >= MAX_OPEN) throw new HttpError(429, 'too many sign-ins in progress: try again in a few minutes');
  };
  const begins: number[] = [];
  const throttle = () => {
    const now = Date.now();
    while (begins.length && now - begins[0] > 60_000) begins.shift();
    if (begins.length >= BEGINS_PER_MINUTE) throw new HttpError(429, 'too many sign-in attempts: try again in a minute');
    begins.push(now);
  };
  // The secret goes only to the app that began the sign-in; /auth/claim wants it, so knowing an attempt id is not enough.
  const openAttempt = (attempt: string): string | undefined => {
    if (!attempt) return undefined;
    prune(claims);
    if (claims.has(attempt)) throw new HttpError(409, 'this sign-in attempt was already started');
    const secret = randomBytes(24).toString('base64url');
    claims.set(attempt, { secret, at: Date.now() });
    return secret;
  };
  const startWorkbenchLogin = async (workbenchUrl: string, attempt: string) => {
    const lc = connsFor(LOGIN_WORKSPACE);
    if (!(await lc.all()).some((x) => x.name === 'workbench')) await lc.add({ name: 'workbench', kind: 'workbench', url: workbenchUrl, auth: 'oauth' });
    const url = await lc.startOAuth('workbench');
    prune(attempts);
    if (attempt) attempts.set(new URL(url).searchParams.get('state')!, { attempt, at: Date.now() });
    return url;
  };
  const authWrite = (c: Context) => {
    if (c.req.header('x-legos') !== '1') throw new HttpError(403, 'missing x-legos header');
    if (!users) throw new HttpError(409, 'sign-in is off');
    return users;
  };

  // the signed-in user's cookie, once a provider vouched for them; the waiting app picks it up by its attempt id
  const welcome = (c: Context, user: User, attempt: string | undefined) => {
    const cookie = users!.issue(user.id);
    signedIn(c, cookie);
    const hit = attempt ? claims.get(attempt) : undefined;
    if (hit) Object.assign(hit, { cookie, at: Date.now() });
    return c.html(page(`Signed in as ${esc(user.name)}`, 'You can close this window and go back to legos-factory.', true, '/', 'Open legos-factory'));
  };
  const refused = (c: Context, err: unknown) => c.html(page('Sign-in failed', esc(errMsg(err)), false, '/', 'Back to sign-in'), 400);

  routes.use('/auth/*', async (c, next) => {
    if (!hostOk(c.req.header('host'))) return c.text('forbidden host', 403);
    await next();
  });

  routes.get('/auth/me', async (c) => {
    if (!users) return c.json({ authEnabled: false, pin: false, providers: [], users: [], authenticated: true, user: null });
    const user = users.verify(getCookie(c, SID_COOKIE));
    const pin = pinAllowed(c);
    return c.json({ authEnabled: true, pin, providers: providers(), users: pin ? users.pinNames() : [], authenticated: !!user, user });
  });

  // Anyone at this machine may add a local user; each gets a personal workspace of their own.
  routes.post('/auth/users', async (c) => {
    const users = authWrite(c);
    localPin(c);
    const { name, pin } = parse(newUserSchema, await readBody(c));
    const { cookie } = await users.createPin(name, pin).catch((err) => {
      throw new HttpError(409, errMsg(err));
    });
    signedIn(c, cookie);
    return c.json({ ok: true });
  });

  routes.post('/auth/login', async (c) => {
    const users = authWrite(c);
    localPin(c);
    const { name, pin } = parse(loginSchema, await readBody(c));
    const res = await users.loginPin(name, pin);
    if (res.ok) {
      signedIn(c, res.cookie);
      return c.json({ ok: true });
    }
    if (res.retryAfterMs) throw new HttpError(429, `Too many wrong PINs — try again in ${Math.ceil(res.retryAfterMs / 1000)}s`, { retryAfterMs: res.retryAfterMs });
    throw new HttpError(401, 'Wrong name or PIN');
  });

  routes.post('/auth/logout', async (c) => {
    if (c.req.header('x-legos') !== '1') throw new HttpError(403, 'missing x-legos header');
    deleteCookie(c, SID_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // The desktop pane opens the link in the system browser, which cannot hand it the cookie: it polls /auth/claim instead.
  routes.post('/auth/providers/:id', async (c) => {
    authWrite(c);
    const id = c.req.param('id');
    if (!providers().some((p) => p.id === id)) throw new HttpError(404, `${id} sign-in is not configured`);
    const { attempt } = parse(attemptSchema, await readBody(c));
    throttle();
    const secret = openAttempt(attempt);
    try {
      const url = await domain(id === 'oidc' ? oidc!.begin(`${opts.publicUrl ?? selfUrl}/auth/oidc/callback`, attempt) : startWorkbenchLogin(opts.workbenchUrl!, attempt));
      return c.json({ url, secret });
    } catch (err) {
      claims.delete(attempt);
      throw err;
    }
  });

  // May land in another browser than the app, so the one-time state is the proof.
  routes.get('/auth/oidc/callback', async (c) => {
    if (!oidc || !users) return c.text('not found', 404);
    const { code, state, error, error_description } = c.req.query();
    if (error || !code || !state) return c.html(page('Sign-in was not completed', esc(error_description ?? error ?? 'missing code'), false, '/', 'Back to sign-in'), 400);
    try {
      const { identity, attempt } = await oidc.complete(code, state);
      const user = users.upsertExternal('oidc', identity.sub, identity.name, identity.email, identity.emailVerified);
      workspaces.ensurePersonal(user.id, user.name);
      return welcome(c, user, attempt || undefined);
    } catch (err) {
      return refused(c, err);
    }
  });

  routes.get('/auth/claim', (c) => {
    const attempt = c.req.query('attempt') ?? '';
    const secret = Buffer.from(c.req.query('secret') ?? '');
    const hit = claims.get(attempt);
    const want = Buffer.from(hit?.secret ?? '');
    if (!hit?.cookie || Date.now() - hit.at > ATTEMPT_TTL_MS || want.length !== secret.length || !timingSafeEqual(want, secret)) return c.json({ ok: false }, 404);
    claims.delete(attempt);
    signedIn(c, hit.cookie);
    return c.json({ ok: true });
  });

  // OAuth redirect for a connection or a workbench sign-in. May land in another browser than the app
  // (desktop panes open links in the system browser), so it needs no app session: the one-time state is the proof.
  routes.get('/auth/callback', async (c) => {
    const { code, state, error, error_description } = c.req.query();
    if (error || !code || !state) return c.html(page('Connection was not completed', esc(error_description ?? error ?? 'missing code')), 400);
    const workspaceId = pending.get(state)?.workspaceId;
    if (workspaceId === LOGIN_WORKSPACE && users) {
      try {
        const r = await connsFor(LOGIN_WORKSPACE).redeem(code, state);
        const who = r.oauth.user;
        if (!who?.id) throw new Error('workbench did not say who you are');
        const user = users.upsertExternal('workbench', who.id, who.name || who.email || who.id, who.email);
        // the sign-in tokens double as the workbench connection of this user's personal workspace
        await connsFor(workspaces.ensurePersonal(user.id, user.name)).putOAuth('workbench', 'workbench', r.url, r.oauth);
        const a = attempts.get(state);
        attempts.delete(state);
        return welcome(c, user, a?.attempt);
      } catch (err) {
        return refused(c, err);
      }
    }
    if (workspaceId === undefined || workspaceId === LOGIN_WORKSPACE) return c.html(page('Connection failed', 'connect expired or was not started here — try again from Settings'), 400);
    try {
      const name = await connsFor(workspaceId).callback(code, state);
      return c.html(page(`Connected ${esc(name)}`, 'You can close this window and go back to legos-factory.', true));
    } catch (err) {
      return c.html(page('Connection failed', esc(errMsg(err))), 400);
    }
  });

  return routes;
}
