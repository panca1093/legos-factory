import type { Persona, PipelineStage, Plan, PlanTask, Run, TicketLink } from '../shared/types.ts';

import { HttpError, NO_WB, errMsg, type Deps } from './http.ts';
import { launchRun, launchSchema } from './launch-run.ts';
import { loadSettings } from './policy.ts';
import { canRunTogether, parsePlan } from './plan.ts';
import { route } from './routing.ts';
import { parseRepo, safeName } from './workspace.ts';
import type { PrFile } from './workbench.ts';

export type State = {
  repos: { repo: string; stage: PipelineStage; attempt: number }[];
  plan: Plan | null;
};

export type Facts = {
  reviewAttempts: number;
  // how many Builder runs may work at once; 0 (the default) keeps one task at a time
  parallelBuilders?: number;
  ruleMatched?: boolean;
  inspectorReasons?: string[];
  // a Foreman run is still working on this repo: its spec PR is being revised, not waiting for review
  foremanRunning?: boolean;
  event?:
    | { type: 'spec_approved' }
    | { type: 'run_ended'; repo: string; task: string | null; persona: Persona; ok: boolean; verdict?: 'pass' | 'changes_requested' }
    | { type: 'pr'; repo: string; kind: 'spec' | 'impl'; state: 'opened' | 'approved' | 'merged' | 'declined' };
};

export type Action =
  | { type: 'start_run'; repo: string; task: string; persona: Persona }
  | { type: 'set_stage'; repo: string; stage: PipelineStage; attempt: number }
  | { type: 'set_task'; task: string; state: PlanTask['state'] }
  | { type: 'escalate'; repo: string; task?: string; reason: string }
  | { type: 'mark_ready'; repo: string };

export function next(state: State, facts: Facts): Action[] {
  const tasks = state.plan?.tasks ?? [];
  const event = facts.event;
  const limit = Math.max(0, facts.parallelBuilders ?? 0);
  const setStage = (repo: string, stage: PipelineStage, attempt = 0): Action => ({ type: 'set_stage', repo, stage, attempt });
  const start = (task: PlanTask, persona: Persona): Action => ({ type: 'start_run', repo: task.repo, task: task.id, persona });
  const schedule = (planTasks: PlanTask[], repos = state.repos): Action[] => {
    if (planTasks.some((task) => task.state === 'failed')) return [];
    const busy = planTasks.filter((task) => task.state === 'running' || task.state === 'paused');
    const candidates = planTasks.filter((task) => task.state === 'waiting'
      && repos.some((repo) => repo.repo === task.repo && repo.stage === 'building')
      && task.needs.every((id) => planTasks.some((dependency) => dependency.id === id && dependency.state === 'done')));
    if (!limit) return busy.length || !candidates.length ? [] : [start(candidates[0], 'builder')];
    const plan = { tasks: planTasks, error: null };
    const picks: PlanTask[] = [];
    for (const task of candidates) {
      if (busy.length + picks.length >= limit) break;
      if ([...busy, ...picks].every((other) => canRunTogether(task, other, plan))) picks.push(task);
    }
    return picks.map((task) => start(task, 'builder'));
  };

  if (!event) return schedule(tasks);
  if (event.type === 'spec_approved') {
    const approved = state.repos.filter((repo) => ['backlog', 'shaping', 'spec_review'].includes(repo.stage));
    const repos = state.repos.map((repo) => approved.includes(repo) ? { ...repo, stage: 'building' as const, attempt: 0 } : repo);
    return [
      ...approved.map((repo) => setStage(repo.repo, 'building')),
      ...schedule(tasks, repos),
    ];
  }
  const repo = state.repos.find((repo) => repo.repo === event.repo);
  if (!repo) return [];
  if (event.type === 'pr') {
    if (event.state === 'declined') return [{ type: 'escalate', repo: repo.repo, reason: `${event.kind} PR declined` }];
    if (event.kind === 'spec') {
      return event.state === 'opened' && repo.stage === 'shaping' && !facts.foremanRunning ? [setStage(repo.repo, 'spec_review')] : [];
    }
    if (event.state === 'merged') return repo.stage === 'done' ? [] : [setStage(repo.repo, 'done')];
    if (event.state === 'approved' && repo.stage === 'pr_review') return [{ type: 'mark_ready', repo: repo.repo }];
    const repoTasks = tasks.filter((task) => task.repo === repo.repo);
    if (event.state !== 'opened' || repo.stage !== 'building' || !repoTasks.length || repoTasks.some((task) => task.state !== 'done')) return [];
    return facts.ruleMatched || facts.inspectorReasons?.length
      ? [setStage(repo.repo, 'pr_review')]
      : [{ type: 'mark_ready', repo: repo.repo }];
  }
  const task = tasks.find((task) => task.id === event.task && task.repo === repo.repo);
  if (repo.stage !== 'building' || !task || task.state !== 'running') return [];
  if (event.persona === 'builder') return event.ok ? [start(task, 'inspector')] : [];
  if (event.persona !== 'inspector') return [];
  if (!event.ok || event.verdict === 'changes_requested') {
    const attempt = repo.attempt + 1;
    return [setStage(repo.repo, 'building', attempt), ...(attempt >= facts.reviewAttempts
      ? [{ type: 'set_task', task: task.id, state: 'failed' }, { type: 'escalate', repo: repo.repo, task: task.id, reason: 'review attempts exhausted' }] as Action[]
      : [start(task, 'builder')])];
  }
  if (event.verdict !== 'pass') return [];
  const planTasks = tasks.map((candidate) => candidate.id === task.id ? { ...candidate, state: 'done' as const } : candidate);
  return [{ type: 'set_task', task: task.id, state: 'done' }, setStage(repo.repo, 'building'), ...schedule(planTasks)];
}

