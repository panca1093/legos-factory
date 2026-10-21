import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// Every test file gets its own home, so nothing here can read or delete the developer's real data or git config.
const home = mkdtempSync(join(tmpdir(), 'lf-home-'));
Object.assign(process.env, {
  HOME: home,
  LEGOS_WORKSPACES: join(home, 'workspaces'),
  LEGOS_DB: join(home, 'factory.db'),
  LEGOS_SETTINGS: join(home, 'settings.json'),
  LEGOS_HUB_DB: join(home, 'hub.sqlite'),
  CLAUDE_PROJECTS_DIR: join(home, 'claude-projects'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});

afterAll(() => rmSync(home, { recursive: true, force: true }));
