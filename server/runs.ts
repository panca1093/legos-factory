import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ActivityItem, DecisionAnswer, ModelOption, PendingDecision, Run, StreamMessage } from '../shared/types.ts';
import { ALIVE, MAX_EVENTS, newRun, type RunManager } from './claude-runs.ts';
import { EMBEDDED, type Dispatcher, type QueuedJob, type RunnerRef } from './dispatcher.ts';
import type { Command, Job, JobRequest, Order, PollRequest, PollResponse, RunnerMessage } from './protocol.ts';

// The control plane's live picture of every run, fed by runner reports; it hands out jobs and relays commands.

export type RunsOptions = {
  selfUrl: string;
  // how runners on other machines reach this app; unset = same as selfUrl
  publicUrl?: string | null;
  // per-run secret -> run, for the connections proxy and git credentials
  grants: Map<string, string>;
  lookup: (runId: string) => ActivityItem | null;
  models?: () => Promise<ModelOption[]>;
  // whether a runner on this machine can take runs in local folders
  embedded: boolean;
};

const WORKING: Run['status'][] = ['starting', 'running', 'awaiting_decision'];
const RESUME_NOTE = 'The server restarted while you were working. Continue where you left off and finish the task; check the git status of your working tree first.';
const gone = (message: string, status = 409) => Object.assign(new Error(message), { status });

export class Runs extends EventEmitter {
  private runs = new Map<string, Run>();
  private decisions = new Map<string, PendingDecision>();
  private commands = new Map<string, Command[]>();
  private waiters = new Set<() => void>();

  constructor(
    private dispatcher: Dispatcher,
    private o: RunsOptions,
  ) {
    super();
  }

  private publish(run: Run) {
    const { events: _, ...rest } = run;
    this.emit('message', { type: 'run', run: rest } satisfies StreamMessage);
  }

  private wake() {
    for (const w of [...this.waiters]) w();
  }

  snapshot(): StreamMessage {
    return { type: 'snapshot', runs: [...this.runs.values()], decisions: [...this.decisions.values()] };
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  activeRunBySession(): Map<string, string> {
    const m = new Map<string, string>();
    for (const run of this.runs.values()) if (run.sessionId && ALIVE.includes(run.status)) m.set(run.sessionId, run.id);
    return m;
  }

  models(): Promise<ModelOption[]> {
    return this.o.models ? this.o.models() : Promise.reject(new Error('this control plane has no embedded runner to ask'));
  }

  openJobs() {
    return this.dispatcher.open();
  }

  start(req: Omit<JobRequest, 'id'>): Run {
    const local = !req.clone || !!req.prepared;
    if (local && !this.o.embedded) throw gone('this control plane has no embedded runner: start the run on a repo so a runner can clone it');
    const request: JobRequest = { ...req, id: randomUUID() };
    const run = newRun(request);
    this.runs.set(run.id, run);
    this.dispatcher.enqueue({ runId: run.id, workspaceId: run.workspaceId, request, priority: req.priority, local });
    this.publish(run);
    this.wake();
    return run;
  }

  private order(runId: string, c: Order) {
    this.commands.set(runId, [...(this.commands.get(runId) ?? []), { runId, ...c } as Command]);
    this.wake();
  }

  send(id: string, text: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.kind === 'task' || run.status === 'queued' || !ALIVE.includes(run.status)) return false;
    this.order(id, { type: 'send', text });
    return true;
  }

