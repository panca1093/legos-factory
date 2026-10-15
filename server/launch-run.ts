import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { PermissionMode, Run, ShareLevel } from '../shared/types.ts';
import { detectTicket, gitBranch, loadSettings, shareFor } from './policy.ts';
import { createWorkspace, exists, managedWorkspace, parseRepo, workspacePath, type RepoRef } from './workspace.ts';
import { BRANCH_RE, HttpError, TICKET_RE, domain, optText, text, type Deps } from './http.ts';

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
});

export type LaunchRequest = z.output<typeof launchSchema>;

// Runs in cwd or a fresh clone of repo, with the owner's connections reached through this app's proxy.
export async function launchRun(deps: Deps, uid: string, req: LaunchRequest): Promise<Run> {
  const { runs, activity, opts, wsRoot } = deps;
  const { prompt, branch, permissionMode, resume, model, kind } = req;
  if (resume && !activity.ownsSession(uid, resume)) throw new HttpError(404, 'session not found');
  if (resume && runs.activeRunBySession().has(resume)) throw new HttpError(409, 'session already has an active run');
  const settings = await loadSettings();

  // A repo run works in a fresh clone; continuing one re-clones into the same path.
  let cwd = req.cwd;
  let clone: { path: string; repo: RepoRef } | null = null;
  if (req.repo) {
    const repo = parseRepo(req.repo);
    if (!repo) throw new HttpError(400, 'repo must look like workspace/repo');
    const key = req.ticket || detectTicket(prompt, settings.ticketKeys) || `run-${randomBytes(4).toString('hex')}`;
    clone = { path: workspacePath(wsRoot, uid, repo, key), repo };
  } else if (isAbsolute(cwd) && managedWorkspace(wsRoot, cwd)) {
    const m = managedWorkspace(wsRoot, cwd)!;
    if (m.owner !== uid) throw new HttpError(404, 'session not found');
    clone = { path: cwd, repo: m.repo };
  }
  if (clone) {
    if (deps.busyIn(clone.path)) throw new HttpError(409, `a run is already working in ${clone.path.split('/').pop()}`);
    cwd = clone.path;
    if (req.repo || !(await exists(cwd))) await domain(createWorkspace({ path: cwd, repo: clone.repo, branch, urlTemplate: opts.gitUrl }));
  } else if (!isAbsolute(cwd) || !(await stat(cwd).then((s) => s.isDirectory(), () => false))) {
    throw new HttpError(400, 'cwd must be an existing absolute directory, or pass repo');
  }
  const started = (run: Run) => (clone && deps.clones.set(run.id, clone.path), run);
  const repo = clone ? `${clone.repo.workspace}/${clone.repo.slug}` : null;
  const ticket = req.ticket || detectTicket(prompt, settings.ticketKeys) || detectTicket(await gitBranch(cwd), settings.ticketKeys);
  const share = req.share ?? shareFor(cwd, settings);
  const connected = opts.selfUrl ? (await deps.connsFor(uid).all()).filter((x) => x.connected) : [];
  if (!connected.length) return started(runs.start({ owner: uid, repo, kind, cwd, prompt, permissionMode, resume, model, ticket, share }));
  const secret = randomBytes(24).toString('base64url');
  const mcp = Object.fromEntries(connected.map((x) => [x.name, { url: `${opts.selfUrl}/mcp/${x.name}`, headers: { 'x-legos-run': secret } }]));
  const run = started(runs.start({ owner: uid, repo, kind, cwd, prompt, permissionMode, resume, model, ticket, share, mcp }));
  deps.grants.set(secret, run.id);
  return run;
}
