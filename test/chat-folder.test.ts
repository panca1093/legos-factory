import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDeps } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { chatsDir, launchRun, launchSchema } from '../server/launch-run.ts';

let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lf-chat-folder-'));
  for (const [key, value] of Object.entries({
    LEGOS_SETTINGS: join(root, 'settings.json'),
    LEGOS_WORKSPACES: join(root, 'workspaces'),
    LEGOS_DB: join(root, 'factory.db'),
    LEGOS_CHATS_DIR: join(root, 'chats'),
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

// maxLive 0 keeps every run queued, so no Claude process is started.
function setup() {
  const runs = new RunManager(undefined, undefined, 0);
  const deps = buildDeps(runs, { workspaces: join(root, 'workspaces') });
  const launch = (extra: Record<string, unknown> = {}) =>
    launchRun(deps, 'local', launchSchema.parse({ prompt: 'What should we build?', kind: 'chat', ...extra }));
  return { deps, launch };
}

describe('a chat without a folder', () => {
  it('a chat with no folder starts in the scratch folder', async () => {
    const { deps, launch } = setup();
    try {
      const run = await launch();
      expect(run.cwd).toBe(join(root, 'chats'));
      expect(run.cwd).toBe(chatsDir());
      expect(run.cwd.startsWith(root)).toBe(true);
      expect((await stat(run.cwd)).isDirectory()).toBe(true);
    } finally {
      deps.db.close();
    }
  });

  it('a chat with a folder keeps it', async () => {
    const folder = join(root, 'project');
    await mkdir(folder);
    const { deps, launch } = setup();
    try {
      const run = await launch({ cwd: folder });
      expect(run.cwd).toBe(folder);
    } finally {
      deps.db.close();
    }
  });

  it('a chat in the scratch folder is not shared to the hub', async () => {
    await writeFile(join(root, 'settings.json'), JSON.stringify({ share: { default: 'full', rules: [{ path: root, level: 'full' }] } }));
    const { deps, launch } = setup();
    try {
      expect((await launch()).share).toBe('private');
      const folder = join(root, 'project');
      await mkdir(folder);
      expect((await launch({ cwd: folder })).share).toBe('full');
    } finally {
      deps.db.close();
    }
  });
});