const queues = new WeakMap<Deps, Map<string, Promise<void>>>();
const ended = new WeakMap<Deps, Set<string>>();

const HUMAN_REVIEW = /^Human review:(.*)$/;

// The Inspector asks for a person with an explicit line; the rest of its text is findings, not a reason.
function humanReviewReasons(result: string | null | undefined): string[] {
  const reasons: string[] = [];
  for (const line of (result ?? '').split('\n')) {
    const reason = HUMAN_REVIEW.exec(line.trim())?.[1].trim();
    if (reason) reasons.push(reason);
  }
  return reasons;
}

function serial(deps: Deps, owner: string, ticket: string, work: () => Promise<void>): Promise<void> {
  let pending = queues.get(deps);
  if (!pending) queues.set(deps, pending = new Map());
  const key = `${owner}\n${ticket}`;
  const run = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  pending.set(key, run);
  void run.finally(() => { if (pending.get(key) === run) pending.delete(key); }).catch(() => {});
  return run;
}

const stateOf = (deps: Deps, owner: string, ticket: string): State => ({
  repos: deps.workItems.repos(owner, ticket).map((r) => ({ repo: r.name, stage: r.stage, attempt: r.attempt })),
  plan: deps.workItems.get(owner, ticket)?.plan ?? null,
});

// A Foreman run still working on the repo: the spec PR it opened is being revised, not waiting for review.
function foremanBusy(deps: Deps, owner: string, ticket: string, repo: string): boolean {
  const snapshot = deps.runs.snapshot();
  if (snapshot.type !== 'snapshot') return false;
  return snapshot.runs.some((r) => r.owner === owner && r.ticket === ticket && (r.repo ?? '').toLowerCase() === repo.toLowerCase() && r.persona === 'foreman' && !r.endedAt);
}

// The branch a task run works on; the merge run merges these branches into one.
const taskBranch = (ticket: string, task: string) => `factory/${ticket}/${safeName(task)}`;

