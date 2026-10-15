import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { query as sdkQuery, type CanUseTool, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { DecisionAnswer, ModelOption, PendingDecision, PermissionMode, Run, RunKind, ShareLevel, StreamMessage, TimelineEvent } from '../shared/types.ts';
import { toEvents } from './claude-sessions.ts';

export type QueryFn = typeof sdkQuery;

export type StartRequest = {
  owner?: string;
  repo?: string | null;
  kind?: RunKind;
  cwd: string;
  prompt: string;
  permissionMode?: PermissionMode;
  resume?: string;
  model?: string;
  ticket?: string | null;
  share?: ShareLevel;
  // extra MCP servers for this run only (the Settings connections, via the local proxy)
  mcp?: Record<string, { url: string; headers: Record<string, string> }>;
  // looks but never touches: every permission request (edits, shell) is denied without asking
  readOnly?: boolean;
};

// 'default' = whatever the user's Claude Code settings pick
const sdkModel = (m?: string) => (m && m !== 'default' ? m : undefined);

// Async queue feeding the SDK's streaming-input mode; closing it lets the CLI process exit.
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  closed = false;

  push(text: string) {
    this.items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.wake?.();
  }

  close() {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

type Live = {
  run: Run;
  input: InputQueue;
  abort: AbortController;
  interrupt: () => Promise<unknown>;
  setModel: (m?: string) => Promise<void>;
  interrupting: boolean;
  idleTimer: NodeJS.Timeout | null;
};

type Waiting = { decision: PendingDecision; resolve: (r: PermissionResult) => void };

export const ALIVE: Run['status'][] = ['queued', 'starting', 'running', 'awaiting_decision', 'idle'];
const WORKING: Run['status'][] = ['starting', 'running', 'awaiting_decision'];
const MAX_EVENTS = 2000;
const END_GRACE_MS = 10_000;
const READ_ONLY: CanUseTool = async () => ({ behavior: 'deny', message: 'This run is read-only: describe the change instead of making it.' });

export class RunManager extends EventEmitter {
  private live = new Map<string, Live>();
  // started but waiting for a slot; no process yet. FIFO by insertion order.
  private queued = new Map<string, { run: Run; req: StartRequest }>();
  private waiting = new Map<string, Waiting>();
  private modelCache: Promise<ModelOption[]> | null = null;

  constructor(
    private queryFn: QueryFn = sdkQuery,
    private idleTimeoutMs = Number(process.env.LEGOS_IDLE_MS ?? 30 * 60_000),
    // each live run is a claude process (~100–300 MB, more while it builds/tests): cap how many run at once
    private maxLive = Number(process.env.LEGOS_MAX_RUNS ?? 3),
  ) {
    super();
  }

  private emitMsg(m: StreamMessage) {
    this.emit('message', m);
  }

  private publish(run: Run) {
    const { events: _, ...rest } = run;
    this.emitMsg({ type: 'run', run: rest });
  }

  snapshot(): StreamMessage {
    return {
      type: 'snapshot',
      runs: [...this.live.values()].map((l) => l.run).concat([...this.queued.values()].map((x) => x.run)),
      decisions: [...this.waiting.values()].map((w) => w.decision),
    };
  }

  get(id: string): Run | undefined {
    return this.live.get(id)?.run ?? this.queued.get(id)?.run;
  }

  activeRunBySession(): Map<string, string> {
    const m = new Map<string, string>();
    for (const { run } of [...this.live.values(), ...this.queued.values()]) if (run.sessionId && ALIVE.includes(run.status)) m.set(run.sessionId, run.id);
    return m;
  }

  private liveCount(): number {
    let n = 0;
    for (const l of this.live.values()) if (!l.run.endedAt) n++;
    return n;
  }

  // Starts queued runs, oldest first, while there are free slots.
  private drain() {
    for (const [id, { run, req }] of this.queued) {
      if (this.liveCount() >= this.maxLive) return;
      this.queued.delete(id);
      run.status = 'starting';
      this.launch(run, req);
    }
  }

  start(req: StartRequest): Run {
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      owner: req.owner ?? 'local',
      repo: req.repo ?? null,
      kind: req.kind ?? 'chat',
      fromTask: false,
      ticket: req.ticket ?? null,
      share: req.share ?? 'private',
      runtime: 'claude-code',
      sessionId: req.resume ?? null,
      resumedFrom: req.resume ?? null,
      cwd: req.cwd,
      prompt: req.prompt,
      permissionMode: req.permissionMode ?? 'default',
      status: 'queued',
      requestedModel: req.model || 'default',
      model: null,
      startedAt: now,
      lastEventAt: now,
      endedAt: null,
      endedBy: null,
      turns: 0,
      error: null,
      estimatedCostUsd: null,
      result: null,
      events: [],
    };
    if (this.liveCount() >= this.maxLive) {
      this.queued.set(run.id, { run, req });
      this.publish(run);
      return run;
    }
    run.status = 'starting';
    this.launch(run, req);
    return run;
  }

  private launch(run: Run, req: StartRequest) {
    const input = new InputQueue();
    const abort = new AbortController();
    const q = this.queryFn({
      prompt: input,
      options: {
        cwd: req.cwd,
        permissionMode: run.permissionMode,
        resume: req.resume,
        model: sdkModel(req.model),
        ...(req.mcp && { mcpServers: Object.fromEntries(Object.entries(req.mcp).map(([name, m]) => [name, { type: 'http' as const, ...m }])) }),
        abortController: abort,
        canUseTool: req.readOnly ? READ_ONLY : this.canUseTool(run),
      },
    });
    const live: Live = {
      run,
      input,
      abort,
      interrupt: () => q.interrupt(),
      setModel: (m) => q.setModel(m),
      interrupting: false,
      idleTimer: null,
    };
    this.live.set(run.id, live);
    // publish first: clients drop run_events for runs they haven't seen yet
    this.publish(run);
    this.enqueue(live, req.prompt);
    this.publish(run);
    void this.consume(live, q);
  }

  private enqueue(live: Live, text: string) {
    const { run } = live;
    this.clearIdle(live);
    live.input.push(text);
    run.turns++;
    // The SDK doesn't echo streamed prompts, so record them ourselves.
    this.pushEvent(run, { id: `prompt-${run.id}-${run.turns}`, at: new Date().toISOString(), kind: 'user', text });
    if (run.status === 'idle') run.status = 'running';
  }

  send(id: string, text: string): boolean {
    const live = this.live.get(id);
    if (!live || live.run.kind === 'task' || !ALIVE.includes(live.run.status) || live.input.closed) return false;
    this.enqueue(live, text);
    this.publish(live.run);
    return true;
  }

  // Takes effect from the next turn; run.model updates when that turn's init arrives.
  async setModel(id: string, model: string): Promise<boolean> {
    const live = this.live.get(id);
    if (!live || !ALIVE.includes(live.run.status) || live.input.closed) return false;
    await live.setModel(sdkModel(model));
    live.run.requestedModel = model;
    this.publish(live.run);
    return true;
  }

  // Asks the CLI which models this account can use. Opens a session without sending a prompt, so it costs no tokens.
  models(): Promise<ModelOption[]> {
    this.modelCache ??= (async () => {
      const input = new InputQueue();
      const q = this.queryFn({ prompt: input, options: {} });
      try {
        const list = await q.supportedModels();
        return list.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description }));
      } finally {
        input.close();
        for await (const _ of q);
      }
    })().catch((err) => {
      this.modelCache = null;
      throw err;
    });
    return this.modelCache;
  }

  private pushEvent(run: Run, e: TimelineEvent) {
    run.events.push(e);
    if (run.events.length > MAX_EVENTS) run.events.shift();
    run.lastEventAt = e.at;
    this.emitMsg({ type: 'run_event', runId: run.id, event: e });
  }

  private clearIdle(live: Live) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
  }

  private armIdle(live: Live) {
    this.clearIdle(live);
    live.idleTimer = setTimeout(() => this.end(live.run.id, 'idle_timeout'), this.idleTimeoutMs);
    live.idleTimer.unref?.();
  }

  private async consume(live: Live, q: AsyncIterable<any>) {
    const { run } = live;
    try {
      for await (const msg of q) {
        run.lastEventAt = new Date().toISOString();
        if (msg.type === 'system' && msg.subtype === 'init') {
          run.sessionId = msg.session_id;
          run.model = msg.model;
          if (run.status === 'starting') run.status = 'running';
          this.publish(run);
        } else if (msg.type === 'result') {
          // total_cost_usd is cumulative across turns — overwrite, don't add
          run.estimatedCostUsd = msg.total_cost_usd ?? run.estimatedCostUsd;
          const cancelled = live.interrupting;
          const failed = (msg.subtype !== 'success' || msg.is_error) && !cancelled;
          run.error = failed ? (msg.errors?.join('\n') || msg.result || msg.subtype) ?? 'unknown error' : null;
          live.interrupting = false;
          if (run.kind === 'task') {
            // a task is one turn: keep its answer, then let the process exit
            run.result = !failed && !cancelled && typeof msg.result === 'string' ? msg.result : null;
            if (failed) run.status = 'failed';
            live.input.close();
          } else if ((msg.queued_turn_count ?? 0) === 0 && !live.input.closed) {
            // Another queued message keeps the process busy; otherwise it's your turn.
            run.status = 'idle';
            this.armIdle(live);
          }
          this.publish(run);
        } else {
          for (const e of toEvents(msg)) this.pushEvent(run, e);
        }
      }
      if (run.status !== 'failed') run.status = 'completed';
    } catch (err) {
      if (live.input.closed) {
        run.status = 'completed';
      } else {
        run.status = 'failed';
        run.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.clearIdle(live);
      run.endedAt = new Date().toISOString();
      this.withdrawAll(run.id);
      this.publish(run);
      this.drain();
    }
  }

  private canUseTool(run: Run): CanUseTool {
    return (toolName, input, opts) =>
      new Promise<PermissionResult>((resolve) => {
        const decision: PendingDecision = {
          id: randomUUID(),
          runId: run.id,
          cwd: run.cwd,
          toolName,
          title: opts.title ?? null,
          reason: opts.decisionReason ?? null,
          input,
          createdAt: new Date().toISOString(),
        };
        this.waiting.set(decision.id, { decision, resolve });
        run.status = 'awaiting_decision';
        this.publish(run);
        this.emitMsg({ type: 'decision', decision });
        opts.signal.addEventListener('abort', () => this.close(decision.id, 'withdrawn', { behavior: 'deny', message: 'withdrawn' }), {
          once: true,
        });
      });
  }

  decide(id: string, answer: DecisionAnswer): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    if (answer.behavior === 'allow') {
      const updatedInput = answer.answers ? { ...w.decision.input, answers: answer.answers } : w.decision.input;
      this.close(id, 'allowed', { behavior: 'allow', updatedInput });
    } else {
      this.close(id, 'denied', { behavior: 'deny', message: answer.message || 'Denied from legos-factory' });
    }
    return true;
  }

  // Hands a discussed chat back to task mode: it runs to completion and ends on its own.
  resumeTask(id: string, note?: string): boolean {
    const live = this.live.get(id);
    if (!live || !live.run.fromTask || live.run.kind !== 'chat' || live.run.status !== 'idle' || live.input.closed) return false;
    live.run.kind = 'task';
    this.enqueue(live, note?.trim() || 'Discussion is done. Continue the original task to completion, applying what we agreed.');
    this.publish(live.run);
    return true;
  }

  // Answers a pending request with the user's question instead of a yes/no, and keeps the session open as a chat.
  discuss(id: string, question: string): string | null {
    const w = this.waiting.get(id);
    const live = w && this.live.get(w.decision.runId);
    if (!w || !live) return null;
    const { run } = live;
    if (run.kind === 'task') {
      run.kind = 'chat';
      run.fromTask = true;
    }
    this.pushEvent(run, { id: `discuss-${id}`, at: new Date().toISOString(), kind: 'user', text: question });
    this.close(id, 'denied', {
      behavior: 'deny',
      message: `The user wants to discuss this before you proceed. Do not retry this action until they agree. Their question: ${question}`,
    });
    return run.id;
  }

  private close(id: string, outcome: 'allowed' | 'denied' | 'withdrawn', result: PermissionResult) {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    w.resolve(result);
    this.emitMsg({ type: 'decision_closed', id, outcome });
    const run = this.live.get(w.decision.runId)?.run;
    const stillWaiting = [...this.waiting.values()].some((x) => x.decision.runId === w.decision.runId);
    if (run && run.status === 'awaiting_decision' && !stillWaiting) {
      run.status = 'running';
      this.publish(run);
    }
  }

  private withdrawAll(runId: string) {
    for (const [id, w] of this.waiting) {
      if (w.decision.runId === runId) this.close(id, 'withdrawn', { behavior: 'deny', message: 'turn interrupted' });
    }
  }

  // Stops the current turn only; the session stays open for your next message.
  async interrupt(id: string): Promise<boolean> {
    const live = this.live.get(id);
    if (!live || !WORKING.includes(live.run.status)) return false;
    live.interrupting = true;
    this.withdrawAll(id);
    await live.interrupt().catch(() => undefined);
    return true;
  }

  async end(id: string, by: 'user' | 'idle_timeout' = 'user'): Promise<boolean> {
    const q = this.queued.get(id);
    if (q) {
      // never started: drop it from the queue
      this.queued.delete(id);
      Object.assign(q.run, { status: 'completed', endedBy: by, endedAt: new Date().toISOString() });
      this.publish(q.run);
      return true;
    }
    const live = this.live.get(id);
    if (!live || !ALIVE.includes(live.run.status) || live.input.closed) return false;
    live.run.endedBy = by;
    this.clearIdle(live);
    if (WORKING.includes(live.run.status)) await this.interrupt(id);
    live.input.close();
    // The CLI should exit once input closes; force it if it hangs.
    setTimeout(() => ALIVE.includes(live.run.status) && live.abort.abort(), END_GRACE_MS).unref?.();
    return true;
  }
}
