import type { JiraFlow, LinkKind, Run, StreamMessage } from '../shared/types.ts';
import { NO_WB, errMsg, type Deps } from './http.ts';
import { gitBranch, loadSettings } from './policy.ts';
import { managedWorkspace, parseRepo } from './workspace.ts';

import { pipelineRunEnded, syncPipeline } from './pipeline.ts';

// What the factory knows about a work item: whether work started, its repos and their PRs.
export type Facts = { started: boolean; repos: string[]; links: { repo: string; kind: LinkKind; state: string }[] };
export type Step = { from: string; to: string };

const same = (a: string | null, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

const everyRepo = (f: Facts, states: string[]) =>
  f.repos.length > 0 && f.repos.every((repo) => f.links.some((l) => l.kind === 'impl' && same(l.repo, repo) && states.includes(l.state)));

// The forward moves the facts allow from status, in order. A step whose "from" doesn't match, with the status
// not already at or past its target, stops the walk: that one is skipped (someone moved the ticket elsewhere).
export function planMoves(flow: JiraFlow, status: string | null, f: Facts): { moves: Step[]; skipped: Step | null } {
  const rank = (s: string | null) => [flow.todo, flow.inProgress, flow.codeReview, flow.readyForQa].findIndex((o) => same(s, o));
  const steps = [
    f.started && { from: flow.todo, to: flow.inProgress },
    everyRepo(f, ['OPEN', 'MERGED']) && { from: flow.inProgress, to: flow.codeReview },
    everyRepo(f, ['MERGED']) && { from: flow.codeReview, to: flow.readyForQa },
  ].filter((s): s is Step => !!s);
  const moves: Step[] = [];
  let at = status;
  for (const step of steps) {
    if (rank(at) >= rank(step.to)) continue;
    if (!same(at, step.from)) return { moves, skipped: step };
    moves.push(step);
    at = step.to;
  }
  return { moves, skipped: null };
}

const syncKey = (owner: string, ticket: string) => `${owner}\n${ticket}`;

// One sync at a time per work item: a second call runs after the first. Never rejects.
export function syncWorkItem(deps: Deps, owner: string, ticket: string): Promise<void> {
  const key = syncKey(owner, ticket);
  const run = (deps.syncs.get(key) ?? Promise.resolve()).then(() => syncOnce(deps, owner, ticket)).catch((err) => console.warn(`sync of ${ticket} failed:`, errMsg(err)));
  deps.syncs.set(key, run);
  void run.finally(() => deps.syncs.get(key) === run && deps.syncs.delete(key));
  return run;
}

const CAPTURE_FAILED = 'Error: PR capture failed';

async function syncOnce(deps: Deps, owner: string, ticket: string) {
  const { workItems } = deps;
  const item = workItems.get(owner, ticket);
  if (!item) return;
  // an error outranks a skip; a clean sync clears the note, but a PR capture failure outranks both until its repo gets a link
  let issue: string | null = null;
  const note = (text: string) => void (issue?.startsWith('Error') || (issue = text));
  try {
    const wb = await deps.workbench(owner);
    if (!wb) throw new Error(NO_WB);
    const { client, token } = wb;
    for (const l of workItems.links(owner, ticket)) {
      const repo = parseRepo(l.repo)!;
      try {
        const pr = await client.bitbucketPr(token, repo.workspace, repo.slug, l.prId);
        workItems.update(owner, ticket, l.repo, l.prId, { state: pr.state, title: pr.title });
        if (l.commented) continue;
        const kind = l.kind === 'spec' ? 'Spec' : 'Implementation';
        workItems.update(owner, ticket, l.repo, l.prId, { commented: true });
        await client.jiraAddComment(token, ticket, `${kind} PR for ${l.repo}: ${pr.title} — ${pr.url ?? `#${l.prId}`}`);
      } catch (err) {
        note(`Error: ${l.repo} #${l.prId}: ${errMsg(err)}`);
      }
    }

    const { jiraFlow: flow } = await loadSettings();
    const facts: Facts = { started: deps.activity.workedOn(owner, ticket), repos: workItems.repos(owner, ticket).map((r) => r.name), links: workItems.links(owner, ticket) };
    let status = await client.jiraStatus(token, ticket);
    const plan = planMoves(flow, status, facts);
    let skipped = plan.skipped;
    for (const step of plan.moves) {
      if (!same(status, step.from)) {
        skipped = step;
        break;
      }
      const t = (await client.jiraTransitions(token, ticket)).find((x) => same(x.toStatus, step.to));
      if (!t) {
        skipped = null;
        note(`Error: no transition to ${step.to} from ${status}`);
        break;
      }
      await client.jiraTransition(token, ticket, t.id);
      status = await client.jiraStatus(token, ticket);
    }
    if (skipped) note(`Skipped ${skipped.from} → ${skipped.to}: status was ${status ?? 'unknown'}`);
    const done = same(status, flow.readyForQa) || everyRepo({ ...facts, links: workItems.links(owner, ticket) }, ['MERGED']);
    workItems.setStatus(owner, ticket, status, status === null ? item.done : done);
  } catch (err) {
    note(`Error: ${errMsg(err)}`);
  }
  // re-read: a capture may have failed while this sync ran
  const currentNote = workItems.get(owner, ticket)?.note?.text;
  if (!currentNote?.startsWith(CAPTURE_FAILED) && !currentNote?.startsWith('Escalated:')) workItems.setNote(owner, ticket, issue);
  await syncPipeline(deps, owner, ticket);
}

// The periodic pass: work items not yet at Ready for QA or fully merged, of owners with a connected workbench.
export async function syncDue(deps: Deps): Promise<void> {
  const due = deps.workItems.pending().filter((i) => !deps.syncs.has(syncKey(i.owner, i.ticket)));
  const connected = new Map<string, boolean>();
  for (const owner of new Set(due.map((i) => i.owner))) connected.set(owner, !!(await deps.workbench(owner).catch(() => null)));
  await Promise.all(due.filter((i) => connected.get(i.owner)).map((i) => syncWorkItem(deps, i.owner, i.ticket)));
}

const started = new WeakSet<Deps>();

export function startSyncLoop(deps: Deps, ms: number) {
  if (!started.has(deps)) {
    started.add(deps);
    deps.workItems.backfillStages();
    deps.runs.on('message', (message: StreamMessage) => {
      if (message.type !== 'run') return;
      const run = message.run;
      if (!run.endedAt && run.stage === 'design' && run.ticket && !deps.workItems.get(run.owner, run.ticket)?.plan) {
        const links = deps.workItems.links(run.owner, run.ticket);
        for (const repo of deps.workItems.repos(run.owner, run.ticket)) {
          const worked = deps.db.prepare(`select 1 from runs where owner = ? and run_id != ? and json_extract(item, '$.ticket') = ? and lower(json_extract(item, '$.repo')) = ? and (task is not null or persona is not null) limit 1`).get(run.owner, run.id, run.ticket, repo.name.toLowerCase());
          if (repo.stage === 'building' && repo.attempt === 0 && !worked && !links.some((l) => l.repo === repo.name && l.kind === 'impl')) deps.workItems.setStage(run.owner, run.ticket, repo.name, 'shaping');
        }
      }
      if (!run.endedAt || managedWorkspace(deps.wsRoot, run.cwd)) return;
      void pipelineRunEnded(deps, message.run).catch((err) => console.warn('pipeline run end failed:', errMsg(err)));
    });
  }
  const timer = setInterval(() => void syncDue(deps).catch((err) => console.warn('work item sync failed:', errMsg(err))), ms);
  timer.unref?.();
  return timer;
}

// At the end of a design or build run: the open PR of the branch it left the clone on becomes a link.
export async function capturePr(deps: Deps, run: Omit<Run, 'events'>, cwd: string): Promise<void> {
  const { owner, ticket, stage, repo } = run;
  if (!ticket || !stage || !repo || !deps.workItems.hasRepo(owner, ticket, repo)) return;
  try {
    const branch = await gitBranch(cwd);
    if (!branch || branch === (deps.myRepos.get(owner, repo)?.mainBranch ?? 'main')) return;
    const wb = await deps.workbench(owner);
    if (!wb) throw new Error(NO_WB);
    const ref = parseRepo(repo)!;
    const pr = (await wb.client.bitbucketPrs(wb.token, ref.workspace, ref.slug, 'OPEN')).find((p) => p.source === branch);
    if (!pr) return;
    deps.workItems.link(owner, ticket, { repo, kind: stage === 'design' ? 'spec' : 'impl', prId: pr.id, branch, title: pr.title, state: pr.state, runId: run.id });
    if (deps.workItems.get(owner, ticket)?.note?.text.startsWith(`${CAPTURE_FAILED} in ${repo}:`)) deps.workItems.setNote(owner, ticket, null);
  } catch (err) {
    deps.workItems.setNote(owner, ticket, `${CAPTURE_FAILED} in ${repo}: ${errMsg(err)}`);
  } finally {
    await pipelineRunEnded(deps, run);
  }
}
