import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { loadSettings, saveAutomation } from '../server/policy.ts';

// Lets a test make the temp write fail the way a full disk would, without touching the real settings file.
const fsFailure = vi.hoisted(() => ({ writeFails: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    writeFile: async (file: unknown, data: unknown, options?: unknown) => {
      if (fsFailure.writeFails && typeof file === 'string' && file !== path) {
        throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' });
      }
      return actual.writeFile(file as any, data as any, options as any);
    },
  };
});

const defaults = {
  allowlist: ['npm test', 'npm run build', 'npm run lint', 'go test', 'go vet'],
  routing: [],
  models: { foreman: 'opus', builder: 'sonnet', inspector: 'opus', cataloger: 'haiku' },
  parallelBuilders: 0,
  reviewAttempts: 3,
  brainstorm: 'optional' as const,
};

let root: string;
let path: string;
let originalSettings: string | undefined;
const app = createApp(new RunManager());
const get = () => app.request('http://localhost/api/settings/automation', { headers: { host: 'localhost' } });
const put = (body: unknown) => app.request('http://localhost/api/settings/automation', {
  method: 'PUT', headers: { host: 'localhost', 'x-legos': '1', 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(async () => {
  originalSettings = process.env.LEGOS_SETTINGS;
  root = await mkdtemp(join(tmpdir(), 'lf-automation-'));
  path = join(root, 'settings.json');
  process.env.LEGOS_SETTINGS = path;
});

afterEach(async () => {
  if (originalSettings === undefined) delete process.env.LEGOS_SETTINGS;
  else process.env.LEGOS_SETTINGS = originalSettings;
  await rm(root, { recursive: true, force: true });
});

describe('automation settings', () => {
  it('returns defaults when settings.json has no automation key', async () => {
    await writeFile(path, JSON.stringify({ share: { default: 'private', rules: [] } }));
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(defaults);
    expect(await loadSettings()).toMatchObject({ automation: defaults });
  });

  it('returns defaults when settings.json is missing or broken', async () => {
    expect(await loadSettings()).toMatchObject({ automation: defaults, error: null });
    await writeFile(path, '{');
    expect(await loadSettings()).toMatchObject({ automation: defaults, error: expect.stringContaining('could not read') });
  });

  it('returns defaults when stored automation is invalid', async () => {
    for (const automation of [null, {}, { ...defaults, reviewAttempts: 6 }, { ...defaults, models: { ...defaults.models, inspector: 'sonnet' } }]) {
      await writeFile(path, JSON.stringify({ automation }));
      expect(await loadSettings()).toMatchObject({ automation: defaults });
    }
  });

  it('keeps valid keys when one key is invalid', async () => {
    const automation = { ...defaults, allowlist: ['go vet'], routing: [{ id: 'r1', kind: 'repo', value: 'acme/api', on: true }], models: { foreman: 'haiku', builder: 'opus', inspector: 'sonnet', cataloger: 'off' }, parallelBuilders: 2, reviewAttempts: 6, brainstorm: 'always' };
    await writeFile(path, JSON.stringify({ automation }));
    expect(await loadSettings()).toMatchObject({ automation: { ...automation, reviewAttempts: 3 } });
    await writeFile(path, JSON.stringify({ automation: { ...automation, reviewAttempts: 2, models: { ...automation.models, inspector: 'opus' } } }));
    expect(await loadSettings()).toMatchObject({ automation: { ...automation, reviewAttempts: 2, models: defaults.models }, automationErrors: ['models'] });
  });

  it('reports which keys fell back', async () => {
    const invalid = { allowlist: [' '], routing: [{}], models: {}, parallelBuilders: 5, reviewAttempts: 0, brainstorm: 'never' };
    for (const key of Object.keys(defaults)) {
      await writeFile(path, JSON.stringify({ automation: { ...defaults, [key]: invalid[key as keyof typeof invalid] } }));
      expect(await loadSettings()).toMatchObject({ automation: defaults, automationErrors: [key] });
      const missing: Record<string, unknown> = { ...defaults };
      delete missing[key];
      await writeFile(path, JSON.stringify({ automation: missing }));
      expect(await loadSettings()).toMatchObject({ automation: defaults, automationErrors: [key] });
    }
    await writeFile(path, JSON.stringify({ automation: defaults }));
    expect(await loadSettings()).toMatchObject({ automationErrors: [] });
    await rm(path);
    expect(await loadSettings()).toMatchObject({ automationErrors: Object.keys(defaults) });
    await writeFile(path, '{');
    expect(await loadSettings()).toMatchObject({ automationErrors: Object.keys(defaults) });
  });

  it('a failed write leaves the old settings.json intact', async () => {
    const old = JSON.stringify({ custom: 'acme', automation: defaults });
    await writeFile(path, old);
    fsFailure.writeFails = true;
    try {
      await expect(saveAutomation({ ...defaults, allowlist: ['go vet'] })).rejects.toThrow();
    } finally {
      fsFailure.writeFails = false;
    }
    expect(await readFile(path, 'utf8')).toBe(old);
  });

  it('two saves at the same time do not collide', async () => {
    const a = { ...defaults, allowlist: ['go vet'] };
    const b = { ...defaults, allowlist: ['npm run build'], parallelBuilders: 2 };
    await Promise.all([saveAutomation(a), saveAutomation(b)]);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect([a, b]).toContainEqual(raw.automation);
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('the settings file keeps its mode', async () => {
    await writeFile(path, JSON.stringify({ automation: defaults }));
    await chmod(path, 0o600);
    await saveAutomation({ ...defaults, allowlist: ['go vet'] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('keeps other keys when saving', async () => {
    const other = { share: { default: 'full', rules: [] }, jiraFlow: { todo: 'Queued' }, custom: { nested: [1, 'acme'] } };
    await writeFile(path, JSON.stringify(other));
    const automation = { ...defaults, allowlist: ['go vet'], routing: [{ id: 'r1', kind: 'repo', value: 'acme/api', on: true }], parallelBuilders: 2, brainstorm: 'always' };
    const res = await put(automation);
    expect(res.status).toBe(200);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ...other, automation });
    expect(await (await get()).json()).toEqual(automation);
  });

  it('saves automation when settings.json does not exist', async () => {
    expect((await put(defaults)).status).toBe(200);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ automation: defaults });
  });

  it('rejects an inspector model equal to the builder model', async () => {
    const res = await put({ ...defaults, models: { ...defaults.models, inspector: 'sonnet' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/inspector.*differ.*builder/i);
    expect(await readFile(path, 'utf8').catch(() => null)).toBeNull();
  });

  it('rejects reviewAttempts outside 1–5', async () => {
    for (const reviewAttempts of [0, 6, 1.5]) {
      expect((await put({ ...defaults, reviewAttempts })).status).toBe(400);
    }
    for (const reviewAttempts of [1, 5]) {
      expect((await put({ ...defaults, reviewAttempts })).status).toBe(200);
    }
  });

  it('rejects empty allowlist entries and invalid parallel builder counts', async () => {
    for (const body of [{ ...defaults, allowlist: [' '] }, { ...defaults, parallelBuilders: -1 }, { ...defaults, parallelBuilders: 5 }, { ...defaults, parallelBuilders: 0.5 }]) {
      expect((await put(body)).status).toBe(400);
    }
    expect((await put({ ...defaults, parallelBuilders: 4 })).status).toBe(200);
  });
});