// Starts the run of one plan task: the plan marks the task running, the prompt carries the task and the findings.
async function startTaskRun(deps: Deps, owner: string, ticket: string, task: PlanTask, persona: Persona, opts: { findings?: string; cwd?: string } = {}): Promise<void> {
  const plan = deps.workItems.get(owner, ticket)?.plan;
  if (!plan) return;
  deps.workItems.setPlan(owner, ticket, { ...plan, tasks: plan.tasks.map((t) => t.id === task.id ? { ...t, state: 'running' } : t) });
  const impl = deps.workItems.links(owner, ticket).find((l) => l.repo.toLowerCase() === task.repo.toLowerCase() && l.kind === 'impl' && l.state === 'OPEN')?.branch;
  const own = taskBranch(ticket, task.id);
  // The task branch is not on the remote yet: the Builder creates it, the Inspector reads it.
  const branch = impl ?? (persona === 'builder' ? undefined : own);
  const lines = [
    `${persona === 'inspector' ? 'Review' : 'Implement'} task ${task.id}: ${task.do}`,
    `Test: ${task.test}`,
    `Approved plan:\n${JSON.stringify(plan)}`,
  ];
  if (opts.findings) lines.push(`Previous run findings:\n${opts.findings}`);
  if (persona === 'inspector') lines.push(`The work of this task is on the branch ${impl ?? own}.`);
  else if (impl) lines.push(`The pull request for ${task.repo} is already open on ${impl}: commit and push your work to that branch, and do not open a new pull request.`);
  else lines.push(`Work on the branch ${own}: create it from the default branch if it does not exist yet, check it out if it does, then commit and push your work there.\nDo not open a pull request: the factory merges the task branches and opens one pull request for the repo.`);
  const prompt = lines.join('\n');
  try {
    await launchRun(deps, owner, launchSchema.parse({
      ticket, stage: 'build', kind: 'task', task: task.id, persona, prompt, branch,
      ...(opts.cwd ? { cwd: opts.cwd } : { repo: task.repo }),
    }));
  } catch (err) {
    deps.workItems.setPlan(owner, ticket, { ...plan, tasks: plan.tasks.map((t) => t.id === task.id ? { ...t, state: 'failed' } : t) });
    deps.workItems.setNote(owner, ticket, `Escalated: ${task.repo}: ${errMsg(err)}`);
  }
}

// The repos a pipeline run of this persona already worked on: never start a second one.
const reposWithRun = (deps: Deps, owner: string, ticket: string, persona: Persona): string[] =>
  (deps.db.prepare(`select distinct lower(json_extract(item, '$.repo')) as repo from runs
      where owner = ? and persona = ? and task is null and json_extract(item, '$.ticket') = ? and json_extract(item, '$.repo') is not null`)
    .all(owner, persona, ticket) as { repo: string }[]).map((row) => row.repo);

// The repos whose tasks are all done and that still wait for their one pull request.
function reposToMerge(deps: Deps, owner: string, ticket: string): string[] {
  const plan = deps.workItems.get(owner, ticket)?.plan;
  if (!plan) return [];
  const links = deps.workItems.links(owner, ticket);
  const started = reposWithRun(deps, owner, ticket, 'builder');
  return deps.workItems.repos(owner, ticket)
    .filter((repo) => {
      const tasks = plan.tasks.filter((task) => task.repo === repo.name);
      return repo.stage === 'building'
        && tasks.length > 0
        && tasks.every((task) => task.state === 'done')
        && !links.some((l) => l.kind === 'impl' && l.state === 'OPEN' && l.repo.toLowerCase() === repo.name.toLowerCase())
        && !started.includes(repo.name.toLowerCase());
    })
    .map((repo) => repo.name);
}

