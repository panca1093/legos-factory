import { describe, expect, it, vi } from 'vitest';
import type { PipelineStage, PlanTask, WorkItem } from '../shared/types.ts';

// components.tsx sanitizes markdown at module load, which needs a window; nothing under test does.
vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));
import { redirectTarget } from '../web/App.tsx';
import { flowColumns } from '../web/pages/WorkItem.tsx';
import { stageOf } from '../web/pages/Work.tsx';

const task = (id: string, needs: string[] = []): PlanTask => ({ id, do: `Do ${id}`, repo: 'acme/api', test: `${id}.test.ts`, needs, touches: [], state: 'waiting' });

const item = (stages: PipelineStage[]): WorkItem => ({
  ticket: 'PROJ-142',
  source: 'local',
  plan: null,
  repos: stages.map((stage, index) => ({ name: `acme/repo-${index}`, addedAt: '', stage, attempt: 0 })),
  links: [],
  note: null,
  status: null,
});

describe('flowColumns', () => {
  it('puts a single task in one column', () => {
    expect(flowColumns([task('T1')])).toEqual([[task('T1')]]);
  });

  it('orders a chain one column per dependency depth', () => {
    const t1 = task('T1');
    const t2 = task('T2', ['T1']);
    expect(flowColumns([t2, t1])).toEqual([[t1], [t2]]);
  });

  it('puts two independent tasks in the same column', () => {
    const t1 = task('T1');
    const t2 = task('T2');
    expect(flowColumns([t1, t2])).toEqual([[t1, t2]]);
  });

  it('falls back to one column when the tasks cycle', () => {
    const t1 = task('T1', ['T2']);
    const t2 = task('T2', ['T1']);
    expect(flowColumns([t1, t2])).toEqual([[t1, t2]]);
  });
});

describe('stageOf', () => {
  it('keeps a work item with no repos in shaping', () => {
    expect(stageOf(item([]))).toBe('shaping');
  });

  it('sits a work item in the stage of its slowest repo', () => {
    expect(stageOf(item(['building', 'backlog']))).toBe('backlog');
  });
});

describe('redirectTarget', () => {
  it('redirects the legacy task and session routes', () => {
    expect(redirectTarget('#/tasks')).toBe('#/work');
    expect(redirectTarget('#/sessions')).toBe('#/activity');
  });

  it('keeps deep links and leaves other hashes alone', () => {
    expect(redirectTarget('#/sessions/acme-1')).toBeNull();
    expect(redirectTarget('#/runs/acme-1')).toBeNull();
    expect(redirectTarget('#/reviews')).toBeNull();
  });
});
