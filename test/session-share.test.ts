import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityLog } from '../server/activity.ts';
import { createApp } from '../server/app.ts';
import { RunManager, type QueryFn } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import type { Run } from '../shared/types.ts';

const SCRATCH_SESSION = '11111111-1111-1111-1111-111111111111';
const PROJECT_SESSION = '22222222-2222-2222-2222-222222222222';

const idle = (() => {
  const it = (async function* () {})() as any;
  it.interrupt = async () => {};
  return it;
}) as unknown as QueryFn;

let root: string;
let chats: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lf-session-share-'));
  chats = join(root, 'chats');
  const project = join(root, 'project');
  await mkdir(chats, { recursive: true });
  await mkdir(project, { recursive: true });
  for (const [key, value] of Object.entries({
    LEGOS_SETTINGS: join(root, 'settings.json'),
    CLAUDE_PROJECTS_DIR: join(root, 'projects'),
    LEGOS_CHATS_DIR: chats,
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  // every folder under the root is shared, so only the scratch folder can make a session private
  await writeFile(join(root, 'settings.json'), JSON.stringify({ share: { default: 'full', rules: [{ path: root, level: 'full' }] } }));
  await writeSession(SCRATCH_SESSION, chats);
  await writeSession(PROJECT_SESSION, project);
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function writeSession(id: string, cwd: string) {
  const dir = join(root, 'projects', 'session');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'u1', timestamp: '2026-10-01T10:00:00.000Z', cwd })}\n`,
  );
}

async function sessions() {
  const db = openDb(':memory:');
  try {
    const log = new ActivityLog(db);
    const now = new Date().toISOString();
    await log.record({ id: 'r1', owner: 'local', sessionId: SCRATCH_SESSION, kind: 'chat', cwd: chats, prompt: 'hello', status: 'completed', startedAt: now, lastEventAt: now } as Run, 'local');
    await log.record({ id: 'r2', owner: 'local', sessionId: PROJECT_SESSION, kind: 'chat', cwd: join(root, 'project'), prompt: 'hello', status: 'completed', startedAt: now, lastEventAt: now } as Run, 'local');
    const app = createApp(new RunManager(idle), { db });
    const res = await app.request('http://localhost:4317/api/sessions', { headers: { host: 'localhost:4317' } });
    expect(res.status).toBe(200);
    const list = (await res.json()) as { id: string; share: string }[];
    return new Map(list.map((s) => [s.id, s.share]));
  } finally {
    db.close();
  }
}

describe('the share shown in the sessions list', () => {
  it('a scratch chat is shown as private in the sessions list', async () => {
    const shares = await sessions();
    expect(shares.get(SCRATCH_SESSION)).toBe('private');
  });

  it('a session in another folder keeps the settings share', async () => {
    const shares = await sessions();
    expect(shares.get(PROJECT_SESSION)).toBe('full');
  });
});
