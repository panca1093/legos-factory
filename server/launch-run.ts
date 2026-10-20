import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { z } from 'zod';
import type { PermissionMode, Run, ShareLevel, Stage } from '../shared/types.ts';
import { syncWorkItem } from './jira-sync.ts';
import { loadSettings, shareFor } from './policy.ts';
import { createWorkspace, exists, managedWorkspace, parseRepo, workspacePath, type RepoRef } from './workspace.ts';
import { BRANCH_RE, HttpError, TICKET_RE, domain, gitToken, optText, requireMyRepo, text, type Deps } from './http.ts';

const MODES = ['default', 'acceptEdits', 'plan'] as const satisfies PermissionMode[];
const SHARES = ['private', 'status', 'full'] as const satisfies ShareLevel[];
// aliases (opus, sonnet) or full ids incl. suffixes like [1m]; validated by the CLI itself
export const MODEL_RE = /^[\w.\-\[\]]{1,64}$/;

// Key order is the order errors are reported in.
export const launchSchema = z.object({
  ticket: text()
    .transform((t) => t.toUpperCase())
    .refine((t) => !t || TICKET_RE.test(t), 'ticket must look like PROJ-123'),
  prompt: text().refine((p) => !!p, 'prompt is required'),
  model: optText().refine((m) => !m || MODEL_RE.test(m), 'invalid model'),
  branch: optText().refine((b) => !b || BRANCH_RE.test(b), 'invalid branch'),
  cwd: text(),
  repo: text(),
  permissionMode: z.enum(MODES).catch('default'),
  resume: z.string().min(1).optional().catch(undefined),
  kind: z.enum(['chat', 'task']).catch('chat'),
  share: z.enum(SHARES).optional().catch(undefined),
  stage: z.enum(['design', 'build']).optional().catch(undefined),
});

// The target repo owns its conventions; the factory only says what the stage should produce.
const STAGE_GUIDE: Record<Stage, (ticket: string) => string> = {
  design: (t) =>
    `Before anything else, read this repo's own conventions: CLAUDE.md, AGENTS.md, CONTRIBUTING and its docs folder. Write the spec for ${t} where this repo keeps specs, then open a pull request for it. Put ${t} in the branch name and in the PR title, following the repo's title format; a spec PR title carries no deployment tag.`,
  build: (t) =>
    `Before anything else, read this repo's own conventions: CLAUDE.md, AGENTS.md, CONTRIBUTING and its docs folder. Implement ${t}, verify it, then open a pull request. Put ${t} in the branch name and in the PR title, following the repo's title format.`,
};

export type LaunchRequest = z.output<typeof launchSchema>;

// Runs in cwd or a fresh clone of repo, with the workspace's connections reached through this app's proxy.
export async function launchRun(deps: Deps, { uid, ws }: { uid: string; ws: string }, req: LaunchRequest): Promise<Run> {
  const { runs, activity, opts, wsRoot } = deps;
  const { prompt, branch, permissionMode, resume, model, kind } = req;
  if (resume && !activity.ownsSession(ws, resume)) throw new HttpError(404, 'session not found');
  if (resume && runs.activeRunBySession().has(resume)) throw new HttpError(409, 'session already has an active run');
  if (req.ticket && !req.stage) throw new HttpError(400, 'a ticket run needs a stage: design or build');
  const stage = req.ticket ? req.stage! : null;
  const settings = await loadSettings();
  const who = deps.users?.get(uid);
  const author = who ? { name: who.name, email: who.email } : undefined;

  // A repo run works in a fresh clone; continuing one re-clones into the same path.
  let cwd = req.cwd;
  let clone: { path: string; repo: RepoRef; key: string } | null = null;
  if (req.repo) {
    const repo = parseRepo(req.repo);
    if (!repo) throw new HttpError(400, 'repo must look like workspace/repo');
    requireMyRepo(deps, ws, req.repo);
    if (stage && !deps.workItems.hasRepo(ws, req.ticket, req.repo)) throw new HttpError(409, `add ${req.repo} to ${req.ticket}'s work item first`, { needWorkItem: true });
    const key = req.ticket || `run-${randomBytes(4).toString('hex')}`;
    clone = { path: workspacePath(wsRoot, ws, repo, key), repo, key };
  } else if (isAbsolute(cwd) && managedWorkspace(wsRoot, cwd)) {
    const m = managedWorkspace(wsRoot, cwd)!;
    if (m.workspaceId !== ws) throw new HttpError(404, 'session not found');
    requireMyRepo(deps, ws, `${m.repo.workspace}/${m.repo.slug}`);
    clone = { path: cwd, repo: m.repo, key: m.key };
  }
  if (clone) {
    if (deps.busyIn(clone.path)) throw new HttpError(409, `a run is already working in ${clone.path.split('/').pop()}`);
    cwd = clone.path;
    const { repo } = clone;
    // with a runner in this process the clone is made now, so a failure reaches the caller; otherwise the runner makes it
    if (deps.embedded && (req.repo || !(await exists(cwd)))) await domain(createWorkspace({ path: cwd, repo, branch, urlTemplate: opts.gitUrl, credential: () => gitToken(deps, ws, repo), author }));
    if (!deps.embedded) cwd = '';
  } else if (!deps.embedded) {
    throw new HttpError(409, 'this control plane has no runner of its own: start the run on a repo');
  } else if (isAbsolute(cwd) && !relative(wsRoot, cwd).startsWith('..')) {
    throw new HttpError(400, 'cwd is inside the factory workspaces: pass repo instead');
  } else if (!isAbsolute(cwd) || !(await stat(cwd).then((s) => s.isDirectory(), () => false))) {
    throw new HttpError(400, 'cwd must be an existing absolute directory, or pass repo');
  }
  const repo = clone ? `${clone.repo.workspace}/${clone.repo.slug}` : null;
  const ticket = req.ticket || null;
  const share = req.share ?? shareFor(cwd, settings);
  const connected = opts.selfUrl ? (await deps.connsFor(ws).all()).filter((x) => x.connected).map((x) => x.name) : [];
  const spec = clone && { repo: repo!, key: clone.key, branch, author };
  const run = deps.startRun(
    { workspaceId: ws, owner: uid, repo, kind, cwd, prompt: stage ? `${prompt}\n\n${STAGE_GUIDE[stage](req.ticket)}` : prompt, permissionMode, resume, model, ticket, stage, share, priority: kind === 'chat' ? 1 : 0, ...(spec && { clone: spec, prepared: deps.embedded, ownsClone: true }) },
    connected,
  );
  if (stage && deps.workItems.get(ws, req.ticket)) void syncWorkItem(deps, ws, req.ticket);
  return run;
}
