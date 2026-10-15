import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { PIN_RE } from '../users.ts';
import { HttpError, domain, errMsg, localOnly, parse, readBody, text, type Deps, type Env } from '../http.ts';

export const SID_COOKIE = 'lf_sid';
// owner of sign-in's own workbench client registration; no user has an empty id
const LOGIN_OWNER = '';
const ATTEMPT_RE = /^[\w-]{16,64}$/;
const ATTEMPT_TTL_MS = 10 * 60_000;
const page = (title: string, body: string, close = false, link = '/#/settings', linkText = 'Open Settings') =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:14px system-ui;padding:40px;color:#151a29;text-align:center"><h2>${title}</h2><p>${body}</p><p><a href="${link}">${linkText}</a></p>${close ? '<script>setTimeout(()=>window.close(),800)</script>' : ''}</body>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const newUserSchema = z.object({
  name: text().refine((n) => !!n && n.length <= 64, 'name is required (max 64)'),
  pin: text().refine((p) => PIN_RE.test(p), 'PIN must be 6 digits'),
});
const loginSchema = z.object({ name: text(), pin: text() });
const attemptSchema = z.object({ attempt: text().refine((a) => !a || ATTEMPT_RE.test(a), 'invalid attempt') });

// Lax, not Strict: the workbench callback is a cross-site redirect that must still set it.
const signedIn = (c: Context, cookie: string) => setCookie(c, SID_COOKIE, cookie, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 30 * 24 * 3600 });

export function authRoutes({ users, opts, connsFor, pending }: Deps) {
  const routes = new Hono<Env>();
  // workbench sign-in: OAuth state -> the attempt the app is polling, and finished attempts -> cookie
  const attempts = new Map<string, { attempt: string; at: number }>();
  const claims = new Map<string, { cookie: string; at: number }>();
  const prune = (m: Map<string, { at: number }>) => {
    for (const [k, v] of m) if (Date.now() - v.at > ATTEMPT_TTL_MS) m.delete(k);
  };
  const startWorkbenchLogin = async (workbenchUrl: string, attempt: string) => {
    const lc = connsFor(LOGIN_OWNER);
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

  routes.use('/auth/*', async (c, next) => {
    if (!localOnly(c.req.header('host'))) return c.text('forbidden host', 403);
    await next();
  });

  routes.get('/auth/me', async (c) => {
    const workbenchLogin = !!(users && opts.workbenchUrl);
    if (!users) return c.json({ authEnabled: false, workbenchLogin, users: [], authenticated: true, user: null });
    const user = users.verify(getCookie(c, SID_COOKIE));
    return c.json({ authEnabled: true, workbenchLogin, users: users.pinNames(), authenticated: !!user, user });
  });

  // Anyone at this machine may add a local user; each user only ever sees their own runs and connections.
  routes.post('/auth/users', async (c) => {
    const users = authWrite(c);
    const { name, pin } = parse(newUserSchema, await readBody(c));
    const { cookie } = await users.createPin(name, pin).catch((err) => {
      throw new HttpError(409, errMsg(err));
    });
    signedIn(c, cookie);
    return c.json({ ok: true });
  });

  routes.post('/auth/login', async (c) => {
    const users = authWrite(c);
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

  // Starts "Sign in with workbench". The desktop pane opens the link in the system browser, where the
  // app can't receive the cookie: it polls /auth/claim with its attempt id instead.
  routes.post('/auth/workbench', async (c) => {
    authWrite(c);
    const workbenchUrl = opts.workbenchUrl;
    if (!workbenchUrl) throw new HttpError(404, 'workbench sign-in is not configured');
    const { attempt } = parse(attemptSchema, await readBody(c));
    const url = await domain(startWorkbenchLogin(workbenchUrl, attempt));
    return c.json({ url });
  });

  routes.get('/auth/claim', (c) => {
    const attempt = c.req.query('attempt') ?? '';
    const hit = claims.get(attempt);
    if (!hit || Date.now() - hit.at > ATTEMPT_TTL_MS) return c.json({ ok: false }, 404);
    claims.delete(attempt);
    signedIn(c, hit.cookie);
    return c.json({ ok: true });
  });

  // OAuth redirect for a connection or a workbench sign-in. May land in another browser than the app
  // (desktop panes open links in the system browser), so it needs no app session: the one-time state is the proof.
  routes.get('/auth/callback', async (c) => {
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

  return routes;
}
