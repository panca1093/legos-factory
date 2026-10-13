import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Account } from '../server/account.ts';
import { createApp } from '../server/app.ts';
import { RunManager, type QueryFn } from '../server/claude-runs.ts';

const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'lf-acct-')), 'account.json');

const idle = (() => {
  const it = (async function* () {})() as any;
  it.interrupt = async () => {};
  return it;
}) as unknown as QueryFn;

beforeAll(() => {
  process.env.CLAUDE_PROJECTS_DIR = join(import.meta.dirname, 'fixtures/projects');
  process.env.LEGOS_SETTINGS = join(import.meta.dirname, 'fixtures/settings/app.json');
});

describe('local account', () => {
  it('sets up once with a 6-digit PIN and stores it owner-only', async () => {
    const path = tmpPath();
    const a = new Account(path);
    await expect(a.setup('Ada', '12345')).rejects.toThrow(/6 digits/);
    const cookie = await a.setup('Ada', '123456');
    expect(await a.verify(cookie)).toBe(true);
    expect(await a.name()).toBe('Ada');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(a.setup('Eve', '000000')).rejects.toThrow(/already exists/);
    // survives a restart
    expect(await new Account(path).verify(cookie)).toBe(true);
  });

  it('rejects tampered and expired cookies', async () => {
    let now = Date.now();
    const a = new Account(tmpPath(), () => now);
    const cookie = await a.setup('Ada', '123456');
    const [v, exp, sig] = cookie.split('.');
    expect(await a.verify(`${v}.${Number(exp) + 1}.${sig}`)).toBe(false);
    expect(await a.verify(`${cookie}x`)).toBe(false);
    expect(await a.verify(undefined)).toBe(false);
    now += 31 * 24 * 3600_000;
    expect(await a.verify(cookie)).toBe(false);
  });

  it('locks out after repeated wrong PINs, doubling each time', async () => {
    let now = Date.now();
    const a = new Account(tmpPath(), () => now);
    await a.setup('Ada', '123456');
    for (let i = 0; i < 4; i++) expect(await a.login('000000')).toEqual({ ok: false, retryAfterMs: null });
    expect(await a.login('000000')).toEqual({ ok: false, retryAfterMs: 30_000 });
    // even the right PIN waits out the lock
    expect((await a.login('123456')).ok).toBe(false);
    now += 30_000;
    expect(await a.login('000000')).toEqual({ ok: false, retryAfterMs: 60_000 });
    now += 60_000;
    const ok = await a.login('123456');
    expect(ok.ok).toBe(true);
    // success resets the counter
    expect(await a.login('000000')).toEqual({ ok: false, retryAfterMs: null });
  });
});

describe('PIN gate', () => {
  const setup = () => {
    const app = createApp(new RunManager(idle), { account: new Account(tmpPath()) });
    const req = (path: string, init: RequestInit = {}, cookie?: string) =>
      app.request(`http://localhost:4317${path}`, { ...init, headers: { host: 'localhost:4317', ...(cookie && { cookie }), ...(init.headers as any) } });
    const post = (path: string, body: unknown, cookie?: string) =>
      req(path, { method: 'POST', body: JSON.stringify(body), headers: { 'x-legos': '1', 'content-type': 'application/json' } }, cookie);
    return { req, post };
  };
  const cookieOf = (r: Response) => r.headers.get('set-cookie')!.split(';')[0];

  it('asks for setup first, then gates the API on the PIN', async () => {
    const { req, post } = setup();
    expect(await (await req('/auth/me')).json()).toMatchObject({ authEnabled: true, setupRequired: true, authenticated: false });
    expect((await req('/api/sessions')).status).toBe(401);
    expect((await post('/auth/setup', { name: 'Ada', pin: '12ab56' })).status).toBe(400);

    const s = await post('/auth/setup', { name: 'Ada', pin: '123456' });
    expect(s.status).toBe(200);
    expect(s.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect((await req('/api/sessions', {}, cookieOf(s))).status).toBe(200);
    expect((await post('/auth/setup', { name: 'Eve', pin: '000000' })).status).toBe(409);

    expect(await (await req('/auth/me')).json()).toMatchObject({ setupRequired: false, authenticated: false });
    expect((await post('/auth/login', { pin: '654321' })).status).toBe(401);
    const l = await post('/auth/login', { pin: '123456' });
    expect(await (await req('/auth/me', {}, cookieOf(l))).json()).toMatchObject({ authenticated: true, user: { name: 'Ada' } });
  });

  it('answers 429 while locked out, and requires x-legos on auth writes', async () => {
    const { req, post } = setup();
    await post('/auth/setup', { name: 'Ada', pin: '123456' });
    for (let i = 0; i < 4; i++) await post('/auth/login', { pin: '000000' });
    const locked = await post('/auth/login', { pin: '000000' });
    expect(locked.status).toBe(429);
    expect((await locked.json()).retryAfterMs).toBe(30_000);
    expect((await req('/auth/login', { method: 'POST', body: '{"pin":"123456"}' })).status).toBe(403);
  });

  it('logout clears the cookie', async () => {
    const { post } = setup();
    const s = await post('/auth/setup', { name: 'Ada', pin: '123456' });
    const out = await post('/auth/logout', {}, cookieOf(s));
    expect(out.headers.get('set-cookie')).toMatch(/lf_sid=;.*Max-Age=0/);
  });
});
