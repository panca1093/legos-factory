import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ActivityItem, DecisionAnswer, ModelOption, TeamMember, PendingDecision, PermissionMode, Run, RunKind, SessionDetail, SessionSummary, Settings, ShareLevel, StreamMessage } from '../shared/types.ts';

export type Me = { authEnabled: boolean; authenticated: boolean; ssoName: string; workbenchUrl: string | null; user: { sub: string | null; name: string | null; email: string | null } | null };

// Any 401 means the session ended (logout elsewhere, refresh failed): show the sign-in screen.
const signedOutListeners = new Set<() => void>();
export const onSignedOut = (f: () => void) => (signedOutListeners.add(f), () => void signedOutListeners.delete(f));

// Sign-in may open in another browser (desktop panes hand links to the system browser), so this
// window polls with a one-time id and receives its own session cookie once login finishes anywhere.
export function signIn(onDone: () => void): () => void {
  const attempt = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
  window.open(`/auth/login?attempt=${attempt}&returnTo=${encodeURIComponent(location.href)}`, '_blank');
  const started = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - started > 10 * 60_000) return clearInterval(timer);
    const r = await fetch('/auth/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'x-legos': '1' }, body: JSON.stringify({ attempt }) }).catch(() => null);
    if (r?.ok && (await r.json()).done) {
      clearInterval(timer);
      onDone();
    }
  }, 1500);
  return () => clearInterval(timer);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', 'x-legos': '1', ...init?.headers } });
  if (res.status === 401 && path.startsWith('/api/')) signedOutListeners.forEach((f) => f());
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body as T;
}

export type Integration = { name: string; version: string | null; connected: boolean };
export type JiraRow = { key: string; summary: string; status: string | null; assignee: string | null; priority: string | null; updated: string | null };
export type JiraIssue = JiraRow & { issueType: string | null; description: string | null; labels: string[]; url: string | null };

export const api = {
  myActivity: (days: number) => call<{ items: ActivityItem[] }>(`/api/activity/me?days=${days}`),
  team: (days: number) => call<{ configured: boolean; me?: string; members?: TeamMember[] }>(`/api/team?days=${days}`),
  integrations: () => call<{ integrations: Integration[] }>('/api/workbench/integrations'),
  connect: (integration: string) => call<{ url: string | null; connectionId: string | null }>('/api/workbench/connect', { method: 'POST', body: JSON.stringify({ integration }) }),
  jiraIssues: (filter: string, pageToken?: string) =>
    call<{ issues: JiraRow[]; nextPageToken: string | null }>(`/api/jira/issues?filter=${filter}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`),
  jiraIssue: (key: string) => call<JiraIssue>(`/api/jira/issues/${key}`),
  me: () => call<Me>('/auth/me'),
  logout: () => call<{ ok: true }>('/auth/logout', { method: 'POST' }),
  sessions: () => call<SessionSummary[]>('/api/sessions'),
  session: (id: string) => call<SessionDetail>(`/api/sessions/${id}`),
  run: (id: string) => call<Run>(`/api/runs/${id}`),
  models: () => call<ModelOption[]>('/api/models'),
  settings: () => call<Settings & { path: string; error: string | null }>('/api/settings'),
  policy: (cwd: string) => call<{ share: ShareLevel; branch: string | null; ticket: string | null }>(`/api/policy?cwd=${encodeURIComponent(cwd)}`),
  start: (b: { kind: RunKind; cwd: string; prompt: string; permissionMode: PermissionMode; resume?: string; model?: string; ticket?: string; share?: ShareLevel }) =>
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
