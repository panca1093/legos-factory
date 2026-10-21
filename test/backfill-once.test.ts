import { expect, it } from 'vitest';
import { openDb } from '../server/db.ts';
import { WorkItems } from '../server/work-items.ts';
import type { Plan } from '../shared/types.ts';

const setup = () => {
  const db = openDb(':memory:');
  const items = new WorkItems(db);
  items.create('local', 'PROJ-1');
  items.addRepo('local', 'PROJ-1', 'acme/api');
  items.link('local', 'PROJ-1', { repo: 'acme/api', kind: 'impl', prId: 7, branch: 'main', title: 'Build', state: 'MERGED', runId: null });
  return { db, items };
};

const stages = (items: WorkItems) => items.repos('local', 'PROJ-1').map((r) => r.stage);

it('the backfill runs only once', () => {
  const { items } = setup();
  items.backfillStages();
  expect(stages(items)).toEqual(['done']);
  items.setStage('local', 'PROJ-1', 'acme/api', 'building');
  items.backfillStages();
  expect(stages(items)).toEqual(['building']);
});

it('the backfill skips a repo that has a plan', () => {
  const { items } = setup();
  items.addRepo('local', 'PROJ-1', 'acme/web');
  items.link('local', 'PROJ-1', { repo: 'acme/web', kind: 'impl', prId: 8, branch: 'main', title: 'Build', state: 'MERGED', runId: null });
  const plan: Plan = {
    tasks: [{ id: 'T1', do: 'Build acme/api', repo: 'acme/api', test: '', needs: [], touches: [], state: 'waiting' }],
    error: null,
  };
  items.setPlan('local', 'PROJ-1', plan);
  items.backfillStages();
  expect(stages(items)).toEqual(['building', 'done']);
});
