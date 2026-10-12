import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { TeamItem, TeamMember } from '../shared/types.ts';
import type { Workbench } from './workbench.ts';

// Team hub: laptops push run status (never transcripts or cost); every signed-in member can read all.
// Identity = the workbench user behind the bearer token, so nobody can post as someone else.

const KINDS = new Set(['chat', 'task']);
const STATUSES = new Set(['starting', 'running', 'awaiting_decision', 'idle', 'completed', 'failed']);
const IDENTITY_TTL_MS = 5 * 60_000;
const MAX_ITEMS_PER_POST = 50;

export function hubDbPath(): string {
  return process.env.LEGOS_HUB_DB ?? join(homedir(), '.legos-factory', 'hub.sqlite');
}

const s = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);

function clean(raw: any): TeamItem | null {
  if (!raw || typeof raw.runId !== 'string' || !KINDS.has(raw.kind) || !STATUSES.has(raw.status) || typeof raw.startedAt !== 'string') return null;
  return {
    runId: raw.runId.slice(0, 64),
    kind: raw.kind,
    title: s(raw.title, 120) ?? '',
    project: s(raw.project, 120) ?? '',
    ticket: s(raw.ticket, 32),
    status: raw.status,
    endedBy: raw.endedBy === 'user' || raw.endedBy === 'idle_timeout' ? raw.endedBy : null,
    model: s(raw.model, 64),
    sessionId: s(raw.sessionId, 64),
    startedAt: raw.startedAt,
    lastEventAt: s(raw.lastEventAt, 40) ?? raw.startedAt,
    endedAt: s(raw.endedAt, 40),
    turns: Number.isFinite(raw.turns) ? Math.max(0, Math.floor(raw.turns)) : 0,
  };
}

export function createHub(opts: { workbench: Workbench; dbPath?: string }) {
  const path = opts.dbPath ?? hubDbPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`create table if not exists items (
    email text not null, run_id text not null, item text not null, last_event_at text not null, updated_at text not null,
    primary key (email, run_id))`);
  const upsert = db.prepare(
    `insert into items (email, run_id, item, last_event_at, updated_at) values (?, ?, ?, ?, ?)
     on conflict (email, run_id) do update set item = excluded.item, last_event_at = excluded.last_event_at, updated_at = excluded.updated_at`,
  );
  const recent = db.prepare(`select email, item, updated_at from items where last_event_at >= ? order by last_event_at desc`);

  const identities = new Map<string, { email: string; at: number }>();
  async function whoIs(authorization: string | undefined): Promise<string | null> {
    const token = authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return null;
    const hit = identities.get(token);
    if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.email;
    const me = await opts.workbench.whoami(token).catch(() => null);
    if (!me?.email) return null;
    identities.set(token, { email: me.email, at: Date.now() });
    return me.email;
  }

  const app = new Hono<{ Variables: { email: string } }>();

  app.use('/hub/*', async (c, next) => {
    const email = await whoIs(c.req.header('authorization'));
    if (!email) return c.json({ error: 'unknown or expired workbench token' }, 401);
    c.set('email', email);
    await next();
  });

  app.post('/hub/events', async (c) => {
    const body = await c.req.json().catch(() => null);
    const items = Array.isArray(body?.items) ? body.items.slice(0, MAX_ITEMS_PER_POST).map(clean).filter(Boolean) : [];
    const now = new Date().toISOString();
    for (const i of items as TeamItem[]) upsert.run(c.get('email'), i.runId, JSON.stringify(i), i.lastEventAt, now);
    return c.json({ accepted: items.length });
  });

  app.get('/hub/team', (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 7) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const members = new Map<string, TeamMember>();
    for (const row of recent.all(since) as { email: string; item: string; updated_at: string }[]) {
      const m = members.get(row.email) ?? { email: row.email, lastSeen: row.updated_at, items: [] };
      if (row.updated_at > m.lastSeen) m.lastSeen = row.updated_at;
      m.items.push(JSON.parse(row.item));
      members.set(row.email, m);
    }
    return c.json({ me: c.get('email'), members: [...members.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)) });
  });

  return app;
}