// One pull request per repo: a Builder merges the task branches, runs the suite and opens it.
async function startMergeRun(deps: Deps, owner: string, ticket: string, repo: string): Promise<void> {
  const tasks = (deps.workItems.get(owner, ticket)?.plan?.tasks ?? []).filter((task) => task.repo === repo);
  const target = `factory/${ticket}/${repo.split('/').pop() ?? repo}`;
  const branches = tasks.map((task) => `- ${taskBranch(ticket, task.id)} (task ${task.id}: ${task.do})`).join('\n');
  const tests = tasks.map((task) => task.test).filter(Boolean).join(', ');
  const prompt = `Merge the task branches of ${ticket} for ${repo} into one branch and open one pull request.\n\nBranches to merge:\n${branches}\n\nCreate ${target} from the default branch and merge every branch above into it, resolving the conflicts.\nThen run the full test suite of the repo${tests ? ` and the tests of every merged task (${tests})` : ''}.\nOnly when everything is green, push ${target} and open one pull request for ${ticket} with ${target} as the source branch.`;
  try {
    await launchRun(deps, owner, launchSchema.parse({ ticket, stage: 'build', kind: 'task', persona: 'builder', repo, prompt }));
  } catch (err) {
    deps.workItems.setNote(owner, ticket, `Escalated: ${repo}: ${errMsg(err)}`);
  }
}

// The Cataloger files what the merged work taught the repo.
async function startCatalogerRun(deps: Deps, owner: string, ticket: string, repo: string): Promise<void> {
  const prompt = `Catalog what ${ticket} changed in ${repo} now that its pull request was merged.\nKeep the decisions and their why, the surprises, the traps and the invariants the code relies on.\nWrite it where this repo keeps docs of this kind; if it has no such place, write the summary in your answer.\nCommit the documentation on a branch of your own, never the main branch, and push it.\nDo not open a pull request: this run opens none.`;
  try {
    await launchRun(deps, owner, launchSchema.parse({ ticket, stage: 'build', kind: 'task', persona: 'cataloger', repo, prompt }));
  } catch (err) {
    deps.workItems.setNote(owner, ticket, `Escalated: ${repo}: ${errMsg(err)}`);
  }
}

async function apply(deps: Deps, owner: string, ticket: string, facts: Facts, previous?: Omit<Run, 'events'>) {
  const state = stateOf(deps, owner, ticket);
  const event = facts.event;
  const { automation } = await loadSettings();
  const effective: Facts = {
    ...facts,
    parallelBuilders: automation.parallelBuilders,
    ...(event?.type === 'pr' && event.kind === 'spec' ? { foremanRunning: foremanBusy(deps, owner, ticket, event.repo) } : {}),
  };
  for (const action of next(state, effective)) {
    if (action.type === 'set_stage') deps.workItems.setStage(owner, ticket, action.repo, action.stage, action.attempt);
    else if (action.type === 'mark_ready') deps.workItems.setStage(owner, ticket, action.repo, 'ready');
    else if (action.type === 'escalate') deps.workItems.setNote(owner, ticket, `Escalated: ${action.repo}: ${action.reason}`);
    else if (action.type === 'set_task') {
      const plan = deps.workItems.get(owner, ticket)?.plan;
      if (plan) deps.workItems.setPlan(owner, ticket, { ...plan, tasks: plan.tasks.map((t) => t.id === action.task ? { ...t, state: action.state } : t) });
    } else {
      const snapshot = deps.runs.snapshot();
      if (snapshot.type === 'snapshot' && snapshot.runs.some((r) => r.owner === owner && r.ticket === ticket && r.task === action.task && !r.endedAt)) continue;
      const plan = deps.workItems.get(owner, ticket)?.plan;
      const task = plan?.tasks.find((t) => t.id === action.task);
      if (!task || !plan) continue;
      await startTaskRun(deps, owner, ticket, task, action.persona, {
        findings: previous?.result ?? undefined,
        cwd: previous?.repo === task.repo ? previous.cwd : undefined,
      });
    }
  }
  for (const repo of reposToMerge(deps, owner, ticket)) await startMergeRun(deps, owner, ticket, repo);
  if (event?.type === 'pr' && event.kind === 'impl' && event.state === 'merged'
    && automation.models.cataloger && automation.models.cataloger !== 'off'
    && !reposWithRun(deps, owner, ticket, 'cataloger').includes(event.repo.toLowerCase())) {
    await startCatalogerRun(deps, owner, ticket, event.repo);
  }
}

