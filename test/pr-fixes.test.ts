import { describe, expect, it } from 'vitest';
import { RunManager, type QueryFn } from '../server/claude-runs.ts';
import { FixQueues, type GitOps } from '../server/pr-fixes.ts';
import type { FixQueue } from '../shared/types.ts';

// A one-turn session per run: answers its prompt via `answer`, like a task that finishes on its own.
function scripted(answer: (prompt: string) => string | null) {
  const options: any[] = [];
  let n = 0;
  const q = (({ prompt, options: o }: any) => {
    options.push(o);
    const it = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: `s${++n}`, model: 'm' };
      for await (const m of prompt as AsyncIterable<any>) {
        const text = answer(m.message.content);
        yield text === null ? { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] } : { type: 'result', subtype: 'success', result: text };
      }
    })() as any;
    it.interrupt = async () => {};
    return it;
  }) as unknown as QueryFn;
  return { q, options };
}

function setup(answer: (prompt: string, git: { head: string; upstream: string }) => string | null) {
  const state = { head: 'c1', upstream: 'c1' };
  const git: GitOps = { head: async () => state.head, upstream: async () => state.upstream };
  const { q, options } = scripted((p) => answer(p, state));
  const runs = new RunManager(q, 60_000, 3);
  const replies: { commentId: number; text: string }[] = [];
  const cleaned: string[] = [];
  const fixes = new FixQueues(
    runs,
    {
      prepare: async () => '/tmp/pr-12',
      cleanup: async (_q, cwd) => void cleaned.push(cwd),
      reply: async (_q, item, text) => void replies.push({ commentId: item.commentId, text }),
    },
    git,
  );
  const queue = fixes.create({
    workspaceId: 'w1',
    owner: 'u1',
    repo: 'acme/api',
    prId: 12,
    branch: 'feat/PROJ-7',
    ticket: 'PROJ-7',
    comments: [
      { commentId: 1, author: 'Bob', text: 'rename this', path: 'a.go', line: 3 },
      { commentId: 2, author: 'Eve', text: 'add a test?', path: null, line: null },
    ],
  });
  return { fixes, queue, runs, replies, cleaned, state, options };
}

const settle = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const statuses = (q: FixQueue) => q.items.map((i) => i.status).join(',');

describe('fix queue', () => {
  it('proposes, waits for approval, fixes, replies, then moves to the next comment', async () => {
    const { fixes, queue, runs, replies, cleaned, state, options } = setup((p, git) => {
      if (p.includes('read-only')) return `proposal for ${p.includes('rename this') ? 1 : 2}`;
      git.head = git.upstream = 'c2abcdef';
      return 'Renamed it.';
    });
    await settle(() => queue.status === 'waiting');
    expect(statuses(queue)).toBe('proposed,pending'); // one at a time: comment 2 waits its turn
    expect(queue.items[0].proposal).toBe('proposal for 1');
    // the proposal run is read-only: any permission request is refused without asking
    const proposeRun = runs.get(queue.items[0].runId!)!;
    expect(proposeRun).toMatchObject({ kind: 'task', repo: 'acme/api', cwd: '/tmp/pr-12', ticket: 'PROJ-7', permissionMode: 'default' });
    expect(await options[0].canUseTool('Edit', {}, { signal: new AbortController().signal })).toMatchObject({ behavior: 'deny' });

    expect(fixes.approve(queue.id, 2, 'nope')).toBe(false); // not its turn
    expect(fixes.approve(queue.id, 1, 'call it exportRows')).toBe(true);
    await settle(() => queue.items[0].status === 'done' && queue.status === 'waiting');
    const fixRun = runs.get(queue.items[0].runId!)!;
    expect(fixRun.permissionMode).toBe('acceptEdits');
    expect(fixRun.prompt).toContain('proposal for 1');
    expect(fixRun.prompt).toContain('call it exportRows');
    expect(queue.items[0]).toMatchObject({ commit: 'c2abcdef', replied: true, error: null });
    expect(replies).toEqual([{ commentId: 1, text: '> rename this\n\nFixed in `c2abcde`.\n\nRenamed it.' }]);
    expect(statuses(queue)).toBe('done,proposed');

    expect(fixes.skip(queue.id, 2)).toBe(true);
    expect(queue.status).toBe('done');
    await settle(() => cleaned.length === 1);
    expect(state.head).toBe('c2abcdef');
  });

  it('fails a fix that made no commit or did not push, and retries it on request', async () => {
    let pushes = false;
    const { fixes, queue } = setup((p, git) => {
      if (p.includes('read-only')) return 'proposal';
      git.head = 'c2';
      if (pushes) git.upstream = 'c2';
      return 'done';
    });
    await settle(() => queue.status === 'waiting');
    fixes.approve(queue.id, 1);
    await settle(() => queue.items[0].status === 'failed');
    expect(queue.items[0].error).toBe('committed c2 but did not push it');
    expect(queue.status).toBe('waiting');

    pushes = true;
    expect(fixes.retry(queue.id, 1)).toBe(true);
    // the retry reuses the approved proposal and still counts the first try's commit
    await settle(() => queue.items[0].status === 'done');
    expect(queue.items[0].commit).toBe('c2');
  });

  it('marks a failed proposal and lets you skip it; cancelling stops the queue', async () => {
    const { fixes, queue, cleaned } = setup(() => null);
    await settle(() => queue.items[0].status === 'failed');
    expect(queue.items[0].error).toBe('boom');
    expect(fixes.skip(queue.id, 1)).toBe(true);
    await settle(() => queue.items[1].status === 'failed');
    expect(await fixes.cancel(queue.id)).toBe(true);
    expect(queue.status).toBe('cancelled');
    expect(cleaned).toEqual(['/tmp/pr-12']);
    expect(fixes.retry(queue.id, 2)).toBe(false);
  });

  it('allows one open queue per PR', async () => {
    const { fixes, queue } = setup(() => 'proposal');
    expect(() => fixes.create({ workspaceId: 'w1', owner: 'u1', repo: 'acme/api', prId: 12, branch: 'b', comments: [] })).toThrow(/already working/);
    expect(fixes.forPr('w1', 'acme/api', 12)?.id).toBe(queue.id);
    expect(fixes.forPr('w2', 'acme/api', 12)).toBeNull();
  });
});
