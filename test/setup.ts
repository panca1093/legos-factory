import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every test file gets its own home and temp dir, so nothing here can touch the developer's real data or git config,
// and test/global.ts removes it all at the end.
const home = mkdtempSync(join(process.env.LF_TEST_TMP ?? tmpdir(), 'home-'));
mkdirSync(join(home, 'tmp'));
Object.assign(process.env, {
  HOME: home,
  TMPDIR: join(home, 'tmp'),
  LEGOS_WORKSPACES: join(home, 'workspaces'),
  LEGOS_DB: join(home, 'factory.db'),
  LEGOS_SETTINGS: join(home, 'settings.json'),
  LEGOS_HUB_DB: join(home, 'hub.sqlite'),
  CLAUDE_PROJECTS_DIR: join(home, 'claude-projects'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});
