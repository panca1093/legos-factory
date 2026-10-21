import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { openDb } from '../server/db.ts';
import { WorkItems } from '../server/work-items.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const db = openDb(':memory:');
  const workspaces = mkdtempSync(join(tmpdir(), 'lf-work-items-shape-'));
  cleanups.push(() => {
    db.close();
    rmSync(workspaces, { recursive: true, force: true });
  });
  const items = new WorkItems(db);
  items.create('local', 'PROJ-123');
  items.addRepo('local', 'PROJ-123', 'acme/api');
  const app = createApp(new RunManager(), { db, workspaces });
  const req = (path: string, method = 'GET') => app.request(`http://localhost:4317${path}`, { method, headers: { host: 'localhost:4317', 'x-legos': '1' } });
  return { db, req };
}

describe('work item API shape', () => {
  it('returns the new fields with defaults', async () => {
    const { req } = setup();
    const response = await req('/api/work-items');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ ticket: 'PROJ-123', source: 'jira', plan: null, repos: [{ name: 'acme/api', stage: 'building', attempt: 0 }] }] });
  });

  it('returns persisted source, parsed plan and repo progress', async () => {
    const { db, req } = setup();
    db.prepare('update work_items set source = ?, plan = ? where owner = ? and ticket = ?').run('local', JSON.stringify({
      tasks: [{ id: 'T1', do: 'Add retry', repo: 'acme/api', test: 'retry.test.ts', needs: [], touches: ['retry.ts'], state: 'paused' }], error: null,
    }), 'local', 'PROJ-123');
    db.prepare('update work_item_repos set stage = ?, attempt = ? where owner = ? and ticket = ?').run('pr_review', 2, 'local', 'PROJ-123');
    const response = await req('/api/work-items');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{
      source: 'local',
      plan: { tasks: [{ id: 'T1', do: 'Add retry', repo: 'acme/api', test: 'retry.test.ts', needs: [], touches: ['retry.ts'], state: 'paused' }], error: null },
      repos: [{ name: 'acme/api', stage: 'pr_review', attempt: 2 }],
    }] });
  });

  it('the three gate endpoints are served', async () => {
    const { req } = setup();
    const responses = [];
    for (const path of [
      '/api/work-items/PROJ-123/approve-spec',
      `/api/work-items/PROJ-123/prs/${encodeURIComponent('acme/api')}/approve`,
      `/api/work-items/PROJ-123/prs/${encodeURIComponent('acme/api')}/merge`,
    ]) {
      responses.push(await req(path, 'POST'));
    }
    expect(responses.map((response) => response.status)).toEqual([200, 409, 409]);
    expect(await responses[0].json()).toEqual({ ok: true });
    expect(await responses[1].json()).toEqual({ error: 'that PR is not waiting for a review' });
    expect(await responses[2].json()).toEqual({ error: 'that PR is not ready to merge' });
  });
});
