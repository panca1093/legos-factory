import { describe, expect, it } from 'vitest';
import { RunManager, type QueryFn } from '../server/claude-runs.ts';
import type { StreamMessage } from '../shared/types.ts';

type Script = { askTool?: boolean; hang?: boolean };

// Fake SDK in streaming-input mode: one turn per input message, optionally asking for Bash permission first.
function fakeQuery(script: (turn: number, text: string) => Script = () => ({})): { fn: QueryFn; seen: any[]; prompts: string[]; calls: any[] } {
  const seen: any[] = [];
  const prompts: string[] = [];
  const calls: any[] = [];
  const fn = (({ prompt, options }: any) => {
    calls.push({ options });
    let interrupted: (() => void) | null = null;
    async function* gen() {
      let turn = 0;
      for await (const m of prompt as AsyncIterable<any>) {
        turn++;
        prompts.push(m.message.content);
        const s = script(turn, m.message.content);
        yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5-5' };
        if (s.askTool) {
          yield { type: 'assistant', uuid: `a${turn}`, parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } };
          const signal = options.abortController.signal;
          const r = await options.canUseTool('Bash', { command: 'ls' }, { signal, toolUseID: `t${turn}`, requestId: `r${turn}` });
          seen.push(r);
        }
        if (s.hang) {
          await new Promise<void>((res) => (interrupted = res));
          yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['diag'], total_cost_usd: 0.01 * turn };
          continue;
        }
        yield { type: 'assistant', uuid: `b${turn}`, parent_tool_use_id: null, message: { content: [{ type: 'text', text: `reply ${turn}` }] } };
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01 * turn, result: `reply ${turn}` };
      }
    }
    const it = gen() as any;
    it.interrupt = async () => interrupted?.();
    it.setModel = async (m?: string) => calls.push({ setModel: m ?? null });
    it.supportedModels = async () => [{ value: 'default', displayName: 'Default', description: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' }];
    return it;
  }) as unknown as QueryFn;
  return { fn, seen, prompts, calls };
}

