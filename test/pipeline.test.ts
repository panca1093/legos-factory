import { describe, expect, it } from 'vitest';
import { next, type Action, type Facts, type State } from '../server/pipeline.ts';
import type { PipelineStage, PlanTask } from '../shared/types.ts';

const task = (id = 'T1', state: PlanTask['state'] = 'waiting', needs: string[] = []): PlanTask => ({
  id, state, needs, do: 'Build feature', repo: 'acme/api', test: 'feature.test.ts', touches: [id + '.ts'],
});
const state = (stage: PipelineStage, tasks = [task()], attempt = 0): State => ({
  repos: [{ repo: 'acme/api', stage, attempt }], plan: { tasks, error: null },
});
const start = (id: string, persona = 'builder'): Action => ({ type: 'start_run', repo: 'acme/api', task: id, persona: persona as 'builder' | 'inspector' });
const stage = (value: PipelineStage): Action => ({ type: 'set_stage', repo: 'acme/api', stage: value, attempt: 0 });
const ended = (persona: 'builder' | 'inspector', verdict?: 'pass' | 'changes_requested'): Facts => ({
  reviewAttempts: 3, event: { type: 'run_ended', repo: 'acme/api', task: 'T1', persona, ok: true, verdict },
});
const pr = (kind: 'spec' | 'impl', value: 'opened' | 'approved' | 'merged' | 'declined'): Facts => ({
  reviewAttempts: 3, event: { type: 'pr', repo: 'acme/api', kind, state: value },
});

describe('pipeline transitions', () => {
  const rows: { name: string; state: State; facts: Facts; want: Action[] }[] = [
    { name: 'brainstorm and spec review wait for a human', state: state('shaping'), facts: { reviewAttempts: 3 }, want: [] },
    { name: 'opening a spec PR enters the spec review gate', state: state('shaping'), facts: pr('spec', 'opened'), want: [stage('spec_review')] },
    { name: 'a finished foreman does not approve the spec', state: state('shaping'), facts: { reviewAttempts: 3, event: { type: 'run_ended', repo: 'acme/api', task: null, persona: 'foreman', ok: true } }, want: [] },
    { name: 'spec approval starts the first task', state: state('spec_review'), facts: { reviewAttempts: 3, event: { type: 'spec_approved' } }, want: [stage('building'), start('T1')] },
    { name: 'default builds stay sequential for independent tasks', state: state('spec_review', [task(), task('T2')]), facts: { reviewAttempts: 3, event: { type: 'spec_approved' } }, want: [stage('building'), start('T1')] },
    { name: 'fallback plans run tasks sequentially too', state: { ...state('spec_review', [task(), task('T2')]), plan: { tasks: [task(), task('T2')], error: 'no plan block' } }, facts: { reviewAttempts: 3, event: { type: 'spec_approved' } }, want: [stage('building'), start('T1')] },
    { name: 'a successful builder starts the inspector', state: state('building', [task('T1', 'running')]), facts: ended('builder'), want: [start('T1', 'inspector')] },
    { name: 'a passing inspector completes the task and starts its dependent', state: state('building', [task('T1', 'running'), task('T2', 'waiting', ['T1'])]), facts: ended('inspector', 'pass'), want: [{ type: 'set_task', task: 'T1', state: 'done' }, stage('building'), start('T2')] },
    { name: 'a completed repo waits for its implementation PR', state: state('building', [task('T1', 'running')]), facts: ended('inspector', 'pass'), want: [{ type: 'set_task', task: 'T1', state: 'done' }, stage('building')] },
    { name: 'an unrouted implementation PR becomes ready', state: state('building', [task('T1', 'done')]), facts: pr('impl', 'opened'), want: [{ type: 'mark_ready', repo: 'acme/api' }] },
    { name: 'a matched rule routes the PR to a person', state: state('building', [task('T1', 'done')]), facts: { ...pr('impl', 'opened'), ruleMatched: true }, want: [stage('pr_review')] },
    { name: 'an inspector can also route the PR to a person', state: state('building', [task('T1', 'done')]), facts: { ...pr('impl', 'opened'), inspectorReasons: ['Check compatibility'] }, want: [stage('pr_review')] },
    { name: 'an unfinished task cannot reach ready', state: state('building'), facts: pr('impl', 'opened'), want: [] },
    { name: 'a human PR approval marks ready', state: state('pr_review', [task('T1', 'done')]), facts: pr('impl', 'approved'), want: [{ type: 'mark_ready', repo: 'acme/api' }] },
    { name: 'ready waits for the human merge', state: state('ready', [task('T1', 'done')]), facts: { reviewAttempts: 3 }, want: [] },
    { name: 'a merged implementation PR marks done', state: state('ready', [task('T1', 'done')]), facts: pr('impl', 'merged'), want: [stage('done')] },
    { name: 'a declined spec escalates without a stage change or retry', state: state('spec_review'), facts: pr('spec', 'declined'), want: [{ type: 'escalate', repo: 'acme/api', reason: 'spec PR declined' }] },
    { name: 'a declined implementation escalates without a stage change or retry', state: state('pr_review'), facts: pr('impl', 'declined'), want: [{ type: 'escalate', repo: 'acme/api', reason: 'impl PR declined' }] },
  ];
  it.each(rows)('$name', ({ state, facts, want }) => {
    const before = structuredClone({ state, facts });
    expect(next(state, facts)).toEqual(want);
    expect({ state, facts }).toEqual(before);
  });

  it('escalates after reviewAttempts failed reviews', () => {
    expect(next(state('building', [task('T1', 'running')], 2), ended('inspector', 'changes_requested'))).toEqual([
      { type: 'set_stage', repo: 'acme/api', stage: 'building', attempt: 3 },
      { type: 'set_task', task: 'T1', state: 'failed' },
      { type: 'escalate', repo: 'acme/api', task: 'T1', reason: 'review attempts exhausted' },
    ]);
  });

  it('a review finding re-runs the same task', () => {
    expect(next(state('building', [task('T1', 'running'), task('T2')]), ended('inspector', 'changes_requested'))).toEqual([
      { type: 'set_stage', repo: 'acme/api', stage: 'building', attempt: 1 }, start('T1'),
    ]);
  });

  it('does not start another task while a task is running or paused', () => {
    for (const status of ['running', 'paused'] as const) {
      expect(next(state('building', [task('T1', status), task('T2')]), { reviewAttempts: 3 })).toEqual([]);
    }
  });

  it('ignores events for an unknown repo or task', () => {
    expect(next(state('building'), { ...ended('builder'), event: { type: 'run_ended', repo: 'acme/web', task: 'T1', persona: 'builder', ok: true } })).toEqual([]);
    expect(next(state('building'), { ...ended('builder'), event: { type: 'run_ended', repo: 'acme/api', task: 'missing', persona: 'builder', ok: true } })).toEqual([]);
  });
});