export function approveSpec(deps: Deps, owner: string, ticket: string): Promise<void> {
  return serial(deps, owner, ticket, async () => {
    const item = deps.workItems.get(owner, ticket);
    if (!item) throw new HttpError(404, 'work item not found');
    const state = stateOf(deps, owner, ticket);
    if (!state.repos.some((r) => ['backlog', 'shaping', 'spec_review'].includes(r.stage))) return;
    const link = deps.workItems.links(owner, ticket).find((l) => l.kind === 'spec' && l.state !== 'DECLINED');
    if (!link) throw new HttpError(409, 'link the spec PR before approving');
    const wb = await deps.workbench(owner);
    if (!wb) throw new HttpError(409, NO_WB);
    const repo = parseRepo(link.repo)!;
    const pr = await wb.client.bitbucketPr(wb.token, repo.workspace, repo.slug, link.prId);
    deps.workItems.setPlan(owner, ticket, parsePlan(pr.description, state.repos.map((r) => r.repo)));
    await apply(deps, owner, ticket, { reviewAttempts: (await loadSettings()).automation.reviewAttempts, event: { type: 'spec_approved' } });
  });
}

// The person approves a routed PR: the repo is ready to merge.
export function approvePr(deps: Deps, owner: string, ticket: string, repo: string): Promise<void> {
  return serial(deps, owner, ticket, async () => {
    const state = stateOf(deps, owner, ticket);
    const found = state.repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase());
    if (!found) throw new HttpError(404, 'that repo is not part of this work item');
    if (found.stage !== 'pr_review') throw new HttpError(409, 'that PR is not waiting for a review');
    await apply(deps, owner, ticket, { reviewAttempts: (await loadSettings()).automation.reviewAttempts, event: { type: 'pr', repo: found.repo, kind: 'impl', state: 'approved' } });
  });
}

// The person asks for changes on the spec: the Foreman revises the same spec PR on the same branch.
export function requestSpecChanges(deps: Deps, owner: string, ticket: string, comment: string): Promise<void> {
  return serial(deps, owner, ticket, async () => {
    if (!deps.workItems.get(owner, ticket)) throw new HttpError(409, 'work item not found');
    const link = deps.workItems.links(owner, ticket).find((l) => l.kind === 'spec' && l.state !== 'DECLINED');
    if (!link) throw new HttpError(409, 'link the spec PR before asking for changes');
    const repo = deps.workItems.repos(owner, ticket).find((r) => r.name.toLowerCase() === link.repo.toLowerCase());
    if (!repo) throw new HttpError(409, 'the spec PR is not part of this work item');
    deps.workItems.setStage(owner, ticket, repo.name, 'shaping', repo.attempt);
    await launchRun(deps, owner, launchSchema.parse({
      ticket, stage: 'design', kind: 'task', persona: 'foreman', repo: repo.name, branch: link.branch,
      prompt: `Revise the spec for ${ticket} on the existing spec pull request.\n\nRequested changes:\n${comment}`,
    }));
  });
}

