import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ActivityItem, Run, TeamItem } from '../shared/types.ts';

export function toItem(run: Omit<Run, 'events'>): ActivityItem {
  return {
    runId: run.id,
    kind: run.kind,
    title: run.prompt.split('\n')[0].slice(0, 120),
    project: run.repo?.split('/')[1] ?? basename(run.cwd),
    repo: run.repo ?? null,
    ticket: run.ticket,
    stage: run.stage ?? null,
    share: run.share,
    status: run.status,
    endedBy: run.endedBy,
    model: run.model,
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    lastEventAt: run.lastEventAt,
    endedAt: run.endedAt,
    turns: run.turns,
    estimatedCostUsd: run.estimatedCostUsd,
  };
}

export function toTeamItem(i: ActivityItem): TeamItem {
  const { share: _s, estimatedCostUsd: _c, stage: _st, ...rest } = i;
  return rest;
}

// Every run launched here, per owner, latest state only. This is also the Sessions list: only
// sessions started from legos-factory show up, never the machine's other Claude sessions.
export class ActivityLog {
  private lastSig = new Map<string, string>();
  // run ids whose session an undo forgot: their late final record must not resurrect the deleted rows
  private forgotten = new Set<string>();

  constructor(private db: DatabaseSync) {
    // runs live in memory: whatever was still going when the server stopped is gone
    db.prepare(
      `update runs set item = json_set(item, '$.status', 'failed') where json_extract(item, '$.status') in ('queued', 'starting', 'running', 'awaiting_decision', 'idle')`,
    ).run();
  }

  // Returns the item when it was written (a real change), else null.
  async record(run: Omit<Run, 'events'>, owner: string): Promise<ActivityItem | null> {
    const item = toItem(run);
    if (this.forgotten.has(item.runId)) return null;
    const sig = [item.status, item.turns, item.endedAt, item.ticket, item.model, item.kind, item.sessionId, run.task, run.persona].join('|');
    if (this.lastSig.get(item.runId) === sig) return null;
    this.lastSig.set(item.runId, sig);
    this.db
      .prepare(
        `insert into runs (run_id, owner, session_id, item, started_at, last_event_at, task, persona) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (run_id) do update set session_id = excluded.session_id, item = excluded.item, last_event_at = excluded.last_event_at, task = excluded.task, persona = excluded.persona`,
      )
      .run(item.runId, owner, item.sessionId, JSON.stringify(item), item.startedAt, item.lastEventAt, run.task ?? null, run.persona ?? null);
    return item;
  }

  async list(owner: string, sinceMs: number): Promise<ActivityItem[]> {
    const since = new Date(sinceMs).toISOString();
    const rows = this.db
      .prepare(`select item from runs where owner = ? and (last_event_at >= ? or started_at >= ?) order by started_at desc`)
      .all(owner, since, since) as { item: string }[];
    return rows.map((r) => JSON.parse(r.item));
  }

  // Claude session ids this owner started here, most recently active first.
  sessionIds(owner: string, limit: number): string[] {
    const rows = this.db
      .prepare(`select session_id from runs where owner = ? and session_id is not null group by session_id order by max(last_event_at) desc limit ?`)
      .all(owner, limit) as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  // a design or build run on this ticket has started
  workedOn(owner: string, ticket: string): boolean {
    return !!this.db
      .prepare(`select 1 from runs where owner = ? and json_extract(item, '$.ticket') = ? and json_extract(item, '$.stage') is not null limit 1`)
      .get(owner, ticket);
  }

  // session -> the ticket its latest ticketed run was started with
  sessionTickets(owner: string): Map<string, string> {
    const rows = this.db
      .prepare(
        `select session_id, json_extract(item, '$.ticket') as ticket from runs
         where owner = ? and session_id is not null and json_extract(item, '$.ticket') is not null order by started_at`,
      )
      .all(owner) as { session_id: string; ticket: string }[];
    return new Map(rows.map((r) => [r.session_id, r.ticket]));
  }

  ownsSession(owner: string, sessionId: string): boolean {
    return !!this.db.prepare(`select 1 from runs where owner = ? and session_id = ? limit 1`).get(owner, sessionId);
  }

  // an undone work item's session goes away as a whole, transcript aside
  forgetSession(owner: string, sessionId: string): boolean {
    const rows = this.db.prepare(`select run_id from runs where owner = ? and session_id = ?`).all(owner, sessionId) as { run_id: string }[];
    for (const r of rows) this.forgotten.add(r.run_id);
    return Number(this.db.prepare(`delete from runs where owner = ? and session_id = ?`).run(owner, sessionId).changes) > 0;
  }
}
