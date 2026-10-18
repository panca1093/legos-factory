import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ActivityItem, DecisionAnswer, FixQueue, ModelOption, TeamMember, PendingDecision, PermissionMode, Run, RunKind, SessionDetail, SessionSummary, ShareLevel, Stage, StreamMessage, WorkItem } from '../shared/types.ts';

export type Me = {
  authEnabled: boolean;
  // "Sign in with workbench" is configured
  workbenchLogin: boolean;
  // local (PIN) users, for the sign-in screen
  users: string[];
  authenticated: boolean;
  user: { id: string; kind: 'pin' | 'workbench'; name: string; email: string | null } | null;
};

// Any 401 means the session ended (logout elsewhere, refresh failed): show the sign-in screen.
const signedOutListeners = new Set<() => void>();
export const onSignedOut = (f: () => void) => (signedOutListeners.add(f), () => void signedOutListeners.delete(f));

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', 'x-legos': '1', ...init?.headers } });
  if (res.status === 401 && path.startsWith('/api/')) signedOutListeners.forEach((f) => f());
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status, needWorkspace: body.needWorkspace === true });
  return body as T;
}

export type Connection = {
  name: string;
  kind: 'workbench' | 'mcp';
  url: string;
  auth: 'oauth' | 'header';
  connected: boolean;
  user: { id: string | null; name: string | null; email: string | null } | null;
  headerNames: string[];
};
export type NewConnection = Pick<Connection, 'name' | 'kind' | 'url' | 'auth'> & { headers?: Record<string, string> };

export type Integration = { name: string; version: string | null; connected: boolean };
export type JiraDev = {
  prs: { count: number; state: string | null; open: boolean } | null;
  builds: { ok: number; failed: number } | null;
  deploys: { env: string; status: string }[];
  stale: boolean;
};
export type RepoRow = { name: string; mainBranch: string | null; updated: string | null; description: string | null };
export type MyRepo = { name: string; mainBranch: string | null; addedAt: string; projects: string[] };
export type { Stage, WorkItem };
export const MY_REPOS_CAP = 25;
export type PrRow = { repo: string; id: number; title: string; state: string; author: string | null; source: string; destination: string; updated: string | null };
export type Pr = PrRow & { description: string; url: string | null; reviewers: { name: string; uuid: string | null; approved: boolean }[]; comments: number; tasks: number; created: string | null };
export type PrFile = { status: string; path: string; oldPath: string | null; added: number; removed: number };
export type PrComment = { id: number; author: string | null; text: string; path: string | null; line: number | null; created: string | null };
export type ReviewRequest = PrRow & { reviewers: Pr['reviewers']; approvedByMe: boolean; why: ('reviewer' | 'mentioned')[]; comments: number; url: string | null };
export type { FixQueue };

export type JiraIssue = JiraRow & {
  issueType: string | null;
  description: string | null;
  labels: string[];
  reporter: string | null;
  parent: string | null;
  created: string | null;
  url: string | null;
};
export type JiraRow = { key: string; summary: string; status: string | null; assignee: string | null; priority: string | null; updated: string | null; dev: JiraDev | null };

