import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../shared/types.ts';
import { visibleEvents } from '../web/lib/thread.ts';

const ev = (kind: TimelineEvent['kind'], id: string, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id,
  at: '2026-10-20T00:00:00.000Z',
  kind,
  text: id,
  ...extra,
});

const EVENTS: TimelineEvent[] = [
  ev('user', 'u1'),
  ev('assistant', 'a1'),
  ev('thinking', 't1'),
  ev('tool_use', 'tool1', { tool: 'Bash' }),
  ev('tool_result', 'res1'),
  ev('assistant', 'a2', { sidechain: true }),
  ev('tool_use', 'tool2', { tool: 'Read', sidechain: true }),
];

const show = (opts: { showTools: boolean; showSide: boolean }) => visibleEvents(EVENTS, opts).map((e) => e.id);

describe('visibleEvents', () => {
  it('hides tool calls and their results in a live run', () => {
    expect(show({ showTools: false, showSide: false })).toEqual(['u1', 'a1']);
  });

  it('keeps tool calls in the transcript', () => {
    expect(show({ showTools: true, showSide: false })).toEqual(['u1', 'a1', 'tool1', 'res1']);
  });

  it('drops a result whose call is gone, so no bare "Tool result:" line survives', () => {
    // a result with no call in front of it (a transcript that starts mid-turn)
    const only = [ev('tool_result', 'res1')];
    expect(visibleEvents(only, { showTools: false, showSide: false })).toEqual([]);
  });

  it('always drops thinking', () => {
    expect(show({ showTools: true, showSide: true })).not.toContain('t1');
  });

  it('hides subagent events until asked for', () => {
    expect(show({ showTools: true, showSide: false })).not.toContain('a2');
    expect(show({ showTools: true, showSide: true })).toContain('a2');
  });
});
