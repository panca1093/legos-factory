import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getSession, listSessions, toEvents } from '../server/claude-sessions.ts';

const ID = '11111111-1111-1111-1111-111111111111';

beforeAll(() => {
  process.env.CLAUDE_PROJECTS_DIR = join(import.meta.dirname, 'fixtures/projects');
});

describe('session summary', () => {
  it('dedupes usage by message id and adds subagent usage', async () => {
    const s = (await getSession(ID))!;
    // msg_A counted once (last record), msg_B, plus subagent msg_S
    expect(s.usage).toEqual({ input: 10 + 1 + 3, cacheWrite: 100, cacheRead: 3000, output: 20 + 7 + 4 });
    expect(s.subagents).toBe(1);
  });

  it('derives title, cwd, turns, tool stats and skips meta prompts', async () => {
    const s = (await getSession(ID))!;
    expect(s.title).toBe('Demo fix');
    expect(s.cwd).toBe('/tmp/demo');
    expect(s.turns).toBe(1);
    expect(s.toolCalls).toBe(1);
    expect(s.toolErrors).toBe(1);
    expect(s.models).toEqual(['claude-opus-5']);
    expect(s.lastActivityAt).toBe('2026-10-01T10:00:05.000Z');
  });

  it('builds a timeline without empty thinking blocks', async () => {
    const s = (await getSession(ID))!;
    expect(s.events.map((e) => e.kind)).toEqual(['user', 'tool_use', 'tool_result', 'assistant']);
    expect(s.events[1]).toMatchObject({ tool: 'Bash', text: 'npm test' });
  });

  it('lists sessions and rejects non-uuid ids', async () => {
    expect((await listSessions()).map((s) => s.id)).toEqual([ID, '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333']);
    expect(await getSession('../../etc/passwd')).toBeNull();
  });

  it('reports unknown usage as null, not zero', async () => {
    expect((await getSession('22222222-2222-2222-2222-222222222222'))!.usage).toBeNull();
  });

  it('titles SDK-launched sessions from text-block prompts', async () => {
    expect((await getSession('33333333-3333-3333-3333-333333333333'))!).toMatchObject({ title: 'SDK prompt', turns: 1 });
  });

  it('unwraps local command output for display', () => {
    const [e] = toEvents({ type: 'user', message: { content: '<local-command-stdout>Set model to `sonnet`</local-command-stdout>' } });
    expect(e).toMatchObject({ kind: 'system', text: 'Set model to `sonnet`' });
  });

  it('marks SDK subagent messages as sidechain', () => {
    const [e] = toEvents({ type: 'assistant', parent_tool_use_id: 't9', message: { content: [{ type: 'text', text: 'hi' }] } });
    expect(e.sidechain).toBe(true);
  });
});
