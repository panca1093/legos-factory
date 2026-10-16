// Runtime-agnostic model. Claude Code is the first adapter; Codex/Hermes map onto the same shapes.

export type Usage = {
  input: number; // uncached input
  cacheWrite: number;
  cacheRead: number;
  output: number;
};

export type TimelineEvent = {
  id: string;
  at: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'system';
  text: string;
  tool?: string;
  isError?: boolean;
  sidechain?: boolean;
};

export type SessionSummary = {
  id: string;
  runtime: 'claude-code';
  cwd: string | null;
  title: string;
  gitBranch: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  models: string[];
  turns: number;
  toolCalls: number;
  toolErrors: number;
  subagents: number;
  ticket: string | null;
  share: ShareLevel;
  // null when no assistant record carried usage — unknown, not zero
  usage: Usage | null;
  activeRunId: string | null;
};

export type SessionDetail = SessionSummary & { events: TimelineEvent[] };

// queued = waiting for a free slot (too many live runs). idle = turn finished, process alive, waiting
// for your next message. completed = session ended.
export type RunStatus = 'queued' | 'starting' | 'running' | 'awaiting_decision' | 'idle' | 'completed' | 'failed';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan';

// What the team hub may see of a run: nothing, status only, or the full timeline.
export type ShareLevel = 'private' | 'status' | 'full';

export type Settings = {
  share: { default: ShareLevel; rules: { path: string; level: ShareLevel }[] };
  // the Jira status names work items move through, in order
  jiraFlow: JiraFlow;
};

export type JiraFlow = { todo: string; inProgress: string; codeReview: string; readyForQa: string };

// design = write the spec and open a PR for it; build = implement it and open a PR
export type Stage = 'design' | 'build';

// chat = interactive discussion; task = one prompt, runs to completion, no follow-ups
export type RunKind = 'chat' | 'task';

export type Run = {
  id: string;
  // user id of whoever launched it
  owner: string;
  // "workspace/repo" when it works in a fresh clone of that repo
  repo: string | null;
  kind: RunKind;
  // a task converted to a chat via Discuss
  fromTask: boolean;
  ticket: string | null;
  // set exactly when the run works on a ticket
  stage: Stage | null;
  share: ShareLevel;
  runtime: 'claude-code';
  sessionId: string | null;
  resumedFrom: string | null;
  cwd: string;
  prompt: string;
  permissionMode: PermissionMode;
  status: RunStatus;
  // what you picked (alias or 'default'); model is what the CLI resolved it to
  requestedModel: string;
  model: string | null;
  startedAt: string;
  lastEventAt: string;
  endedAt: string | null;
  endedBy: 'user' | 'idle_timeout' | null;
  turns: number;
  // last turn's error; the session can stay alive after a failed turn
  error: string | null;
  // SDK's own estimate (API-equivalent), never an invoice
  estimatedCostUsd: number | null;
  // final assistant text of a finished task
  result: string | null;
  events: TimelineEvent[];
};

export type ModelOption = { value: string; displayName: string; description: string };

export type PendingDecision = {
  id: string;
  runId: string;
  cwd: string;
  toolName: string;
  title: string | null;
  reason: string | null;
  input: Record<string, unknown>;
  createdAt: string;
};

// answers: AskUserQuestion clarifications, keyed by question text
export type DecisionAnswer = { behavior: 'allow'; answers?: Record<string, string> } | { behavior: 'deny'; message?: string };

// "Ask factory" on a PR: review comments worked through one at a time. Each gets a read-only proposal,
// waits for your approval, then a fix run commits and pushes and the factory replies on the comment.
export type FixStatus = 'pending' | 'proposing' | 'proposed' | 'fixing' | 'done' | 'skipped' | 'failed';

export type FixItem = {
  commentId: number;
  author: string | null;
  text: string;
  path: string | null;
  line: number | null;
  status: FixStatus;
  proposal: string | null;
  // your edits or extra instructions, given when approving
  note: string | null;
  // the run working on it right now, or the last one that did
  runId: string | null;
  commit: string | null;
  replied: boolean;
  error: string | null;
};

// preparing = cloning the PR branch; waiting = a proposal or a failure needs you
export type FixQueueStatus = 'preparing' | 'working' | 'waiting' | 'done' | 'cancelled' | 'failed';

export type FixQueue = {
  id: string;
  owner: string;
  repo: string;
  prId: number;
  branch: string;
  status: FixQueueStatus;
  error: string | null;
  items: FixItem[];
  createdAt: string;
  updatedAt: string;
};

export type StreamMessage =
  | { type: 'snapshot'; runs: Run[]; decisions: PendingDecision[] }
  | { type: 'run'; run: Omit<Run, 'events'> }
  | { type: 'run_event'; runId: string; event: TimelineEvent }
  | { type: 'decision'; decision: PendingDecision }
  | { type: 'decision_closed'; id: string; outcome: 'allowed' | 'denied' | 'withdrawn' };

// One run as recorded for activity views (latest state wins per runId).
export type ActivityItem = {
  runId: string;
  kind: RunKind;
  title: string;
  project: string;
  repo: string | null;
  ticket: string | null;
  stage: Stage | null;
  share: ShareLevel;
  status: RunStatus;
  endedBy: Run['endedBy'];
  model: string | null;
  sessionId: string | null;
  startedAt: string;
  lastEventAt: string;
  endedAt: string | null;
  turns: number;
  estimatedCostUsd: number | null;
};

// What the team hub receives and shows: never cost, prompt body, paths or transcripts.
export type TeamItem = Omit<ActivityItem, 'share' | 'estimatedCostUsd' | 'stage'>;

export type TeamMember = { email: string; lastSeen: string; items: TeamItem[] };

// A ticket plus the repos it touches, and the PRs that came out of it.
export type LinkKind = 'spec' | 'impl';
export type TicketLink = {
  repo: string;
  kind: LinkKind;
  prId: number;
  branch: string;
  title: string;
  // OPEN | MERGED | DECLINED | SUPERSEDED, as Bitbucket says
  state: string;
  runId: string | null;
  // already announced on the Jira ticket
  commented: boolean;
  updatedAt: string;
};
// the latest skip or error of the Jira sync or PR capture; transitions live in Jira's own history
export type WorkItemNote = { text: string; at: string };
export type WorkItem = {
  ticket: string;
  repos: { name: string; addedAt: string }[];
  links: TicketLink[];
  note: WorkItemNote | null;
  // the Jira status last read
  status: string | null;
};
