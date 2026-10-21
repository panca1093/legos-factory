import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One scratch root for the whole run, removed after every worker is done (background timers may still write to it before that).
export default function () {
  const root = mkdtempSync(join(tmpdir(), 'lf-tests-'));
  process.env.LF_TEST_TMP = root;
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
