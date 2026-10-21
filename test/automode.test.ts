import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunManager, type QueryFn } from '../server/claude-runs.ts';
import { createApp } from '../server/app.ts';
import { openDb } from '../server/db.ts';
import { Users } from '../server/users.ts';
import { loadSettings } from '../server/policy.ts';

let root: string;
let originalSettings: string | undefined;
let originalOwners: string | undefined;
const databases: ReturnType<typeof openDb>[] = [];
const managers: RunManager[] = [];

beforeEach(async () => {
  originalSettings = process.env.LEGOS_SETTINGS;
  originalOwners = process.env.LEGOS_OWNERS;
  process.env.LEGOS_OWNERS = 'Ada';
  root = await mkdtemp(join(tmpdir(), 'lf-automode-'));
  process.env.LEGOS_SETTINGS = join(root, 'settings.json');
  const { automation } = await loadSettings();
  await writeFile(process.env.LEGOS_SETTINGS, JSON.stringify({ automation: { ...automation, allowlist: ['  go test  '] } }));
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    const snapshot = manager.snapshot();
    if (snapshot.type === 'snapshot') for (const run of snapshot.runs) await manager.end(run.id);
  }
  if (originalSettings === undefined) delete process.env.LEGOS_SETTINGS;
  else process.env.LEGOS_SETTINGS = originalSettings;
  if (originalOwners === undefined) delete process.env.LEGOS_OWNERS;
  else process.env.LEGOS_OWNERS = originalOwners;
  for (const db of databases.splice(0)) db.close();
  await rm(root, { recursive: true, force: true });
});

function start(readOnly = false, owner = 'local') {
  let canUseTool: CanUseTool;
  const fn = (({ prompt, options }: any) => {
    canUseTool = options.canUseTool;
    const stream = (async function* () {
      for await (const _ of prompt) yield { type: 'system', subtype: 'init', session_id: 'acme-session', model: 'sonnet' };
    })() as any;
    stream.interrupt = async () => {};
    return stream;
  }) as QueryFn;
  const manager = new RunManager(fn);
  managers.push(manager);
  const run = manager.start({ cwd: join(root, 'clone'), prompt: 'test', readOnly, owner });
  const request = (tool: string, input: Record<string, unknown>) => Promise.resolve(canUseTool(tool, input, {
    signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'request-1',
  }));
  const decisions = () => {
    const snapshot = manager.snapshot();
    if (snapshot.type !== 'snapshot') throw new Error('expected snapshot');
    return snapshot.decisions;
  };
  return { manager, run, request, decisions };
}

async function allowed(request: Promise<PermissionResult | null>) {
  let result: PermissionResult | null | undefined;
  void request.then((value) => { result = value; });
  await vi.waitFor(() => expect(result?.behavior).toBe('allow'));
  return result;
}

describe('auto mode', () => {
  it('runs an allowlisted command without a decision', async () => {
    const { request, decisions } = start();
    const input = { command: '  go test ./...  ' };
    expect(await allowed(request('Bash', input))).toEqual({ behavior: 'allow', updatedInput: input });
    expect(decisions()).toEqual([]);
  });

  it('pauses on a command outside the allowlist', async () => {
    const { manager, run, request, decisions } = start();
    const pending = request('Bash', { command: 'git push' });
    await vi.waitFor(() => expect(decisions()).toHaveLength(1));
    expect(decisions()[0]).toMatchObject({ toolName: 'Bash', reason: 'outside the allowlist', input: { command: 'git push' } });
    expect(manager.get(run.id)?.status).toBe('awaiting_decision');
    manager.decide(decisions()[0].id, { behavior: 'allow' });
    expect(await pending).toMatchObject({ behavior: 'allow' });
  });

  it('allows edits inside the clone', async () => {
    const { run, request, decisions } = start();
    for (const [tool, input] of [
      ['Edit', { file_path: join(run.cwd, 'src/index.ts') }],
      ['Write', { file_path: 'src/new.ts' }],
      ['NotebookEdit', { notebook_path: join(run.cwd, 'notes.ipynb') }],
    ] as const) expect(await allowed(request(tool, input))).toEqual({ behavior: 'allow', updatedInput: input });
    expect(decisions()).toEqual([]);
  });

  it('pauses on an edit outside the clone', async () => {
    const { manager, run, request, decisions } = start();
    for (const [tool, input] of [
      ['Edit', { file_path: join(root, 'outside.ts') }],
      ['Write', { file_path: '../outside.ts' }],
      ['NotebookEdit', { notebook_path: `${run.cwd}-sibling/notes.ipynb` }],
    ] as const) {
      const pending = request(tool, input);
      await vi.waitFor(() => expect(decisions()).toHaveLength(1));
      expect(decisions()[0]).toMatchObject({ toolName: tool, input });
      manager.decide(decisions()[0].id, { behavior: 'deny' });
      expect(await pending).toMatchObject({ behavior: 'deny' });
    }
  });

  it('keeps read-only runs denied even inside the allowlist or clone', async () => {
    const { run, request, decisions } = start(true);
    expect(await request('Bash', { command: 'go test ./...' })).toMatchObject({ behavior: 'deny' });
    expect(await request('Write', { file_path: join(run.cwd, 'index.ts') })).toMatchObject({ behavior: 'deny' });
    expect(decisions()).toEqual([]);
  });
});