// The person asks for changes on an implementation PR: the Builder works on the same branch again.
export function requestPrChanges(deps: Deps, owner: string, ticket: string, repo: string, comment: string): Promise<void> {
  return serial(deps, owner, ticket, async () => {
    const found = deps.workItems.repos(owner, ticket).find((r) => r.name.toLowerCase() === repo.toLowerCase());
    if (!found) throw new HttpError(404, 'that repo is not part of this work item');
    const link = deps.workItems.links(owner, ticket).find((l) => l.kind === 'impl' && l.state === 'OPEN' && l.repo.toLowerCase() === found.name.toLowerCase());
    if (!link) throw new HttpError(409, 'there is no open implementation PR for that repo');
    deps.workItems.setStage(owner, ticket, found.name, 'building', found.attempt);
    const plan = deps.workItems.get(owner, ticket)?.plan ?? null;
    const task = plan?.tasks.filter((t) => t.repo.toLowerCase() === found.name.toLowerCase()).at(-1);
    if (!plan || !task) {
      await launchRun(deps, owner, launchSchema.parse({
        ticket, stage: 'build', kind: 'task', persona: 'builder', repo: found.name, branch: link.branch,
        prompt: `Implement ${ticket} on the existing pull request.\n\nRequested changes:\n${comment}`,
      }));
      return;
    }
    await startTaskRun(deps, owner, ticket, task, 'builder', { findings: comment });
  });
}

export function pipelineRunEnded(deps: Deps, run: Omit<Run, 'events'>): Promise<void> {
  if (!run.ticket || !run.repo || !run.task || !run.persona || !run.endedAt) return Promise.resolve();
  return serial(deps, run.owner, run.ticket, async () => {
    let seen = ended.get(deps);
    if (!seen) ended.set(deps, seen = new Set());
    if (seen.has(run.id)) return;
    seen.add(run.id);
    const task = deps.workItems.get(run.owner, run.ticket!)?.plan?.tasks.find((t) => t.id === run.task);
    if (task?.state !== 'running') return;
    if (run.persona === 'inspector') {
      deps.workItems.setRouting(run.owner, run.ticket!, run.repo!, {
        at: new Date().toISOString(),
        reasons: [],
        matches: [],
        inspectorReasons: humanReviewReasons(run.result),
        findings: run.result ?? '',
      });
    }
    const declined = deps.workItems.links(run.owner, run.ticket!).find((l) => l.state === 'DECLINED');
    if (declined) {
      await apply(deps, run.owner, run.ticket!, { reviewAttempts: 0, event: { type: 'pr', repo: declined.repo, kind: declined.kind, state: 'declined' } });
      return;
    }
    const ok = run.status === 'completed' && !run.endedBy && !run.error;
    const verdicts = [...(run.result ?? '').matchAll(/^Verdict:\s*(APPROVE|REQUEST_CHANGES|ABSTAIN)\s*$/gm)].map((m) => m[1]);
    if (run.endedBy || (!ok && run.persona === 'builder') || (run.persona === 'inspector' && ok && (verdicts.length !== 1 || verdicts[0] === 'ABSTAIN'))) {
      const plan = deps.workItems.get(run.owner, run.ticket!)!.plan!;
      deps.workItems.setPlan(run.owner, run.ticket!, { ...plan, tasks: plan.tasks.map((t) => t.id === task.id ? { ...t, state: 'failed' } : t) });
      deps.workItems.setNote(run.owner, run.ticket!, `Escalated: ${run.repo}: ${run.endedBy ? 'Run was stopped' : ok ? 'Inspector did not return a decisive verdict' : 'Builder run did not complete'}`);
      return;
    }
    await apply(deps, run.owner, run.ticket!, {
      reviewAttempts: (await loadSettings()).automation.reviewAttempts,
      event: { type: 'run_ended', repo: run.repo!, task: run.task, persona: run.persona!, ok, verdict: verdicts[0] === 'APPROVE' ? 'pass' : verdicts[0] === 'REQUEST_CHANGES' ? 'changes_requested' : undefined },
    }, run);
    await tick(deps, run.owner, run.ticket!);
  });
}

type RoutingOutcome =
  | { kind: 'decided'; toPerson: boolean; reasons: string[]; matches: { id: string; reason: string }[]; inspectorReasons: string[]; findings: string }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'waiting' };

