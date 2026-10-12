import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ActivityItem, Run, TeamItem } from '../shared/types.ts';

export function activityPath(): string {
  return process.env.LEGOS_ACTIVITY ?? join(homedir(), '.legos-factory', 'activity.jsonl');
}

export function toItem(run: Omit<Run, 'events'>): ActivityItem {
  return {
    runId: run.id,
    kind: run.kind,
    title: run.prompt.split('\n')[0].slice(0, 120),
    project: basename(run.cwd),
    ticket: run.ticket,
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
  const { share: _s, estimatedCostUsd: _c, ...rest } = i;
  return rest;
}

// Append-only run history so activity survives restarts; one line per meaningful state change.
// TODO: uncertain — file grows unbounded; compact (keep last line per runId) once it gets large.
export class ActivityLog {
  private lastSig = new Map<string, string>();

  constructor(private path = activityPath()) {}

  // Returns the item when it was written (a real change), else null.
  async record(run: Omit<Run, 'events'>): Promise<ActivityItem | null> {
    const item = toItem(run);
    const sig = [item.status, item.turns, item.endedAt, item.ticket, item.model, item.kind, item.sessionId].join('|');
    if (this.lastSig.get(item.runId) === sig) return null;
    this.lastSig.set(item.runId, sig);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(item) + '\n', { mode: 0o600 });
    return item;
  }

  async list(sinceMs: number): Promise<ActivityItem[]> {
    let raw = '';
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return [];
    }
    const latest = new Map<string, ActivityItem>();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const i = JSON.parse(line) as ActivityItem;
        latest.set(i.runId, i);
      } catch {
        // torn last line from a crash; skip it
      }
    }
    return [...latest.values()]
      .filter((i) => Date.parse(i.lastEventAt) >= sinceMs || Date.parse(i.startedAt) >= sinceMs)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
