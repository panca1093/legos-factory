import type { DatabaseSync } from 'node:sqlite';
import type { JobRequest } from './protocol.ts';

// The durable run queue: jobs are leased to runners, and a lapsed lease requeues the job or, after too many claims, fails it.

export const EMBEDDED = 'embedded';

export type QueuedJob = { runId: string; workspaceId: string; request: JobRequest; attempts: number };
export type RunnerRef = { id: string; workspaceId: string | null; embedded: boolean };

type Row = { run_id: string; workspace_id: string; request: string; attempts: number };
const toJob = (r: Row): QueuedJob => ({ runId: r.run_id, workspaceId: r.workspace_id, request: JSON.parse(r.request), attempts: r.attempts });

export class Dispatcher {
  constructor(
    private db: DatabaseSync,
    private opts: { leaseMs: number; maxAttempts: number; now?: () => number } = { leaseMs: 60_000, maxAttempts: 3 },
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  enqueue(job: { runId: string; workspaceId: string; request: JobRequest; priority?: number; local: boolean }) {
    this.db
      .prepare(`insert into jobs (run_id, workspace_id, priority, state, request, local, queued_at) values (?, ?, ?, 'queued', ?, ?, ?)`)
      .run(job.runId, job.workspaceId, job.priority ?? 0, JSON.stringify(job.request), Number(job.local), new Date(this.now()).toISOString());
  }

  // Highest priority first, then first come first served. A runner never holds more than `capacity` jobs.
  claim(runner: RunnerRef, capacity: number): QueuedJob[] {
    const held = (this.db.prepare(`select count(*) as n from jobs where state = 'leased' and runner_id = ?`).get(runner.id) as { n: number }).n;
    const free = capacity - held;
    if (free <= 0) return [];
    const rows = this.db
      .prepare(
        `select run_id, workspace_id, request, attempts from jobs
         where state = 'queued' and (? = 1 or local = 0) and (? is null or workspace_id = ?)
         order by priority desc, queued_at, rowid limit ?`,
      )
      .all(Number(runner.embedded), runner.workspaceId, runner.workspaceId, free) as Row[];
    const lease = this.db.prepare(`update jobs set state = 'leased', runner_id = ?, lease_until = ?, attempts = attempts + 1 where run_id = ?`);
    for (const r of rows) lease.run(runner.id, this.now() + this.opts.leaseMs, r.run_id);
    return rows.map((r) => toJob({ ...r, attempts: r.attempts + 1 }));
  }

  // Extends the leases the runner still holds; returns the ones it no longer has.
  heartbeat(runnerId: string, runIds: string[]): string[] {
    const extend = this.db.prepare(`update jobs set lease_until = ? where run_id = ? and state = 'leased' and runner_id = ?`);
    return runIds.filter((id) => Number(extend.run(this.now() + this.opts.leaseMs, id, runnerId).changes) === 0);
  }

  holds(runnerId: string, runId: string): boolean {
    return !!this.db.prepare(`select 1 from jobs where run_id = ? and state = 'leased' and runner_id = ?`).get(runId, runnerId);
  }

  finish(runId: string) {
    this.db.prepare(`update jobs set state = 'done', runner_id = null, lease_until = null where run_id = ?`).run(runId);
  }

  // A queued job that never started; false once a runner has it.
  cancel(runId: string): boolean {
    return Number(this.db.prepare(`update jobs set state = 'done' where run_id = ? and state = 'queued'`).run(runId).changes) > 0;
  }

  amend(runId: string, request: JobRequest) {
    this.db.prepare(`update jobs set request = ? where run_id = ?`).run(JSON.stringify(request), runId);
  }

  open(): (QueuedJob & { state: 'queued' | 'leased'; runnerId: string | null; queuedAt: string })[] {
    const rows = this.db.prepare(`select run_id, workspace_id, request, attempts, state, runner_id, queued_at from jobs where state != 'done' order by queued_at, rowid`).all() as (Row & {
      state: 'queued' | 'leased';
      runner_id: string | null;
      queued_at: string;
    })[];
    return rows.map((r) => ({ ...toJob(r), state: r.state, runnerId: r.runner_id, queuedAt: r.queued_at }));
  }

  // Lapsed leases (or every lease of runnerId) go back to the queue; a job claimed maxAttempts times fails instead.
  expire(runnerId?: string): { requeued: QueuedJob[]; failed: QueuedJob[] } {
    const rows = this.db
      .prepare(`select run_id, workspace_id, request, attempts from jobs where state = 'leased' and (lease_until < ? or runner_id = ?) order by queued_at, rowid`)
      .all(this.now(), runnerId ?? null) as Row[];
    const requeued: QueuedJob[] = [];
    const failed: QueuedJob[] = [];
    const requeue = this.db.prepare(`update jobs set state = 'queued', runner_id = null, lease_until = null where run_id = ?`);
    for (const r of rows) {
      if (r.attempts >= this.opts.maxAttempts) {
        this.finish(r.run_id);
        failed.push(toJob(r));
      } else {
        requeue.run(r.run_id);
        requeued.push(toJob(r));
      }
    }
    return { requeued, failed };
  }
}
