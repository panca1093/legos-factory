import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildDeps, createApp } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import { Oidc, OidcError, type OidcConfig } from '../server/oidc.ts';
import { Users } from '../server/users.ts';
import { alive } from './fakes.ts';

const ISSUER = 'https://idp.example.com';
const REDIRECT = 'https://factory.example.com/auth/oidc/callback';
const b64 = (v: object | Buffer) => (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');

// A stand-in identity provider: discovery, signing keys, a token endpoint that checks PKCE and client auth.
function idp(over: { discoveryIssuer?: string; tokenStatus?: number } = {}) {
  const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keys = pair();
  const stranger = pair();
  const jwk = { ...(keys.publicKey.export({ format: 'jwk' }) as object), kid: 'k1', use: 'sig', alg: 'RS256' };
  const state = { nonce: '', challenge: '', redirect: REDIRECT, claims: {} as Record<string, unknown>, header: {} as Record<string, unknown>, signWith: keys.privateKey, userinfo: null as object | null, hits: [] as string[] };
  const idToken = () => {
    const header = { alg: 'RS256', kid: 'k1', ...state.header };
    const claims = { iss: ISSUER, aud: 'cid', sub: 'u-1', exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), nonce: state.nonce, email: 'Ada@Acme.test', email_verified: true, name: 'Ada', ...state.claims };
    const input = `${b64(header)}.${b64(claims)}`;
    if (header.alg === 'none') return `${input}.`;
    if (header.alg !== 'RS256') return `${input}.${b64(Buffer.from('x'))}`;
    return `${input}.${createSign('RSA-SHA256').update(input).sign(state.signWith).toString('base64url')}`;
  };
  const http = (async (input: any, init: any = {}) => {
    const url = String(input);
    state.hits.push(url);
    if (url === `${ISSUER}/.well-known/openid-configuration`)
      return Response.json({ issuer: over.discoveryIssuer ?? ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`, userinfo_endpoint: `${ISSUER}/userinfo` });
    if (url === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
    if (url === `${ISSUER}/userinfo`) return state.userinfo && init.headers.authorization === 'Bearer at' ? Response.json(state.userinfo) : new Response('no', { status: 401 });
    if (url === `${ISSUER}/token`) {
      const form = new URLSearchParams(init.body);
      const basic = `Basic ${Buffer.from('cid:secret').toString('base64')}`;
      const verifierOk = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === state.challenge;
      if (over.tokenStatus) return new Response('nope', { status: over.tokenStatus });
      if (form.get('code') !== 'good-code' || !verifierOk || init.headers.authorization !== basic || form.get('redirect_uri') !== state.redirect) return new Response('bad', { status: 400 });
      return Response.json({ id_token: idToken(), access_token: 'at' });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  // follows the authorization URL like a browser would, up to the redirect back with a code
  const authorize = (url: string) => {
    const u = new URL(url);
    state.nonce = u.searchParams.get('nonce')!;
    state.challenge = u.searchParams.get('code_challenge')!;
    state.redirect = u.searchParams.get('redirect_uri')!;
    return { state: u.searchParams.get('state')!, params: u.searchParams };
  };
  return { http, state, stranger, authorize };
}

const cfg: OidcConfig = { issuer: ISSUER, clientId: 'cid', clientSecret: 'secret', label: 'Acme SSO' };

async function signIn(o: Oidc, p: ReturnType<typeof idp>, attempt = 'a1') {
  const { state } = p.authorize(await o.begin(REDIRECT, attempt));
  return o.complete('good-code', state);
}

describe('OpenID Connect', () => {
  it('sends the person to the issuer with PKCE, a state and a nonce', async () => {
    const p = idp();
    const { params } = p.authorize(await new Oidc(cfg, p.http).begin(REDIRECT, 'a1'));
    expect(Object.fromEntries(params)).toMatchObject({ response_type: 'code', client_id: 'cid', redirect_uri: REDIRECT, code_challenge_method: 'S256' });
    expect(params.get('scope')).toBe('openid email profile');
    expect(params.get('state')!.length).toBeGreaterThan(15);
    expect(params.get('nonce')!.length).toBeGreaterThan(15);
    expect(params.get('code_challenge')!.length).toBe(43);
  });

  it('turns a valid callback into an identity, once', async () => {
    const p = idp();
    const o = new Oidc(cfg, p.http);
    const { state } = p.authorize(await o.begin(REDIRECT, 'a1'));
    expect(await o.complete('good-code', state)).toEqual({ attempt: 'a1', identity: { sub: 'u-1', email: 'ada@acme.test', name: 'Ada' } });
    await expect(o.complete('good-code', state)).rejects.toThrow(/expired or was not started/);
  });

  it('refuses a state it did not issue or that went stale', async () => {
    let now = Date.now();
    const p = idp();
    const o = new Oidc(cfg, p.http, () => now);
    await expect(o.complete('good-code', 'forged')).rejects.toThrow(/was not started here/);
    const { state } = p.authorize(await o.begin(REDIRECT, 'a1'));
    now += 11 * 60_000;
    await expect(o.complete('good-code', state)).rejects.toThrow(/expired/);
  });

  it('refuses a discovery document that belongs to another issuer', async () => {
    const o = new Oidc(cfg, idp({ discoveryIssuer: 'https://evil.example.com' }).http);
    await expect(o.begin(REDIRECT, 'a1')).rejects.toThrow(/different issuer/);
  });

  it('turns away the code when the issuer does', async () => {
    const p = idp({ tokenStatus: 400 });
    await expect(signIn(new Oidc(cfg, p.http), p)).rejects.toThrow(/refused the sign-in code/);
  });

  const bad: [string, (p: ReturnType<typeof idp>) => void, RegExp][] = [
    ['an issuer that is not ours', (p) => (p.state.claims.iss = 'https://evil.example.com'), /someone else/],
    ['another application’s audience', (p) => (p.state.claims.aud = 'other'), /another application/],
    ['several audiences without our authorised party', (p) => (p.state.claims.aud = ['cid', 'other']), /authorised for another/],
    ['an expired token', (p) => (p.state.claims.exp = Math.floor(Date.now() / 1000) - 3600), /expired/],
    ['a token from the future', (p) => (p.state.claims.iat = Math.floor(Date.now() / 1000) + 3600), /future/],
    ['another sign-in’s nonce', (p) => (p.state.claims.nonce = 'replayed'), /does not belong to this sign-in/],
    ['no subject', (p) => (p.state.claims.sub = ''), /no subject/],
    ['a signature from another key', (p) => (p.state.signWith = p.stranger.privateKey), /signature is invalid/],
    ['an unpublished key id', (p) => (p.state.header.kid = 'k2'), /does not publish/],
    ['no signature at all', (p) => (p.state.header.alg = 'none'), /unsupported algorithm/],
    ['a symmetric algorithm', (p) => (p.state.header.alg = 'HS256'), /unsupported algorithm/],
    ['an e-mail address the issuer did not verify', (p) => (p.state.claims.email_verified = false), /not verified/],
  ];
  for (const [what, tamper, why] of bad) {
    it(`rejects ${what}`, async () => {
      const p = idp();
      tamper(p);
      const err = await signIn(new Oidc(cfg, p.http), p).catch((e) => e);
      expect(err).toBeInstanceOf(OidcError);
      expect(err.message).toMatch(why);
    });
  }

  it('lets only the allowed e-mail domains in', async () => {
    const p = idp();
    const o = new Oidc({ ...cfg, allowedDomains: ['acme.test'] }, p.http);
    expect((await signIn(o, p)).identity.email).toBe('ada@acme.test');
    p.state.claims.email = 'eve@evil.test';
    await expect(signIn(o, p)).rejects.toThrow(/not allowed/);
    p.state.claims.email = undefined;
    await expect(signIn(o, p)).rejects.toThrow(/not allowed/);
  });

  it('asks the userinfo endpoint for an e-mail address the token left out', async () => {
    const p = idp();
    p.state.claims.email = undefined;
    p.state.userinfo = { sub: 'u-1', email: 'ada@acme.test' };
    expect((await signIn(new Oidc(cfg, p.http), p)).identity.email).toBe('ada@acme.test');
    p.state.userinfo = { sub: 'someone-else', email: 'eve@evil.test' };
    expect((await signIn(new Oidc(cfg, p.http), p)).identity.email).toBeNull();
  });
});

describe('OpenID Connect sign-in routes', () => {
  const PUBLIC = 'https://factory.example.com';
  function setup() {
    const p = idp();
    const db = openDb(':memory:');
    const manager = new RunManager(alive);
    const options = { db, users: new Users(db), publicUrl: PUBLIC, oidc: cfg, fetch: p.http, selfUrl: 'http://localhost:4317' };
    const deps = buildDeps(manager, options);
    const app = createApp(manager, options, deps);
    const call = (path: string, init: RequestInit = {}, host = 'factory.example.com') => app.request(`${PUBLIC}${path}`, { ...init, headers: { host, ...(init.headers as object) } });
    const post = (path: string, body: unknown = {}, host?: string) => call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'x-legos': '1', 'content-type': 'application/json' } }, host);
    const start = async (attempt = 'attempt-0123456789abcdef') => p.authorize((await (await post('/auth/providers/oidc', { attempt })).json()).url);
    return { p, call, post, start, deps };
  }
  const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];

  it('offers the provider by label, and PIN only on this machine', async () => {
    const { call } = setup();
    expect(await (await call('/auth/me')).json()).toMatchObject({ providers: [{ id: 'oidc', label: 'Acme SSO' }], pin: false, users: [] });
    expect(await (await call('/auth/me', {}, 'localhost:4317')).json()).toMatchObject({ providers: [{ id: 'oidc', label: 'Acme SSO' }], pin: true });
  });

  it('signs a person in from the callback, and hands the cookie to the app that was waiting', async () => {
    const { p, call, start } = setup();
    const { state } = await start();
    expect(p.state.redirect).toBe(`${PUBLIC}/auth/oidc/callback`);
    const cb = await call(`/auth/oidc/callback?code=good-code&state=${state}`);
    expect(cb.status).toBe(200);
    expect(cb.headers.get('set-cookie')).toMatch(/Secure/);
    const me = await (await call('/auth/me', { headers: { cookie: cookieOf(cb) } })).json();
    expect(me).toMatchObject({ authenticated: true, user: { kind: 'oidc', email: 'ada@acme.test', name: 'Ada' } });

    const claim = await call('/auth/claim?attempt=attempt-0123456789abcdef');
    expect(claim.status).toBe(200);
    expect((await call('/auth/claim?attempt=attempt-0123456789abcdef')).status).toBe(404);

    const ws = await (await call('/api/workspaces', { headers: { cookie: cookieOf(cb) } })).json();
    expect(ws.workspaces).toEqual([expect.objectContaining({ kind: 'personal', role: 'owner' })]);
  });

  it('is the same user next time', async () => {
    const { call, start } = setup();
    const ids: string[] = [];
    for (const attempt of ['attempt-0123456789abcdef', 'attempt-fedcba9876543210']) {
      const cb = await call(`/auth/oidc/callback?code=good-code&state=${(await start(attempt)).state}`);
      ids.push((await (await call('/auth/me', { headers: { cookie: cookieOf(cb) } })).json()).user.id);
    }
    expect(ids[0]).toBe(ids[1]);
  });

  it('refuses forged, repeated and failed callbacks', async () => {
    const { call, start } = setup();
    expect((await call('/auth/oidc/callback?code=good-code&state=forged')).status).toBe(400);
    expect((await call('/auth/oidc/callback?error=access_denied&error_description=nope')).status).toBe(400);
    expect((await call('/auth/oidc/callback')).status).toBe(400);
    const { state } = await start();
    expect((await call(`/auth/oidc/callback?code=wrong&state=${state}`)).status).toBe(400);
    expect((await call(`/auth/oidc/callback?code=good-code&state=${state}`)).status).toBe(400);
  });

  it('keeps PIN users off a control plane reached over the network', async () => {
    const { post } = setup();
    expect((await post('/auth/users', { name: 'Eve', pin: '123456' })).status).toBe(403);
    expect((await post('/auth/login', { name: 'Eve', pin: '123456' })).status).toBe(403);
    expect((await post('/auth/users', { name: 'Eve', pin: '123456' }, 'localhost:4317')).status).toBe(200);
  });

  it('answers 404 for a provider that is not configured', async () => {
    const { post } = setup();
    expect((await post('/auth/providers/workbench', { attempt: '' })).status).toBe(404);
    expect((await post('/auth/providers/nope', { attempt: '' })).status).toBe(404);
  });
});
