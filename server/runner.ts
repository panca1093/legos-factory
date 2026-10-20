import type { StreamMessage } from '../shared/types.ts';
import type { RunManager } from './claude-runs.ts';
import type { RunnerRef } from './dispatcher.ts';
import { gitBranch } from './policy.ts';
import type { Command, Job, RunnerMessage, Transport } from './protocol.ts';
import type { Runs } from './runs.ts';
import { createWorkspace, exists, parseRepo, removeWorkspace, workspacePath } from './workspace.ts';

// Executes the agent on this machine; only ever calls the control plane, with Claude credentials of its own and git ones per job.

export type RunnerOptions = {
  transport: Transport;
  manager: RunManager;
  wsRoot: string;
  gitUrl?: string;
  // a git token for a repo run this runner clones itself
  credential: (job: Job) => Promise<string>;
  retryMs?: number;
  onFatal?: (err: Error) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Runner {
  private unconfirmed = new Set<string>();
  private owned = new Map<string, boolean>();
  private outbox: RunnerMessage[] = [];
  private flushing = false;
  private stopped = false;

  constructor(private o: RunnerOptions) {
    o.manager.on('message', (m: StreamMessage) => {
      this.say(m);
      if (m.type === 'run' && m.run.endedAt && this.owned.has(m.run.id)) void this.finish(m.run);
    });
  }

  start() {
    void this.loop();
  }

  stop() {
    this.stopped = true;
  }

  private async loop() {
    let failures = 0;
    while (!this.stopped) {
      try {
        const res = await this.o.transport.poll({ capacity: this.o.manager.capacity, running: [...this.unconfirmed] });
        failures = 0;
        for (const id of res.lost) this.drop(id);
        for (const c of res.commands) this.apply(c);
        for (const job of res.jobs) void this.launch(job);
      } catch (err) {
        if ((err as { fatal?: boolean }).fatal) return void this.o.onFatal?.(err as Error);
        console.warn('runner: control plane unreachable:', (err as Error).message);
        await sleep(Math.min(this.o.retryMs ?? 1000 * 2 ** ++failures, 30_000));
      }
    }
  }

  private apply(c: Command) {
    const m = this.o.manager;
    switch (c.type) {
      case 'send':
        return void m.send(c.runId, c.text);
      case 'model':
        return void m.setModel(c.runId, c.model);
      case 'interrupt':
        return void m.interrupt(c.runId);
      case 'end':
        return void m.end(c.runId);
      case 'decide':
        return void m.decide(c.id, c.answer);
      case 'discuss':
        return void m.discuss(c.id, c.question);
      case 'resume_task':
        return void m.resumeTask(c.runId, c.note);
    }
  }

  // The control plane gave this job to someone else: stop working on it.
  private drop(runId: string) {
    this.unconfirmed.delete(runId);
    this.owned.delete(runId);
    void this.o.manager.end(runId);
  }

  private busy(path: string): boolean {
    const snap = this.o.manager.snapshot();
    return snap.type === 'snapshot' && snap.runs.some((r) => r.cwd === path && !r.endedAt);
  }

  private launch(job: Job) {
    this.unconfirmed.add(job.runId);
    this.owned.set(job.runId, job.ownsClone);
    const failed = (err: unknown) => {
      this.owned.delete(job.runId);
      this.say({ type: 'launch_failed', runId: job.runId, error: err instanceof Error ? err.message : String(err) });
    };
    const begin = (cwd: string) => {
      try {
        this.o.manager.start({ ...job.request, id: job.runId, cwd });
      } catch (err) {
        failed(err);
      }
    };
    // the clone is awaited only when there is one to make, so a plain run starts in the poll's own turn
    try {
      const cwd = job.clone ? this.checkout(job) : job.request.cwd;
      if (typeof cwd === 'string') begin(cwd);
      else cwd.then(begin, failed);
    } catch (err) {
      failed(err);
    }
  }

  // A run that comes back after a lost lease works in the tree it left; a first run starts from a fresh clone.
  private checkout(job: Job): string | Promise<string> {
    const spec = job.clone!;
    const repo = parseRepo(spec.repo)!;
    const path = workspacePath(this.o.wsRoot, job.request.workspaceId ?? 'local', repo, spec.key);
    if (this.busy(path)) throw new Error(`a run is already working in ${spec.key}`);
    const create = () => createWorkspace({ path, repo, branch: spec.branch, urlTemplate: this.o.gitUrl, credential: () => this.o.credential(job), author: spec.author });
    if (job.prepared && job.attempt === 1) return path;
    if (job.attempt === 1) return create();
    return exists(path).then((there) => (there ? path : create()));
  }

  // The branch is read before the clone goes, so the control plane can find the PR it left behind.
  private async finish(run: { id: string; cwd: string }) {
    const owns = this.owned.get(run.id);
    this.owned.delete(run.id);
    let branch: string | null = null;
    if (owns) {
      branch = await gitBranch(run.cwd);
      if (!this.busy(run.cwd)) await removeWorkspace(this.o.wsRoot, run.cwd).catch((err) => console.warn('workspace cleanup failed:', err.message));
    }
    this.say({ type: 'finished', runId: run.id, branch });
  }

  private say(m: RunnerMessage) {
    this.outbox.push(m);
    void this.flush();
  }

  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbox.length && !this.stopped) {
        const batch = this.outbox.splice(0, 200);
        try {
          await this.o.transport.report(batch);
          for (const m of batch) if (m.type === 'finished' || m.type === 'launch_failed') this.unconfirmed.delete(m.runId);
        } catch (err) {
          this.outbox.unshift(...batch);
          await sleep(this.o.retryMs ?? 1000);
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

export const localTransport = (runs: Runs, runner: RunnerRef, waitMs = 25_000): Transport => ({
  poll: (req) => runs.poll(runner, req, waitMs),
  report: async (messages) => runs.report(runner, messages),
});

export function httpTransport(baseUrl: string, token: string, http: typeof fetch = fetch): Transport {
  const call = async <T>(path: string, body: object, timeoutMs: number): Promise<T> => {
    const res = await http(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`the control plane refused this runner token (HTTP ${res.status})`), { fatal: true });
    if (!res.ok) throw new Error(`the control plane answered HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    poll: (req) => call('/runner/poll', req, 60_000),
    report: async (messages) => void (await call('/runner/report', { messages }, 30_000)),
  };
}