// The facts a routing decision is made of: what the PR changed and what the ticket is.
async function decideRouting(deps: Deps, owner: string, ticket: string, link: TicketLink): Promise<RoutingOutcome> {
  const name = link.repo.toLowerCase();
  const repo = deps.workItems.repos(owner, ticket).find((r) => r.name.toLowerCase() === name);
  if (!repo || repo.stage !== 'building') return { kind: 'waiting' };
  const tasks = (deps.workItems.get(owner, ticket)?.plan?.tasks ?? []).filter((task) => task.repo.toLowerCase() === name);
  if (!tasks.length || tasks.some((task) => task.state !== 'done')) return { kind: 'waiting' };
  const wb = await deps.workbench(owner);
  if (!wb) return { kind: 'unreadable', reason: 'no workbench connected' };
  const ref = parseRepo(link.repo);
  if (!ref) return { kind: 'unreadable', reason: 'repo is not workspace/slug' };
  let files: PrFile[];
  try {
    files = await wb.client.bitbucketPrFiles(wb.token, ref.workspace, ref.slug, link.prId);
  } catch (err) {
    return { kind: 'unreadable', reason: errMsg(err) };
  }
  let jiraType: string | null = null;
  let labels: string[] = [];
  try {
    const issue = await wb.client.jiraIssue(wb.token, ticket);
    jiraType = issue.issueType ?? null;
    labels = issue.labels ?? [];
  } catch {
    // a jira rule cannot match a ticket that could not be read
  }
  const stored = deps.workItems.routing(owner, ticket)[name];
  const inspectorReasons = stored?.inspectorReasons ?? [];
  const decision = route({
    files: files.map((file) => file.path),
    changedLines: files.reduce((sum, file) => sum + file.added + file.removed, 0),
    repo: link.repo,
    jiraType,
    labels,
  }, (await loadSettings()).automation.routing, inspectorReasons);
  return { kind: 'decided', toPerson: decision.toPerson, reasons: decision.reasons, matches: decision.matches, inspectorReasons, findings: stored?.findings ?? '' };
}

async function tick(deps: Deps, owner: string, ticket: string) {
  const { automation } = await loadSettings();
  const links = deps.workItems.links(owner, ticket);
  const routed = new Set<string>();
  for (const link of links) {
    const state = link.state === 'MERGED' ? 'merged' : link.state === 'DECLINED' ? 'declined' : link.state === 'OPEN' ? 'opened' : null;
    if (!state) continue;
    if (link.kind === 'impl' && state === 'opened' && !routed.has(link.repo.toLowerCase())) {
      const outcome = await decideRouting(deps, owner, ticket, link);
      if (outcome.kind === 'waiting') continue;
      if (outcome.kind === 'unreadable') {
        deps.workItems.setNote(owner, ticket, `Escalated: ${link.repo}: Routing could not read the PR for ${link.repo}: ${outcome.reason}`);
        continue;
      }
      routed.add(link.repo.toLowerCase());
      deps.workItems.setRouting(owner, ticket, link.repo, {
        at: new Date().toISOString(),
        reasons: outcome.reasons,
        matches: outcome.matches,
        inspectorReasons: outcome.inspectorReasons,
        findings: outcome.findings,
      });
      await apply(deps, owner, ticket, {
        reviewAttempts: automation.reviewAttempts,
        event: { type: 'pr', repo: link.repo, kind: 'impl', state },
        ruleMatched: outcome.toPerson,
        inspectorReasons: outcome.reasons,
      });
      continue;
    }
    await apply(deps, owner, ticket, { reviewAttempts: automation.reviewAttempts, event: { type: 'pr', repo: link.repo, kind: link.kind, state } });
  }
  if (!links.some((l) => l.state === 'DECLINED') && !deps.workItems.get(owner, ticket)?.note?.text.startsWith('Escalated:')) {
    await apply(deps, owner, ticket, { reviewAttempts: automation.reviewAttempts });
  }
}

export function syncPipeline(deps: Deps, owner: string, ticket: string): Promise<void> {
  return serial(deps, owner, ticket, () => tick(deps, owner, ticket));
}
