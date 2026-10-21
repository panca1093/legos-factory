import type { Persona, PipelineStage, Plan, PlanTask } from '../shared/types.ts';

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