function collect(m: RunManager) {
  const msgs: StreamMessage[] = [];
  m.on('message', (x) => msgs.push(x));
  return msgs;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

describe('RunManager interactive sessions', () => {
  it('goes idle after a turn and continues on a follow-up message', async () => {
    const { fn, prompts } = fakeQuery();
    const m = new RunManager(fn);
    const run = m.start({ cwd: '/tmp', prompt: 'first' });

    await until(() => m.get(run.id)!.status === 'idle');
    expect(m.get(run.id)).toMatchObject({ sessionId: 'sess-1', turns: 1, estimatedCostUsd: 0.01 });

    expect(m.send(run.id, 'second')).toBe(true);
    expect(m.get(run.id)!.status).toBe('running');
    await until(() => m.get(run.id)!.status === 'idle');

    expect(prompts).toEqual(['first', 'second']);
    // cumulative cost is overwritten, not summed
    expect(m.get(run.id)!.estimatedCostUsd).toBe(0.02);
    expect(m.get(run.id)!.events.map((e) => `${e.kind}:${e.text}`)).toEqual(['user:first', 'assistant:reply 1', 'user:second', 'assistant:reply 2']);
  });

  it('announces a run before its first event so clients can attach it', () => {
    const { fn } = fakeQuery();
    const m = new RunManager(fn);
    const msgs = collect(m);
    m.start({ cwd: '/tmp', prompt: 'hi' });
    expect(msgs.slice(0, 2).map((x) => x.type)).toEqual(['run', 'run_event']);
  });

  it('surfaces permission requests as decisions and resumes on allow', async () => {
    const { fn, seen } = fakeQuery(() => ({ askTool: true }));
    const m = new RunManager(fn);
    const msgs = collect(m);
    const run = m.start({ cwd: '/tmp', prompt: 'list files' });

    await until(() => m.get(run.id)!.status === 'awaiting_decision');
    const decision = (m.snapshot() as any).decisions[0];
    expect(decision).toMatchObject({ runId: run.id, toolName: 'Bash', input: { command: 'ls' } });

    expect(m.decide(decision.id, { behavior: 'allow', answers: { 'Which?': 'A' } })).toBe(true);
    await until(() => m.get(run.id)!.status === 'idle');
    expect(seen[0]).toEqual({ behavior: 'allow', updatedInput: { command: 'ls', answers: { 'Which?': 'A' } } });
    expect(msgs.some((x) => x.type === 'decision_closed' && x.outcome === 'allowed')).toBe(true);
    expect(m.decide(decision.id, { behavior: 'allow' })).toBe(false);
  });

  it('interrupt stops only the current turn and leaves the session open', async () => {
    const { fn } = fakeQuery((turn) => ({ hang: turn === 1 }));
    const m = new RunManager(fn);
    const run = m.start({ cwd: '/tmp', prompt: 'long task' });
    await until(() => m.get(run.id)!.status === 'running');

    expect(await m.interrupt(run.id)).toBe(true);
    await until(() => m.get(run.id)!.status === 'idle');
    // the SDK's error result for an interrupt is not a failure
    expect(m.get(run.id)!.error).toBeNull();
    expect(await m.interrupt(run.id)).toBe(false);

    expect(m.send(run.id, 'try again')).toBe(true);
    await until(() => m.get(run.id)!.turns === 2 && m.get(run.id)!.status === 'idle');
  });

  it('interrupt withdraws open decisions', async () => {
    const { fn } = fakeQuery(() => ({ askTool: true, hang: true }));
    const m = new RunManager(fn);
    const msgs = collect(m);
    const run = m.start({ cwd: '/tmp', prompt: 'x' });
    await until(() => m.get(run.id)!.status === 'awaiting_decision');
    await m.interrupt(run.id);
    expect((m.snapshot() as any).decisions).toEqual([]);
    expect(msgs.some((x) => x.type === 'decision_closed' && x.outcome === 'withdrawn')).toBe(true);
  });

  it('end closes the session; further messages are rejected', async () => {
    const { fn } = fakeQuery();
    const m = new RunManager(fn);
    const run = m.start({ cwd: '/tmp', prompt: 'hi' });
    await until(() => m.get(run.id)!.status === 'idle');

    expect(await m.end(run.id)).toBe(true);
    await until(() => m.get(run.id)!.endedAt !== null);
    expect(m.get(run.id)).toMatchObject({ status: 'completed', endedBy: 'user' });
    expect(m.send(run.id, 'more')).toBe(false);
    expect(await m.end(run.id)).toBe(false);
    expect(m.activeRunBySession().size).toBe(0);
  });

  it('ends an idle session after the idle timeout', async () => {
    const { fn } = fakeQuery();
    const m = new RunManager(fn, 20);
    const run = m.start({ cwd: '/tmp', prompt: 'hi' });
    await until(() => m.get(run.id)!.status === 'idle');
    await new Promise((r) => setTimeout(r, 60));
    await until(() => m.get(run.id)!.endedAt !== null);
    expect(m.get(run.id)).toMatchObject({ status: 'completed', endedBy: 'idle_timeout' });
  });

  it('passes the chosen model, treating "default" as unset, and switches mid-session', async () => {
    const { fn, calls } = fakeQuery();
    const m = new RunManager(fn);
    const run = m.start({ cwd: '/tmp', prompt: 'hi', model: 'sonnet' });
    m.start({ cwd: '/tmp', prompt: 'hi', model: 'default' });
    expect(calls[0].options.model).toBe('sonnet');
    expect(calls[1].options.model).toBeUndefined();

    await until(() => m.get(run.id)!.status === 'idle');
    expect(m.get(run.id)!.requestedModel).toBe('sonnet');
    expect(await m.setModel(run.id, 'haiku')).toBe(true);
    expect(m.get(run.id)!.requestedModel).toBe('haiku');
    expect(await m.setModel(run.id, 'default')).toBe(true);
    expect(calls.filter((c) => 'setModel' in c)).toEqual([{ setModel: 'haiku' }, { setModel: null }]);
    await m.end(run.id);
    await until(() => m.get(run.id)!.endedAt !== null);
    expect(await m.setModel(run.id, 'opus')).toBe(false);
  });

  it('lists models once and caches them without sending a prompt', async () => {
    const { fn, prompts, calls } = fakeQuery();
    const m = new RunManager(fn);
    const [a, b] = await Promise.all([m.models(), m.models()]);
    expect(a).toEqual([{ value: 'default', displayName: 'Default', description: 'Opus 5.5' }]);
    expect(b).toBe(a);
    expect(calls.length).toBe(1);
    expect(prompts).toEqual([]);
  });

  it('a task runs one turn, keeps its result, and ends on its own', async () => {
    const { fn, prompts } = fakeQuery();
    const m = new RunManager(fn);
    const run = m.start({ kind: 'task', cwd: '/tmp', prompt: 'do the thing' });
    expect(m.send(run.id, 'follow-up')).toBe(false);

    await until(() => m.get(run.id)!.endedAt !== null);
    expect(m.get(run.id)).toMatchObject({ kind: 'task', status: 'completed', result: 'reply 1', error: null, endedBy: null });
    expect(prompts).toEqual(['do the thing']);
  });

  it('a task whose turn errors is failed; a cancelled task is not', async () => {
    const failing = (({ prompt }: any) => {
      const it = (async function* () {
        for await (const _ of prompt as AsyncIterable<any>) {
          yield { type: 'system', subtype: 'init', session_id: 's', model: 'm' };
          yield { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['hit max turns'], total_cost_usd: 0.5 };
        }
      })() as any;
      it.interrupt = async () => {};
      return it;
    }) as unknown as QueryFn;
    const m = new RunManager(failing);
    const t1 = m.start({ kind: 'task', cwd: '/tmp', prompt: 'x' });
    await until(() => m.get(t1.id)!.endedAt !== null);
    expect(m.get(t1.id)).toMatchObject({ status: 'failed', error: 'hit max turns', result: null });

    const { fn } = fakeQuery(() => ({ hang: true }));
    const m2 = new RunManager(fn);
    const t2 = m2.start({ kind: 'task', cwd: '/tmp', prompt: 'long' });
    await until(() => m2.get(t2.id)!.status === 'running');
    expect(await m2.end(t2.id)).toBe(true);
    await until(() => m2.get(t2.id)!.endedAt !== null);
    expect(m2.get(t2.id)).toMatchObject({ status: 'completed', endedBy: 'user', error: null, result: null });
  });

  it('discuss turns a waiting task into a chat and answers the request with the question', async () => {
    const { fn, seen } = fakeQuery((turn) => ({ askTool: turn === 1 }));
    const m = new RunManager(fn);
    const run = m.start({ kind: 'task', cwd: '/tmp', prompt: 'clean up' });
    await until(() => m.get(run.id)!.status === 'awaiting_decision');
    const d = (m.snapshot() as any).decisions[0];

    expect(m.discuss(d.id, 'Why delete that folder?')).toBe(run.id);
    await until(() => seen.length === 1);
    expect(seen[0].behavior).toBe('deny');
    expect(seen[0].message).toContain('Why delete that folder?');

    // the turn finishes as a chat turn: session stays open, follow-ups allowed
    await until(() => m.get(run.id)!.status === 'idle');
    expect(m.get(run.id)).toMatchObject({ kind: 'chat', fromTask: true, endedAt: null });
    expect(m.get(run.id)!.events.some((e) => e.kind === 'user' && e.text === 'Why delete that folder?')).toBe(true);
    expect(m.discuss(d.id, 'again')).toBeNull();

    // after discussing, hand it back: runs one more turn as a task and finishes on its own
    expect(m.resumeTask(run.id, 'ok, go ahead')).toBe(true);
    expect(m.get(run.id)!.kind).toBe('task');
    await until(() => m.get(run.id)!.endedAt !== null);
    expect(m.get(run.id)).toMatchObject({ kind: 'task', fromTask: true, status: 'completed', result: 'reply 2', endedBy: null });
    expect(m.resumeTask(run.id)).toBe(false);
  });

  it('only a discussed task can resume task mode', async () => {
    const { fn } = fakeQuery();
    const m = new RunManager(fn);
    const run = m.start({ cwd: '/tmp', prompt: 'plain chat' });
    await until(() => m.get(run.id)!.status === 'idle');
    expect(m.resumeTask(run.id)).toBe(false);
    await m.end(run.id);
  });

  it('marks a run failed when the SDK throws', async () => {
    const fn = (() => {
      const it = (async function* () {
        throw new Error('spawn claude ENOENT');
      })() as any;
      it.interrupt = async () => {};
      return it;
    }) as unknown as QueryFn;
    const m = new RunManager(fn);
    const run = m.start({ cwd: '/tmp', prompt: 'x' });
    await until(() => m.get(run.id)!.endedAt !== null);
    expect(m.get(run.id)).toMatchObject({ status: 'failed', error: 'spawn claude ENOENT' });
  });
});

describe('RunManager concurrency cap', () => {
  it('queues runs beyond the cap and starts them, oldest first, as slots free up', async () => {
    const { fn, calls, prompts } = fakeQuery();
    const m = new RunManager(fn, 60_000, 2);
    const a = m.start({ cwd: '/tmp', prompt: 'a' });
    const b = m.start({ cwd: '/tmp', prompt: 'b' });
    const c = m.start({ cwd: '/tmp', prompt: 'c', kind: 'task' });
    const d = m.start({ cwd: '/tmp', prompt: 'd' });
    expect([a, b, c, d].map((r) => r.status)).toEqual(['starting', 'starting', 'queued', 'queued']);
    expect(calls).toHaveLength(2); // no process for queued runs
    const snap = m.snapshot() as Extract<StreamMessage, { type: 'snapshot' }>;
    expect(snap.runs.map((r) => r.id).sort()).toEqual([a, b, c, d].map((r) => r.id).sort());
    expect(m.get(c.id)?.status).toBe('queued');

    await until(() => m.get(a.id)!.status === 'idle');
    await m.end(a.id);
    // c (a task) takes the freed slot, finishes, and its slot goes to d
    await until(() => m.get(c.id)!.status === 'completed');
    await until(() => m.get(d.id)!.status === 'idle');
    expect(calls).toHaveLength(4);
    expect(prompts.indexOf('c')).toBeLessThan(prompts.indexOf('d')); // FIFO
    expect(m.get(d.id)!.events.some((e) => e.kind === 'user' && e.text === 'd')).toBe(true);
    expect(m.get(b.id)!.status).toBe('idle'); // b kept its slot throughout
  });

  it('cancelling a queued run removes it without ever starting a process', async () => {
    const { fn, calls } = fakeQuery();
    const m = new RunManager(fn, 60_000, 1);
    const a = m.start({ cwd: '/tmp', prompt: 'a' });
    const b = m.start({ cwd: '/tmp', prompt: 'b' });
    expect(await m.end(b.id)).toBe(true);
    expect(m.get(b.id)).toBeUndefined();
    await until(() => m.get(a.id)!.status === 'idle');
    await m.end(a.id);
    await until(() => m.get(a.id)!.status === 'completed');
    expect(calls).toHaveLength(1);
  });
});
