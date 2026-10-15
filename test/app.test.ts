import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ActivityLog } from '../server/activity.ts';
import { createApp } from '../server/app.ts';
import { RunManager, type QueryFn } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import type { Run } from '../shared/types.ts';

beforeAll(() => {
  process.env.CLAUDE_PROJECTS_DIR = join(import.meta.dirname, 'fixtures/projects');
  process.env.LEGOS_SETTINGS = join(import.meta.dirname, 'fixtures/settings/app.json');
});

const idle = (() => {
  const it = (async function* () {})() as any;
  it.interrupt = async () => {};
  return it;
}) as unknown as QueryFn;

// of the three transcripts on disk, only this one was started from legos-factory
const MINE = '11111111-1111-1111-1111-111111111111';
const db = openDb(':memory:');
const now = new Date().toISOString();
await new ActivityLog(db).record(
  { id: 'r0', owner: 'local', sessionId: MINE, kind: 'chat', cwd: '/tmp', prompt: 'x', status: 'completed', startedAt: now, lastEventAt: now } as Run,
  'local',
);
const app = createApp(new RunManager(idle), { db });
const req = (path: string, init: RequestInit & { host?: string } = {}) =>
  app.request(`http://x${path}`, { ...init, headers: { host: init.host ?? 'localhost:4317', ...(init.headers as any) } });
const post = (path: string, body: unknown, headers: Record<string, string> = { 'x-legos': '1' }) =>
  req(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

describe('api guard', () => {
  it('rejects non-local Host (DNS rebinding)', async () => {
    expect((await req('/api/sessions', { host: 'evil.example:4317' })).status).toBe(403);
  });

  it('rejects POST without the x-legos header (cross-site form/fetch)', async () => {
    expect((await post('/api/runs', { cwd: '/tmp', prompt: 'hi' }, {})).status).toBe(403);
  });
});

describe('api', () => {
  it('lists only sessions started here, never the machine\'s other Claude sessions', async () => {
    const res = await req('/api/sessions');
    expect(res.status).toBe(200);
    expect((await res.json()).map((s: any) => s.id)).toEqual([MINE]);
    expect((await req(`/api/sessions/${MINE}`)).status).toBe(200);
    expect((await req('/api/sessions/22222222-2222-2222-2222-222222222222')).status).toBe(404);
    expect((await post('/api/runs', { cwd: '/tmp', prompt: 'hi', resume: '22222222-2222-2222-2222-222222222222' })).status).toBe(404);
  });

  it('validates run launch input', async () => {
    expect((await post('/api/runs', { cwd: '/tmp', prompt: '' })).status).toBe(400);
    expect((await post('/api/runs', { cwd: 'relative/dir', prompt: 'hi' })).status).toBe(400);
    expect((await post('/api/runs', { cwd: '/definitely/not/here', prompt: 'hi' })).status).toBe(400);
    expect((await post('/api/runs', { cwd: '/tmp', prompt: 'hi' })).status).toBe(201);
  });

  it('validates model and message input', async () => {
    expect((await post('/api/runs', { cwd: '/tmp', prompt: 'hi', model: 'opus; rm -rf /' })).status).toBe(400);
    expect((await post('/api/runs', { cwd: '/tmp', prompt: 'hi', model: 'claude-opus-5-5[1m]' })).status).toBe(201);
    expect((await post('/api/runs/nope/messages', { text: '' })).status).toBe(400);
    expect((await post('/api/runs/nope/messages', { text: 'hi' })).status).toBe(409);
    expect((await post('/api/runs/nope/model', { model: 'bad model' })).status).toBe(400);
    expect((await post('/api/runs/nope/end', {})).status).toBe(409);
  });

  it('tags runs with a ticket and a share level', async () => {
    const auto = await (await post('/api/runs', { cwd: '/tmp', prompt: 'fix PROJ-2341 export' })).json();
    expect(auto).toMatchObject({ ticket: 'PROJ-2341', share: 'status' });
    const manual = await (await post('/api/runs', { cwd: '/tmp', prompt: 'hi', ticket: 'plat-7', stage: 'build', share: 'full' })).json();
    expect(manual).toMatchObject({ ticket: 'PLAT-7', stage: 'build', share: 'full' });
    expect(auto.stage).toBeNull();
    expect((await post('/api/runs', { cwd: '/tmp', prompt: 'hi', ticket: 'not a ticket' })).status).toBe(400);
    const none = await (await post('/api/runs', { cwd: '/', prompt: 'hi', share: 'public' })).json();
    expect(none).toMatchObject({ ticket: null, share: 'private' });
  });

  it('exposes resolved settings and per-folder policy', async () => {
    const settings = await (await req('/api/settings')).json();
    expect(settings.share.rules).toEqual([{ path: '/tmp', level: 'status' }]);
    expect(await (await req('/api/policy?cwd=/tmp')).json()).toMatchObject({ share: 'status' });
    expect((await req('/api/policy?cwd=relative')).status).toBe(400);
  });

  it('annotates sessions with share level from their folder', async () => {
    const list = await (await req('/api/sessions')).json();
    expect(list.length).toBe(1);
    expect(list.every((s: any) => s.share === 'status' && 'ticket' in s)).toBe(true); // fixtures live under /tmp
  });

  it('returns 410 for a decision that is no longer open', async () => {
    expect((await post('/api/decisions/nope', { behavior: 'allow' })).status).toBe(410);
    expect((await post('/api/decisions/nope', { behavior: 'maybe' })).status).toBe(400);
  });
});
