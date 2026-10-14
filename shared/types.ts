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
  // e.g. ["PROJ"]; empty = detect any KEY-123 shaped ticket
  ticketKeys: string[];
};

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
export type TeamItem = Omit<ActivityItem, 'share' | 'estimatedCostUsd'>;

export type TeamMember = { email: string; lastSeen: string; items: TeamItem[] };