export const api = {
  myActivity: (days: number) => call<{ items: ActivityItem[] }>(`/api/activity/me?days=${days}`),
  team: (days: number) => call<{ configured: boolean; me?: string; members?: TeamMember[] }>(`/api/team?days=${days}`),
  integrations: () => call<{ integrations: Integration[] }>('/api/workbench/integrations'),
  connect: (integration: string) => call<{ url: string | null; connectionId: string | null }>('/api/workbench/connect', { method: 'POST', body: JSON.stringify({ integration }) }),
  jiraIssues: (filter: string, pageToken?: string) =>
    call<{ issues: JiraRow[]; nextPageToken: string | null }>(`/api/jira/issues?filter=${filter}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`),
  me: () => call<Me>('/auth/me'),
  createUser: (name: string, pin: string) => call<{ ok: true }>('/auth/users', { method: 'POST', body: JSON.stringify({ name, pin }) }),
  login: (name: string, pin: string) => call<{ ok: true }>('/auth/login', { method: 'POST', body: JSON.stringify({ name, pin }) }),
  workbenchSignIn: (attempt: string) => call<{ url: string }>('/auth/workbench', { method: 'POST', body: JSON.stringify({ attempt }) }),
  claim: (attempt: string) => call<{ ok: boolean }>(`/auth/claim?attempt=${attempt}`),
  connections: () => call<{ connections: Connection[] }>('/api/connections'),
  addConnection: (c: NewConnection) => call<Connection>('/api/connections', { method: 'POST', body: JSON.stringify(c) }),
  removeConnection: (name: string) => call<{ ok: true }>(`/api/connections/${name}`, { method: 'DELETE' }),
  connectConnection: (name: string) => call<{ url: string }>(`/api/connections/${name}/connect`, { method: 'POST' }),
  disconnectConnection: (name: string) => call<{ ok: true }>(`/api/connections/${name}/disconnect`, { method: 'POST' }),
  logout: () => call<{ ok: true }>('/auth/logout', { method: 'POST' }),
  sessions: () => call<SessionSummary[]>('/api/sessions'),
  session: (id: string) => call<SessionDetail>(`/api/sessions/${id}`),
  run: (id: string) => call<Run>(`/api/runs/${id}`),
  models: () => call<ModelOption[]>('/api/models'),
  jiraIssue: (key: string) => call<JiraIssue>(`/api/jira/issues/${key}`),
  findPrs: (ticket: string) => call<{ prs: PrRow[]; searched: string[] }>(`/api/prs?ticket=${ticket}`),
  pr: (repo: string, id: number) => call<{ pr: Pr; files: PrFile[]; comments: PrComment[] }>(`/api/prs/${repo}/${id}`),
  prDiff: (repo: string, id: number) => call<{ diff: string; truncated: boolean }>(`/api/prs/${repo}/${id}/diff`),
  comment: (repo: string, id: number, text: string, replyTo?: number) =>
    call<{ id: number }>(`/api/prs/${repo}/${id}/comments`, { method: 'POST', body: JSON.stringify({ text, replyTo }) }),
  fixQueue: (repo: string, id: number) => call<{ queue: FixQueue | null }>(`/api/prs/${repo}/${id}/fixes`),
  startFixes: (repo: string, id: number, commentIds: number[]) => call<FixQueue>(`/api/prs/${repo}/${id}/fixes`, { method: 'POST', body: JSON.stringify({ commentIds }) }),
  fixAction: (queue: string, commentId: number, action: 'approve' | 'skip' | 'retry', note?: string) =>
    call<FixQueue>(`/api/fixes/${queue}/items/${commentId}/${action}`, { method: 'POST', body: JSON.stringify({ note }) }),
  cancelFixes: (queue: string) => call<FixQueue>(`/api/fixes/${queue}/cancel`, { method: 'POST' }),
  reviews: (refresh = false) =>
    call<{ me: string; matchedById: boolean; items: ReviewRequest[]; failed: string[]; searched: string[]; scanned: number; at: string }>(
      `/api/reviews?as=${encodeURIComponent(storage('lf:bb-name') ?? '')}${refresh ? '&refresh=1' : ''}`,
    ),
  myRepos: () => call<{ repos: MyRepo[] }>('/api/my-repos'),
  addMyRepo: (repo: string) => call<MyRepo>('/api/my-repos', { method: 'POST', body: JSON.stringify({ repo }) }),
  removeMyRepo: (repo: string) => call<unknown>(`/api/my-repos/${repo}`, { method: 'DELETE' }),
  repoProjects: (repo: string, projects: string[]) => call<MyRepo>(`/api/my-repos/${repo}`, { method: 'PATCH', body: JSON.stringify({ projects }) }),
  workItems: () => call<{ items: WorkItem[] }>('/api/work-items'),
  linkPr: (ticket: string, repo: string, prId: number, kind: 'spec' | 'impl') => call<WorkItem>(`/api/work-items/${ticket}/links`, { method: 'POST', body: JSON.stringify({ repo, prId, kind }) }),
  setWorkItemRepos: (ticket: string, repos: string[]) => call<WorkItem>(`/api/work-items/${ticket}`, { method: 'PUT', body: JSON.stringify({ repos }) }),
  repos: (workspace?: string) => call<{ workspace: string; repos: RepoRow[] }>(`/api/repos${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`),
  start: (b: { kind: RunKind; cwd?: string; repo?: string; branch?: string; prompt: string; permissionMode: PermissionMode; resume?: string; model?: string; ticket?: string; stage?: Stage; share?: ShareLevel }) =>
    call<Run>('/api/runs', { method: 'POST', body: JSON.stringify(b) }),
  send: (id: string, text: string) => call<{ ok: true }>(`/api/runs/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),
  setModel: (id: string, model: string) => call<{ ok: true }>(`/api/runs/${id}/model`, { method: 'POST', body: JSON.stringify({ model }) }),
  interrupt: (id: string) => call<{ ok: true }>(`/api/runs/${id}/interrupt`, { method: 'POST' }),
  end: (id: string) => call<{ ok: true }>(`/api/runs/${id}/end`, { method: 'POST' }),
  resumeTask: (id: string, text?: string) => call<{ ok: true }>(`/api/runs/${id}/resume-task`, { method: 'POST', body: JSON.stringify({ text }) }),
  discuss: (id: string, text: string) => call<{ runId: string }>(`/api/decisions/${id}/discuss`, { method: 'POST', body: JSON.stringify({ text }) }),
  decide: (id: string, a: DecisionAnswer) => call<{ ok: true }>(`/api/decisions/${id}`, { method: 'POST', body: JSON.stringify(a) }),
};

// Live state from SSE. A snapshot on every (re)connect replaces local state, so reconnects never duplicate or keep stale prompts.
export type Conn = 'connecting' | 'connected' | 'reconnecting';
type State = { conn: Conn; runs: Map<string, Run>; decisions: Map<string, PendingDecision> };

let state: State = { conn: 'connecting', runs: new Map(), decisions: new Map() };
const listeners = new Set<() => void>();
const set = (s: State) => {
  state = s;
  listeners.forEach((l) => l());
};

function apply(m: StreamMessage) {
  const runs = new Map(state.runs);
  const decisions = new Map(state.decisions);
  switch (m.type) {
    case 'snapshot':
      return set({ conn: 'connected', runs: new Map(m.runs.map((r) => [r.id, r])), decisions: new Map(m.decisions.map((d) => [d.id, d])) });
    case 'run': {
      const prev = runs.get(m.run.id);
      runs.set(m.run.id, { ...m.run, events: prev?.events ?? [] });
      break;
    }
    case 'run_event': {
      const r = runs.get(m.runId);
      if (r && !r.events.some((e) => e.id === m.event.id)) runs.set(r.id, { ...r, events: [...r.events, m.event], lastEventAt: m.event.at });
      break;
    }
    case 'decision':
      decisions.set(m.decision.id, m.decision);
      break;
    case 'decision_closed':
      decisions.delete(m.id);
      break;
  }
  set({ ...state, runs, decisions });
}

let es: EventSource | null = null;
function connect() {
  if (es) return;
  es = new EventSource('/api/stream');
  es.onmessage = (e) => apply(JSON.parse(e.data));
  es.onerror = () => {
    set({ ...state, conn: 'reconnecting' });
    // EventSource can't see status codes; ask whether we're still signed in
    fetch('/api/settings').then((r) => r.status === 401 && signedOutListeners.forEach((f) => f()), () => {});
  };
}

export function useLive(): State {
  useEffect(connect, []);
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
}

export function useFetch<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    fn().then(
      (d) => alive && (setData(d), setError(null)),
      (e) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function ago(iso: string | null, now: number): string {
  if (!iso) return 'unknown';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export const projectName = (cwd: string | null) => (cwd ? cwd.split('/').filter(Boolean).pop() ?? cwd : 'unknown project');

export function storage(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export type Theme = 'system' | 'light' | 'dark';

export function applyTheme(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
