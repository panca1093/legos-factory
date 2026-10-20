import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActivityLog, toItem, toTeamItem } from '../server/activity.ts';
import { openDb } from '../server/db.ts';
import { createHub } from '../server/hub.ts';
import type { Run } from '../shared/types.ts';
import type { Workbench } from '../server/workbench.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'lf-act-'));

function run(over: Partial<Run> = {}): Omit<Run, 'events'> {
  const now = new Date().toISOString();
  return {
    id: 'r1', workspaceId: 'u1', owner: 'u1', repo: null, kind: 'task', fromTask: false, ticket: 'PROJ-1', stage: null, share: 'status', runtime: 'claude-code', sessionId: 's1', resumedFrom: null,
    cwd: '/work/acme/payments-api', prompt: 'Fix the thing\nwith details', permissionMode: 'default', status: 'running',
    requestedModel: 'default', model: 'claude-opus-5-5', startedAt: now, lastEventAt: now, endedAt: null, endedBy: null, turns: 1,
    error: null, estimatedCostUsd: 0.42, result: null, ...over,
  };
}

describe('ActivityLog', () => {
  it('records only real changes and survives a restart', async () => {
    const path = join(tmp(), 'factory.db');
    const log = new ActivityLog(openDb(path));
    expect(await log.record(run(), 'u1')).not.toBeNull();
    expect(await log.record(run(), 'u1')).toBeNull(); // same state: not written again
    await log.record(run({ status: 'completed', endedAt: new Date().toISOString() }), 'u1');

    const items = await new ActivityLog(openDb(path)).list('u1', Date.now() - 3600_000);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ runId: 'r1', status: 'completed', title: 'Fix the thing', project: 'payments-api', estimatedCostUsd: 0.42 });
  });

  it('marks runs that were still going as failed after a restart, unless a job can resume them', async () => {
    const path = join(tmp(), 'factory.db');
    const first = new ActivityLog(openDb(path));
    await first.record(run({ id: 'gone', status: 'idle' }), 'u1');
    await first.record(run({ id: 'queued', status: 'running' }), 'u1');
    await first.record(run({ id: 'done', status: 'completed' }), 'u1');
    const second = new ActivityLog(openDb(path));
    second.failOrphans(new Set(['queued']));
    const status = Object.fromEntries((await second.list('u1', 0)).map((i) => [i.runId, i.status]));
    expect(status).toEqual({ gone: 'failed', queued: 'running', done: 'completed' });
  });

  it('keeps each owner to their own runs and sessions', async () => {
    const log = new ActivityLog(openDb(':memory:'));
    await log.record(run({ id: 'a1', sessionId: 's-a' }), 'alice');
    await log.record(run({ id: 'a2', sessionId: 's-a' }), 'alice'); // resumed: same session, new run
    await log.record(run({ id: 'b1', sessionId: 's-b' }), 'bob');
    await log.record(run({ id: 'b2', sessionId: null }), 'bob'); // not started yet: no session
    expect((await log.list('alice', 0)).map((i) => i.runId).sort()).toEqual(['a1', 'a2']);
    expect(log.sessionIds('alice', 10)).toEqual(['s-a']);
    expect(log.sessionIds('bob', 10)).toEqual(['s-b']);
    expect(log.ownsSession('alice', 's-a')).toBe(true);
    expect(log.ownsSession('alice', 's-b')).toBe(false);
  });

  it('gives a session the ticket its runs were started with, never one guessed from text', async () => {
    const log = new ActivityLog(openDb(':memory:'));
    await log.record(run({ id: 'a1', sessionId: 's-a', ticket: null, prompt: 'fix PROJ-9' }), 'alice');
    await log.record(run({ id: 'a2', sessionId: 's-b', ticket: 'PROJ-2' }), 'alice');
    await log.record(run({ id: 'b1', sessionId: 's-b', ticket: 'PROJ-3' }), 'bob');
    expect(log.sessionTickets('alice')).toEqual(new Map([['s-b', 'PROJ-2']]));
  });

  it('team items never carry cost or share level', () => {
    const t = toTeamItem(toItem(run()));
    expect(t).not.toHaveProperty('estimatedCostUsd');
    expect(t).not.toHaveProperty('share');
  });
});

describe('team hub', () => {
  const wb = { whoami: async (t: string) => (t === 'tok-a' ? { id: 'a', email: 'a@acme.test', name: null } : t === 'tok-b' ? { id: 'b', email: 'b@acme.test', name: null } : null) } as unknown as Workbench;
  const hub = () => createHub({ workbench: wb, dbPath: ':memory:' });
  const post = (h: ReturnType<typeof hub>, token: string, items: unknown[]) =>
    h.request('http://hub/hub/events', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ items }) });

  it('rejects unknown tokens', async () => {
    const h = hub();
    expect((await post(h, 'forged', [])).status).toBe(401);
    expect((await h.request('http://hub/hub/team')).status).toBe(401);
  });

  it('stores items under the verified identity and shows everyone to every member', async () => {
    const h = hub();
    // extra fields (a spoofed email, a cost) are ignored by the hub
    const item = { ...toTeamItem(toItem(run())), email: 'spoof@evil.test', estimatedCostUsd: 9 };
    expect(await (await post(h, 'tok-a', [item, { bogus: true }])).json()).toEqual({ accepted: 1 });
    await post(h, 'tok-b', [{ ...item, runId: 'r2', status: 'completed' }]);
    await post(h, 'tok-a', [{ ...item, status: 'failed' }]); // update, not duplicate

    const team = await (await h.request('http://hub/hub/team', { headers: { authorization: 'Bearer tok-b' } })).json();
    expect(team.me).toBe('b@acme.test');
    const a = team.members.find((m: any) => m.email === 'a@acme.test');
    expect(a.items).toHaveLength(1);
    expect(a.items[0]).toMatchObject({ runId: 'r1', status: 'failed', ticket: 'PROJ-1' });
    expect(a.items[0]).not.toHaveProperty('estimatedCostUsd');
    expect(team.members.map((m: any) => m.email).sort()).toEqual(['a@acme.test', 'b@acme.test']);
  });
});