  async setModel(id: string, model: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || run.status === 'queued' || !ALIVE.includes(run.status)) return false;
    this.order(id, { type: 'model', model });
    return true;
  }

  async interrupt(id: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || !WORKING.includes(run.status)) return false;
    this.order(id, { type: 'interrupt' });
    return true;
  }

  async end(id: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || run.endedAt) return false;
    if (this.dispatcher.cancel(id)) {
      Object.assign(run, { status: 'completed', endedBy: 'user', endedAt: new Date().toISOString() });
      this.publish(run);
      this.emit('finished', run, null);
      return true;
    }
    if (!ALIVE.includes(run.status)) return false;
    this.order(id, { type: 'end' });
    return true;
  }

  decide(id: string, answer: DecisionAnswer): boolean {
    const d = this.decisions.get(id);
    if (!d) return false;
    this.order(d.runId, { type: 'decide', id, answer });
    return true;
  }

  discuss(id: string, question: string): string | null {
    const d = this.decisions.get(id);
    if (!d) return null;
    this.order(d.runId, { type: 'discuss', id, question });
    return d.runId;
  }

  resumeTask(id: string, note?: string): boolean {
    const run = this.runs.get(id);
    if (!run || !run.fromTask || run.kind !== 'chat' || run.status !== 'idle') return false;
    this.order(id, { type: 'resume_task', note });
    return true;
  }

  // The runner's side: report what happened, ask for work. Both answer fast; poll can also wait for work.
  poll(runner: RunnerRef, req: PollRequest, waitMs = 0): Promise<PollResponse> {
    const first = this.pollNow(runner, req);
    if (waitMs <= 0 || first.jobs.length || first.commands.length || first.lost.length) return Promise.resolve(first);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.pollNow(runner, req));
      };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      this.waiters.add(done);
    });
  }

  private pollNow(runner: RunnerRef, req: PollRequest): PollResponse {
    const lost = this.dispatcher.heartbeat(runner.id, req.running);
    this.reap();
    const jobs = this.dispatcher.claim(runner, req.capacity).map((j) => this.materialize(j, runner));
    const commands: Command[] = [];
    for (const id of req.running) {
      if (lost.includes(id)) continue;
      commands.push(...(this.commands.get(id) ?? []));
      this.commands.delete(id);
    }
    return { jobs, commands, lost };
  }

  // The per-run secret for the connections proxy and git credentials is made here, for this runner, and dies with the run.
  private materialize(job: QueuedJob, runner: RunnerRef): Job {
    const { mcpNames = [], gitHelper, clone, ownsClone, prepared, priority: _b, recoverable: _c, ...req } = job.request;
    this.revoke(job.runId);
    if (gitHelper || mcpNames.length) {
      const secret = randomBytes(24).toString('base64url');
      const base = runner.embedded ? this.o.selfUrl : (this.o.publicUrl ?? this.o.selfUrl);
      if (mcpNames.length) req.mcp = Object.fromEntries(mcpNames.map((name) => [name, { url: `${base}/mcp/${name}`, headers: { 'x-legos-run': secret } }]));
      if (gitHelper) req.env = { LEGOS_RUN_SECRET: secret, LEGOS_URL: base };
      this.o.grants.set(secret, job.runId);
    }
    return { runId: job.runId, attempt: job.attempts, request: req, clone, prepared: !!prepared, ownsClone: !!ownsClone };
  }

  private revoke(runId: string) {
    for (const [secret, id] of this.o.grants) if (id === runId) this.o.grants.delete(secret);
  }

  private closeDecisions(runId: string) {
    for (const [id, d] of this.decisions)
      if (d.runId === runId) {
        this.decisions.delete(id);
        this.emit('message', { type: 'decision_closed', id, outcome: 'withdrawn' } satisfies StreamMessage);
      }
  }

  report(runner: RunnerRef, messages: RunnerMessage[]) {
    const holds = new Map<string, boolean>();
    const mine = (runId: string | undefined) => {
      if (!runId) return false;
      if (!holds.has(runId)) holds.set(runId, this.dispatcher.holds(runner.id, runId));
      return holds.get(runId)!;
    };
    for (const m of messages) {
      const runId = m.type === 'run' ? m.run.id : m.type === 'decision' ? m.decision.runId : m.type === 'decision_closed' ? this.decisions.get(m.id)?.runId : 'runId' in m ? m.runId : undefined;
      if (mine(runId)) this.apply(m);
    }
  }

  private apply(m: RunnerMessage) {
    switch (m.type) {
      case 'run': {
        const run = this.runs.get(m.run.id);
        if (!run) return;
        const { startedAt, workspaceId, owner, prompt } = run;
        const { events: _, ...reported } = m.run as Run;
        Object.assign(run, reported, { startedAt, workspaceId, owner, prompt });
        if (run.endedAt) {
          this.revoke(run.id);
          this.closeDecisions(run.id);
        }
        return this.publish(run);
      }
      case 'run_event': {
        const run = this.runs.get(m.runId);
        if (!run) return;
        run.events.push(m.event);
        if (run.events.length > MAX_EVENTS) run.events.shift();
        run.lastEventAt = m.event.at;
        return void this.emit('message', m);
      }
      case 'decision':
        this.decisions.set(m.decision.id, m.decision);
        return void this.emit('message', m);
      case 'decision_closed':
        this.decisions.delete(m.id);
        return void this.emit('message', m);
      case 'finished': {
        this.dispatcher.finish(m.runId);
        this.commands.delete(m.runId);
        this.revoke(m.runId);
        const run = this.runs.get(m.runId);
        if (run) this.emit('finished', run, m.branch);
        return;
      }
      case 'launch_failed': {
        this.dispatcher.finish(m.runId);
        const run = this.runs.get(m.runId);
        if (run) this.fail(run, m.error);
        return;
      }
    }
  }

  private fail(run: Run, error: string) {
    this.closeDecisions(run.id);
    this.revoke(run.id);
    this.commands.delete(run.id);
    Object.assign(run, { status: 'failed', error, endedAt: new Date().toISOString() });
    this.publish(run);
    this.emit('finished', run, null);
  }

  // Jobs whose runner stopped answering go back to the queue (resuming their Claude session when there is one).
  reap(runnerId?: string) {
    const { requeued, failed } = this.dispatcher.expire(runnerId);
    for (const j of requeued) this.requeue(j);
    for (const j of failed) {
      const run = this.runs.get(j.runId);
      if (run && !run.endedAt) this.fail(run, `no runner finished this run after ${j.attempts} attempts`);
    }
    if (requeued.length) this.wake();
  }

  private requeue(job: QueuedJob) {
    const run = this.runs.get(job.runId);
    if (!run) return this.dispatcher.finish(job.runId);
    this.closeDecisions(run.id);
    this.revoke(run.id);
    this.commands.delete(run.id);
    // nothing is lost by letting go of a chat that was only waiting for you; Sessions can continue it
    if (run.endedAt || run.status === 'idle') {
      this.dispatcher.finish(job.runId);
      if (!run.endedAt) Object.assign(run, { status: 'completed', endedAt: new Date().toISOString() });
      return this.publish(run);
    }
    if (job.request.recoverable === false) {
      this.dispatcher.finish(job.runId);
      return this.fail(run, 'this run does not survive a restart');
    }
    if (run.sessionId) this.dispatcher.amend(job.runId, { ...job.request, resume: run.sessionId, prompt: RESUME_NOTE });
    run.status = 'queued';
    this.publish(run);
  }

  // At startup: rebuild the picture from the queue. Runs the embedded runner held died with the old process.
  recover() {
    for (const job of this.dispatcher.open()) {
      const run = newRun(job.request);
      const item = this.o.lookup(job.runId);
      Object.assign(run, { startedAt: job.queuedAt });
      if (item) Object.assign(run, { status: item.status, sessionId: item.sessionId, model: item.model, turns: item.turns, estimatedCostUsd: item.estimatedCostUsd, lastEventAt: item.lastEventAt });
      else run.status = job.state === 'queued' ? 'queued' : 'running';
      this.runs.set(run.id, run);
    }
    this.reap(EMBEDDED);
    for (const run of this.runs.values()) this.publish(run);
  }
}

type Listen = (event: 'message', listener: (m: StreamMessage) => void) => unknown;

// What the rest of the app needs from whoever holds the runs: the control plane's board, or a RunManager in tests.
export type RunControl = Pick<RunManager, 'get' | 'start' | 'send' | 'setModel' | 'interrupt' | 'end' | 'decide' | 'discuss' | 'resumeTask' | 'snapshot' | 'activeRunBySession' | 'models'> & { on: Listen; off: Listen };
