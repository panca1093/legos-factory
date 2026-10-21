import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDeps } from '../server/app.ts';
import { RunManager } from '../server/claude-runs.ts';
import { launchRun, launchSchema } from '../server/launch-run.ts';
import { loadSettings, saveAutomation } from '../server/policy.ts';
import type { StreamMessage } from '../shared/types.ts';

let root: string;
let originalSettings: string | undefined;

beforeEach(async () => {
  originalSettings = process.env.LEGOS_SETTINGS;
  root = await mkdtemp(join(tmpdir(), 'lf-launch-persona-'));
  process.env.LEGOS_SETTINGS = join(root, 'settings.json');
  const { automation } = await loadSettings();
  await saveAutomation({ ...automation, models: { ...automation.models, builder: 'builder-model' } });
});

afterEach(async () => {
  if (originalSettings === undefined) delete process.env.LEGOS_SETTINGS;
  else process.env.LEGOS_SETTINGS = originalSettings;
  await rm(root, { recursive: true, force: true });
});

function setup() {
  const runs = new RunManager(undefined, undefined, 0);
  const deps = buildDeps(runs, { workspaces: join(root, 'workspaces') });
  const messages: StreamMessage[] = [];
  runs.on('message', (message: StreamMessage) => messages.push(message));
  const launch = (extra: Record<string, unknown> = {}) => launchRun(deps, 'local', launchSchema.parse({
    cwd: root, prompt: 'Implement the approved task', ticket: 'PROJ-123', stage: 'build', kind: 'task', task: 'T1', persona: 'builder', ...extra,
  }));
  return { deps, messages, launch };
}

describe('launch personas', () => {
  it('starts the inspector read-only while leaving other personas writable', async () => {
    const { deps, launch } = setup();
    const start = vi.spyOn(deps, 'startRun');
    try {
      await launch({ persona: 'inspector' });
      expect(start.mock.calls[0][0].readOnly).toBe(true);
      for (const persona of ['builder', 'foreman', 'cataloger', undefined]) {
        await launch({ persona });
        expect(start.mock.calls.at(-1)![0].readOnly).toBeFalsy();
      }
    } finally {
      start.mockRestore();
      deps.db.close();
    }
  });

  it('adds the builder persona to a build run', async () => {
    const { deps, messages, launch } = setup();
    try {
      const persona = await readFile(new URL('../workflows/factory/personas/builder.md', import.meta.url), 'utf8');
      const run = await launch();
      expect(run.prompt.endsWith(`\n\n${persona}`)).toBe(true);
      expect(run.prompt.indexOf('Implement PROJ-123, verify it')).toBeLessThan(run.prompt.indexOf(persona));
      expect(run).toMatchObject({ task: 'T1', persona: 'builder' });
      expect(messages[0]).toMatchObject({ type: 'run', run: { task: 'T1', persona: 'builder' } });
    } finally {
      deps.db.close();
    }
  });

  it('uses the persona model when none is given', async () => {
    const { deps, launch } = setup();
    try {
      expect((await launch()).requestedModel).toBe('builder-model');
    } finally {
      deps.db.close();
    }
  });

  it('keeps an explicit model', async () => {
    const { deps, launch } = setup();
    try {
      expect((await launch({ model: 'explicit-model' })).requestedModel).toBe('explicit-model');
    } finally {
      deps.db.close();
    }
  });
});
