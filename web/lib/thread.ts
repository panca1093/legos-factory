import type { TimelineEvent } from '../../shared/types.ts';

// The events a chat thread renders.
//   - thinking is noise in a chat view; it stays in the raw transcript
//   - subagent events are hidden until asked for
//   - tool calls are hidden in a live run (the transcript keeps them); their results go with them,
//     so a result never survives as a bare "Tool result:" line
export function visibleEvents(events: TimelineEvent[], opts: { showTools: boolean; showSide: boolean }): TimelineEvent[] {
  return events.filter(
    (e) => e.kind !== 'thinking' && (opts.showSide || !e.sidechain) && (opts.showTools || (e.kind !== 'tool_use' && e.kind !== 'tool_result')),
  );
}