function decisionRoute(signedIn = true) {
  const db = openDb(':memory:');
  databases.push(db);
  const users = signedIn ? new Users(db) : null;
  const user = users?.upsertExternal('workbench', 'acme-user', 'Ada', 'ada@example.com');
  const started = start(false, user?.id ?? 'local');
  const app = createApp(started.manager, { db, users });
  const answer = (id: string, behavior = 'allow') => app.request(`http://localhost/api/decisions/${id}`, {
    method: 'POST',
    headers: { host: 'localhost', 'x-legos': '1', 'content-type': 'application/json', ...(user && { cookie: `lf_sid=${users!.issue(user.id)}` }) },
    body: JSON.stringify({ behavior, remember: true }),
  });
  return { ...started, answer };
}

describe('remember paused commands', () => {
  it('remember adds the command prefix to the allowlist', async () => {
    for (const signedIn of [true, false]) {
      const { request, decisions, answer } = decisionRoute(signedIn);
      const pending = request('Bash', { command: '  git   push origin feature  ' });
      await vi.waitFor(() => expect(decisions()).toHaveLength(1));
      const before = (await loadSettings()).automation;
      expect((await answer(decisions()[0].id)).status).toBe(200);
      expect(await pending).toMatchObject({ behavior: 'allow' });
      expect((await loadSettings()).automation).toEqual({ ...before, allowlist: [...before.allowlist, 'git push'] });
      await writeFile(process.env.LEGOS_SETTINGS!, JSON.stringify({ automation: before }));
    }
  });

  it('remember is ignored for non-Bash decisions', async () => {
    const { request, decisions, answer } = decisionRoute();
    const before = (await loadSettings()).automation;
    const pending = request('Write', { file_path: join(root, 'outside.ts'), command: 'git push origin feature' });
    await vi.waitFor(() => expect(decisions()).toHaveLength(1));
    expect((await answer(decisions()[0].id)).status).toBe(200);
    expect(await pending).toMatchObject({ behavior: 'allow' });
    expect((await loadSettings()).automation).toEqual(before);
  });

  it('remember from a non-owner does not change the allowlist', async () => {
    process.env.LEGOS_OWNERS = 'Other';
    const { request, decisions, answer } = decisionRoute();
    const before = (await loadSettings()).automation;
    const pending = request('Bash', { command: 'git push origin feature' });
    await vi.waitFor(() => expect(decisions()).toHaveLength(1));
    expect((await answer(decisions()[0].id)).status).toBe(200);
    expect(await pending).toMatchObject({ behavior: 'allow' });
    expect((await loadSettings()).automation).toEqual(before);
  });

  it('does not remember a denied command', async () => {
    const { request, decisions, answer } = decisionRoute();
    const before = (await loadSettings()).automation;
    const pending = request('Bash', { command: 'git push origin feature' });
    await vi.waitFor(() => expect(decisions()).toHaveLength(1));
    expect((await answer(decisions()[0].id, 'deny')).status).toBe(200);
    expect(await pending).toMatchObject({ behavior: 'deny' });
    expect((await loadSettings()).automation).toEqual(before);
  });

  it('cannot remember or answer another user’s decision', async () => {
    const { manager, run, request, decisions, answer } = decisionRoute();
    run.owner = 'other';
    const before = (await loadSettings()).automation;
    const pending = request('Bash', { command: 'git push origin feature' });
    await vi.waitFor(() => expect(decisions()).toHaveLength(1));
    const id = decisions()[0].id;
    expect((await answer(id)).status).toBe(410);
    expect(decisions()).toHaveLength(1);
    expect((await loadSettings()).automation).toEqual(before);
    manager.decide(id, { behavior: 'deny' });
    expect(await pending).toMatchObject({ behavior: 'deny' });
  });
});
