import type { Persona, PipelineStage, Plan, PlanTask, Run } from '../shared/types.ts';

import { HttpError, NO_WB, errMsg, type Deps } from './http.ts';
import { launchRun, launchSchema } from './launch-run.ts';
import { loadSettings } from './policy.ts';
import { parsePlan } from './plan.ts';
import { parseRepo } from './workspace.ts';

export type State = {
  repos: { repo: string; stage: PipelineStage; attempt: number }[];
  plan: Plan | null;
};

export type Facts = {
  reviewAttempts: number;
  ruleMatched?: boolean;
  inspectorReasons?: string[];
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
  const setStage = (repo: string, stage: PipelineStage, attempt = 0): Action => ({ type: 'set_stage', repo, stage, attempt });
  const start = (task: PlanTask, persona: Persona): Action => ({ type: 'start_run', repo: task.repo, task: task.id, persona });
  const schedule = (planTasks: PlanTask[], repos = state.repos): Action[] => {
    if (planTasks.some((task) => ['running', 'paused', 'failed'].includes(task.state))) return [];
    const task = planTasks.find((task) => task.state === 'waiting'
      && repos.some((repo) => repo.repo === task.repo && repo.stage === 'building')
      && task.needs.every((id) => planTasks.some((dependency) => dependency.id === id && dependency.state === 'done')));
    return task ? [start(task, 'builder')] : [];
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
      return event.state === 'opened' && repo.stage === 'shaping' ? [setStage(repo.repo, 'spec_review')] : [];
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

async function apply(deps: Deps, owner: string, ticket: string, facts: Facts, previous?: Omit<Run, 'events'>) {
  const state = stateOf(deps, owner, ticket);
  for (const action of next(state, facts)) {
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
      deps.workItems.setPlan(owner, ticket, { ...plan, tasks: plan.tasks.map((t) => t.id === task.id ? { ...t, state: 'running' } : t) });
      const branch = deps.workItems.links(owner, ticket).find((l) => l.repo === task.repo && l.kind === 'impl' && l.state === 'OPEN')?.branch;
      const prompt = `${action.persona === 'inspector' ? 'Review' : 'Implement'} task ${task.id}: ${task.do}\nTest: ${task.test}\nApproved plan:\n${JSON.stringify(plan)}${previous?.result ? `\nPrevious run findings:\n${previous.result}` : ''}`;
      try {
        await launchRun(deps, owner, launchSchema.parse({
          ticket, stage: 'build', kind: 'task', task: task.id, persona: action.persona, prompt, branch,
          ...(previous?.repo === task.repo ? { cwd: previous.cwd } : { repo: task.repo }),
        }));
      } catch (err) {
        deps.workItems.setPlan(owner, ticket, { ...plan, tasks: plan.tasks.map((t) => t.id === task.id ? { ...t, state: 'failed' } : t) });
        deps.workItems.setNote(owner, ticket, `Escalated: ${task.repo}: ${errMsg(err)}`);
      }
    }
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

export function pipelineRunEnded(deps: Deps, run: Omit<Run, 'events'>): Promise<void> {
  if (!run.ticket || !run.repo || !run.task || !run.persona || !run.endedAt) return Promise.resolve();
  return serial(deps, run.owner, run.ticket, async () => {
    let seen = ended.get(deps);
    if (!seen) ended.set(deps, seen = new Set());
    if (seen.has(run.id)) return;
    seen.add(run.id);
    const task = deps.workItems.get(run.owner, run.ticket!)?.plan?.tasks.find((t) => t.id === run.task);
    if (task?.state !== 'running') return;
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

async function tick(deps: Deps, owner: string, ticket: string) {
  const { automation } = await loadSettings();
  const links = deps.workItems.links(owner, ticket);
  for (const link of links) {
    const state = link.state === 'MERGED' ? 'merged' : link.state === 'DECLINED' ? 'declined' : link.state === 'OPEN' ? 'opened' : null;
    if (!state) continue;
    if (link.kind === 'impl' && state === 'opened' && automation.routing.some((r) => r.on)) continue;
    await apply(deps, owner, ticket, { reviewAttempts: automation.reviewAttempts, event: { type: 'pr', repo: link.repo, kind: link.kind, state } });
  }
  if (!links.some((l) => l.state === 'DECLINED') && !deps.workItems.get(owner, ticket)?.note?.text.startsWith('Escalated:')) {
    await apply(deps, owner, ticket, { reviewAttempts: automation.reviewAttempts });
  }
}

export function syncPipeline(deps: Deps, owner: string, ticket: string): Promise<void> {
  return serial(deps, owner, ticket, () => tick(deps, owner, ticket));
}
