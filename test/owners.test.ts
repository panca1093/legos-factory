import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import { loadSettings } from '../server/policy.ts';
import { Users } from '../server/users.ts';

let root: string;
let path: string;
let original: Record<string, string | undefined>;
const databases: ReturnType<typeof openDb>[] = [];

beforeEach(async () => {
  original = Object.fromEntries(['LEGOS_AUTH', 'LEGOS_OWNERS', 'LEGOS_SETTINGS'].map((key) => [key, process.env[key]]));
  delete process.env.LEGOS_AUTH;
  delete process.env.LEGOS_OWNERS;
  root = await mkdtemp(join(tmpdir(), 'lf-owners-'));
  path = join(root, 'settings.json');
  process.env.LEGOS_SETTINGS = path;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const db of databases.splice(0)) db.close();
  await rm(root, { recursive: true, force: true });
});

function setup(signedIn = true) {
  const db = openDb(':memory:');
  databases.push(db);
  const users = signedIn ? new Users(db) : null;
  const app = createApp(new RunManager(), { db, users });
  const user = users?.upsertExternal('workbench', 'acme-user', 'Ada', 'ada@example.com');
  const request = (endpoint: string, body?: unknown, authenticated = true) => app.request(`http://localhost${endpoint}`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: { host: 'localhost', 'x-legos': '1', 'content-type': 'application/json', ...(authenticated && user && { cookie: `lf_sid=${users!.issue(user.id)}` }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { request };
}

describe('owners', () => {
  it('an owner can save automation', async () => {
    const { request } = setup();
    const automation = { ...(await loadSettings()).automation, allowlist: ['go vet'] };
    for (const owner of [' ada@example.com , other@example.com ', ' ADA@EXAMPLE.COM ']) {
      process.env.LEGOS_OWNERS = owner;
      expect((await request('/api/settings/automation', automation)).status).toBe(200);
      expect(JSON.parse(await readFile(path, 'utf8')).automation).toEqual(automation);
    }
  });

  it('a non-owner gets 403', async () => {
    const { request } = setup();
    const originalSettings = JSON.stringify({ custom: 'acme', automation: (await loadSettings()).automation });
    await writeFile(path, originalSettings);
    for (const owner of [undefined, '', 'other-ada@example.com, ada@other.example.com', 'other@example.com']) {
      if (owner === undefined) delete process.env.LEGOS_OWNERS;
      else process.env.LEGOS_OWNERS = owner;
      const response = await request('/api/settings/automation', { ...(await loadSettings()).automation, allowlist: ['go vet'] });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'only owners can change automation' });
      expect(await readFile(path, 'utf8')).toBe(originalSettings);
      expect((await request('/api/settings/automation')).status).toBe(200);
    }
  });

  it('an owner is matched by e-mail', async () => {
    const { request } = setup();
    for (const owner of ['ada@example.com', 'ADA@EXAMPLE.COM', ' ada@example.com , other@example.com ']) {
      process.env.LEGOS_OWNERS = owner;
      expect(await (await request('/auth/me')).json()).toMatchObject({ authenticated: true, isOwner: true, user: { name: 'Ada', email: 'ada@example.com' } });
    }
  });

  it('a name in the owners list is not an owner', async () => {
    const { request } = setup();
    process.env.LEGOS_OWNERS = 'Ada';
    expect(await (await request('/auth/me')).json()).toMatchObject({ authenticated: true, isOwner: false });
  });

  it('me reports isOwner', async () => {
    const { request } = setup();
    for (const [owner, expected] of [['ADA', false], ['ADA@EXAMPLE.COM', true], ['other@example.com', false]] as const) {
      process.env.LEGOS_OWNERS = owner;
      expect(await (await request('/auth/me')).json()).toMatchObject({ authenticated: true, isOwner: expected, user: { name: 'Ada' } });
    }
    delete process.env.LEGOS_OWNERS;
    expect(await (await request('/auth/me')).json()).toMatchObject({ authenticated: true, isOwner: false });
    process.env.LEGOS_OWNERS = 'ada@example.com';
    expect(await (await request('/auth/me', undefined, false)).json()).toMatchObject({ authenticated: false, isOwner: false });
  });

  it('sign-in off makes the local user an owner', async () => {
    process.env.LEGOS_AUTH = 'off';
    const { request } = setup(false);
    expect(await (await request('/auth/me')).json()).toMatchObject({ authEnabled: false, authenticated: true, user: null, isOwner: true });
    expect((await request('/api/settings/automation', (await loadSettings()).automation)).status).toBe(200);
  });
});
