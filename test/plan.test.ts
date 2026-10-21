import { describe, expect, it } from 'vitest';
import type { Plan, PlanTask } from '../shared/types.ts';
import { canRunTogether, parsePlan, waves } from '../server/plan.ts';

const repos = ['acme/api', 'acme/web'];
const task = (id: string, needs: string[] = [], touches = [`${id}.ts`]): PlanTask => ({
  id, do: `Build ${id}`, repo: repos[0], test: `${id}.test.ts`, needs, touches, state: 'waiting',
});
const block = (body: string) => `Spec description\n\n\`\`\`plan\n${body}\n\`\`\`\n`;
const entry = (id: string, repo = repos[0], needs = '[]') => `- id: ${id}\n  do: Build ${id}\n  repo: ${repo}\n  test: ${id}.test.ts\n  needs: ${needs}\n  touches: [${id}.ts]`;

function expectFallback(description: string, reason: RegExp) {
  const plan = parsePlan(description, repos);
  expect(plan.error).toMatch(reason);
  expect(plan.tasks.map((item) => item.repo)).toEqual(repos);
  expect(plan.tasks.every((item) => item.state === 'waiting')).toBe(true);
  expect(waves(plan)).toEqual(plan.tasks.map((item) => [item.id]));
}

describe('plan parser', () => {
  it('parses the fenced plan block with waiting task states', () => {
    expect(parsePlan(block(`${entry('T1')}\n${entry('T2', repos[1], '[T1]')}`), repos)).toEqual({
      tasks: [task('T1'), { ...task('T2', ['T1']), repo: repos[1] }], error: null,
    });
  });

  it('falls back when no plan block exists', () => expectFallback('Only prose', /no plan block/i));
  it('falls back on bad YAML', () => expectFallback(block('- id T1\n  repo acme/api'), /bad YAML/i));
  it('falls back on an unknown repo', () => expectFallback(block(entry('T1', 'acme/other')), /unknown repo/i));
  it('falls back on an unknown id in needs', () => expectFallback(block(entry('T1', repos[0], '[missing]')), /unknown.*needs/i));
  it('falls back on a cycle', () => expectFallback(block(`${entry('T1', repos[0], '[T2]')}\n${entry('T2', repos[1], '[T1]')}`), /cycle/i));
  it('falls back on duplicate task ids', () => expectFallback(block(`${entry('T1')}\n${entry('T1')}`), /duplicate.*id/i));

  it('a plan with an invalid task id is rejected', () => {
    expectFallback(block(entry('T 1')), /invalid.*id/i);
    expectFallback(block(entry('T/1')), /invalid.*id/i);
    expectFallback(block(entry('T.1')), /invalid.*id/i);
  });

  it('a plan with the same task id twice is rejected', () => {
    expectFallback(block(`${entry('T1')}\n${entry('t1')}`), /duplicate.*id/i);
  });

  it.each([
    entry('T1').replace('  test: T1.test.ts\n', ''),
    entry('T1').replace('needs: []', 'needs: T2'),
    entry('T1').replace('touches: [T1.ts]', 'touches: [T1.ts'),
    entry('T1').replace('  do: Build T1', '   do: Build T1'),
    '',
  ])('falls back for malformed or incomplete tasks: %s', (body) => expectFallback(block(body), /bad YAML/i));

  it('reads quoted scalars and inline lists', () => {
    const description = block(entry('T1').replace('Build T1', '"Build: retry"').replace('[T1.ts]', "['src/retry.ts', \"src/retry,cap.ts\"]"));
    expect(parsePlan(description, repos)).toEqual({ tasks: [{ ...task('T1'), do: 'Build: retry', touches: ['src/retry.ts', 'src/retry,cap.ts'] }], error: null });
  });
});

describe('plan scheduling', () => {
  it('groups independent tasks into one wave', () => {
    const plan: Plan = { tasks: [task('T1'), task('T2'), task('T3', ['T1']), task('T4', ['T3'])], error: null };
    expect(waves(plan)).toEqual([['T1', 'T2'], ['T3'], ['T4']]);
    expect(canRunTogether(plan.tasks[0], plan.tasks[1], plan)).toBe(true);
  });

  it('keeps tasks with overlapping touches apart', () => {
    const plan: Plan = { tasks: [task('T1', [], ['shared.ts']), task('T2', [], ['shared.ts']), task('T3', ['T2'])], error: null };
    expect(waves(plan)).toEqual([['T1'], ['T2'], ['T3']]);
    expect(canRunTogether(plan.tasks[0], plan.tasks[1], plan)).toBe(false);
  });

  it('rejects transitive dependencies in both directions', () => {
    const plan: Plan = { tasks: [task('T1'), task('T2', ['T1']), task('T3', ['T2'])], error: null };
    expect(canRunTogether(plan.tasks[0], plan.tasks[2], plan)).toBe(false);
    expect(canRunTogether(plan.tasks[2], plan.tasks[0], plan)).toBe(false);
    expect(canRunTogether(plan.tasks[0], plan.tasks[0], plan)).toBe(false);
  });

  it('orders prerequisites before dependents even when listed later', () => {
    expect(waves({ tasks: [task('T2', ['T1']), task('T1')], error: null })).toEqual([['T1'], ['T2']]);
  });
});
