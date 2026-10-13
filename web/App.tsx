import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Run, RunKind, SessionSummary, TeamItem } from '../shared/types.ts';
import { api, ago, fmtTokens, onSignedOut, projectName, storage, useFetch, useLive, useNow, type Conn, type Connection, type Integration, type JiraRow, type Me } from './api.ts';
import {
  ApprovalCard,
  ConnChip,
  DecisionRow,
  Empty,
  LaunchDialog,
  ModelSelect,
  ReviewModal,
  ShareBadge,
  TicketChip,
  StatusPill,
  ThemeSwitch,
  Thread,
  UsageRows,
  go,
  runLabel,
  runTone,
  totalTokens,
} from './components.tsx';
import { Icon } from './icons.tsx';

const ALIVE: Run['status'][] = ['starting', 'running', 'awaiting_decision', 'idle'];
const RECENT_MS = 5 * 60 * 1000;
const ORDER: Run['status'][] = ['awaiting_decision', 'running', 'starting', 'idle', 'failed', 'completed'];

type Live = ReturnType<typeof useLive>;
type ResumeReq = { sessionId: string; cwd: string; recentlyActive: boolean };
type LaunchReq = { kind: RunKind; resume?: ResumeReq; defaults?: { cwd?: string; prompt?: string; ticket?: string } };

function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

// Topbar controls shared by every page frame.
const Chrome = createContext<{ conn: Conn; openRail: () => void; inspector: boolean; toggleInspector: () => void; review: (decisionId: string) => void; me: Me }>(null!);
const useReview = () => useContext(Chrome).review;

function openSearch() {
  go('#/sessions');
  setTimeout(() => document.getElementById('session-search')?.focus(), 50);
}

function Frame({ crumb, inspector, children }: { crumb: ReactNode; inspector?: ReactNode; children: ReactNode }) {
  const c = useContext(Chrome);
  return (
    <>
      <section className="workspace">
        <header className="topbar">
          <button className="icon menu-btn" aria-label="Open navigation" onClick={c.openRail}>
            <Icon name="menu" />
          </button>
          <div className="crumb">{crumb}</div>
          <span className="chip hide-sm">
            <span className="avatar" style={{ width: 18, height: 18, borderRadius: 6, fontSize: 10 }}>
              C
            </span>
            Claude Code
          </span>
          <ConnChip conn={c.conn} />
          <button className="search" onClick={openSearch} aria-label="Search sessions">
            <Icon name="search" size={15} />
            <span>Search sessions…</span>
            <kbd>⌘ K</kbd>
          </button>
          {c.me.authEnabled && <UserMenu me={c.me} />}
          {inspector && (
            <button className={`icon ${c.inspector ? 'on' : ''}`} aria-label="Toggle context panel" aria-pressed={c.inspector} onClick={c.toggleInspector}>
              <Icon name="panel" />
            </button>
          )}
        </header>
        {children}
      </section>
      {inspector && (
        <aside className="inspector">
          <button className="icon inspector-close" aria-label="Close context panel" onClick={c.toggleInspector}>
            <Icon name="close" size={15} />
          </button>
          {inspector}
        </aside>
      )}
    </>
  );
}

// Unlocks with the local PIN before anything else loads; the API and live stream need a session.
export function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = () => api.me().then((m) => (setMe(m), setError(null)), (e) => setError(e.message));
  useEffect(() => {
    check();
    return onSignedOut(() => setMe((m) => (m ? { ...m, authenticated: false, user: null } : m)));
  }, []);
  if (error) return <PinGate setup={false} error={`Can't reach legos-factory: ${error}`} onDone={check} />;
  if (!me) return null;
  if (me.authEnabled && !me.authenticated) return <PinGate setup={me.setupRequired} onDone={check} />;
  return <App me={me} />;
}

function PinGate({ setup, error, onDone }: { setup: boolean; error?: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (setup && pin !== pin2) return setErr("PINs don't match");
    setBusy(true);
    setErr(null);
    try {
      await (setup ? api.setup(name.trim(), pin) : api.login(pin));
      onDone();
    } catch (e: any) {
      setErr(e.message);
      setPin('');
      setPin2('');
    } finally {
      setBusy(false);
    }
  };
  const ready = pin.length === 6 && (!setup || (name.trim() && pin2.length === 6));
  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <span className="mark">L</span>
        <h1>
          legos<span> / factory</span>
        </h1>
        <p className="lead">{setup ? 'Create your local account to get started.' : 'Mission control for your coding agents.'}</p>
        {error ? (
          <button type="button" className="btn primary signin-btn" onClick={onDone}>
            Try again
          </button>
        ) : (
          <>
            {setup && (
              <label className="field signin-field">
                Your name
                <input className="input" autoFocus value={name} maxLength={64} autoComplete="name" onChange={(e) => setName(e.target.value)} />
              </label>
            )}
            <label className="field signin-field">
              {setup ? 'Choose a 6-digit PIN' : 'PIN'}
              <input
                className="input pin-input"
                type="password"
                inputMode="numeric"
                autoComplete={setup ? 'new-password' : 'current-password'}
                autoFocus={!setup}
                value={pin}
                onChange={(e) => setPin(digits(e.target.value))}
              />
            </label>
            {setup && (
              <label className="field signin-field">
                Repeat PIN
                <input className="input pin-input" type="password" inputMode="numeric" autoComplete="new-password" value={pin2} onChange={(e) => setPin2(digits(e.target.value))} />
              </label>
            )}
            <button className="btn primary signin-btn" disabled={!ready || busy}>
              {busy ? 'Checking…' : setup ? 'Create account' : 'Unlock'}
            </button>
            <p className="signin-note">
              {setup
                ? 'Stays on this machine. Connect workbench or other MCP servers later in Settings.'
                : 'Forgot it? Delete ~/.legos-factory/account.json and set up again — connections are kept.'}
            </p>
          </>
        )}
        {(err || error) && <p className="error">{err ?? error}</p>}
      </form>
    </div>
  );
}

function App({ me }: { me: Me }) {
  const route = useRoute();
  const live = useLive();
  const sessions = useFetch(api.sessions, []);
  const [launch, setLaunch] = useState<LaunchReq | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const reviewing = reviewId ? live.decisions.get(reviewId) : undefined;
  // overlay on narrow screens, so start it closed there
  const [inspector, setInspector] = useState(() => matchMedia('(min-width: 1181px)').matches);
  const projects = useMemo(() => [...new Set((sessions.data ?? []).map((s) => s.cwd).filter((c): c is string => !!c))], [sessions.data]);

  // Refresh observed sessions when a run changes state, so its transcript shows up.
  const runSig = [...live.runs.values()].map((r) => `${r.id}:${r.status}`).join();
  useEffect(() => {
    if (runSig) sessions.reload();
  }, [runSig]);

  useEffect(() => setRailOpen(false), [route.join('/')]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openSearch();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const [view, id] = route;
  const withInspector = (view === 'runs' && !!id) || (view === 'sessions' && !!id);
  const continueSession = (r: ResumeReq) => setLaunch({ kind: 'chat', resume: r });
  const newRun = (kind: RunKind, defaults?: LaunchReq['defaults']) => setLaunch({ kind, defaults });

  return (
    <Chrome.Provider value={{ conn: live.conn, openRail: () => setRailOpen(true), inspector, toggleInspector: () => setInspector(!inspector), review: setReviewId, me }}>
      <div className={`app ${withInspector && inspector ? 'with-inspector show-inspector' : ''}`}>
        <Rail live={live} view={view} id={id} open={railOpen} onNew={newRun} me={me} />
        {!view && <Overview live={live} sessions={sessions.data} error={sessions.error} onNew={newRun} onContinue={continueSession} />}
        {view === 'tasks' && <Tasks live={live} onNew={newRun} />}
        {view === 'settings' && <SettingsPage />}
        {view === 'activity' && <MyActivity live={live} />}
        {view === 'team' && <TeamActivity />}
        {view === 'sessions' && !id && <Sessions sessions={sessions.data} error={sessions.error} live={live} />}
        {view === 'sessions' && id && <SessionView id={id} live={live} onContinue={continueSession} />}
        {view === 'runs' && id && <RunView id={id} live={live} onContinue={continueSession} onNew={newRun} />}
      </div>
      {railOpen && <div className="scrim" style={{ background: 'rgba(10,12,24,.25)', zIndex: 54 }} onClick={() => setRailOpen(false)} />}
      {launch && <LaunchDialog projects={projects} {...launch} onClose={() => setLaunch(null)} />}
      {/* closes by itself once the request is answered anywhere */}
      {reviewing && <ReviewModal d={reviewing} run={live.runs.get(reviewing.runId)} conn={live.conn} onClose={() => setReviewId(null)} />}
    </Chrome.Provider>
  );
}

function Rail({ live, view, id, open, onNew, me }: { live: Live; view?: string; id?: string; open: boolean; onNew: (k: RunKind) => void; me: Me }) {
  const runs = [...live.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const chats = runs.filter((r) => r.kind === 'chat');
  const shown = [...chats.filter((r) => ALIVE.includes(r.status)), ...chats.filter((r) => !ALIVE.includes(r.status)).slice(0, 4)];
  const activeTasks = runs.filter((r) => r.kind === 'task' && ALIVE.includes(r.status)).length;
  const runView = view === 'runs' ? live.runs.get(id ?? '') : undefined;
  return (
    <nav className={`rail ${open ? 'open' : ''}`} aria-label="Main">
      <a className="rail-head" href="#/">
        <span className="mark">L</span>
        <span>
          <span className="brand">
            legos<span> / factory</span>
          </span>
          <span className="brand-sub" style={{ display: 'block' }}>
            Mission control
          </span>
        </span>
      </a>
      <div className="rail-scroll">
        <div className="new-row">
          <button className="btn" onClick={() => onNew('chat')}>
            <Icon name="chat" size={15} /> New chat
          </button>
          <button className="btn" onClick={() => onNew('task')}>
            <Icon name="spark" size={15} /> New task
          </button>
        </div>
        <div className="eyebrow">Workspace</div>
        <a className={`navrow ${!view ? 'active' : ''}`} href="#/">
          <Icon name="box" /> Overview
          {live.decisions.size > 0 && <span className="count">{live.decisions.size}</span>}
        </a>
        <a className={`navrow ${view === 'tasks' || runView?.kind === 'task' ? 'active' : ''}`} href="#/tasks">
          <Icon name="spark" /> Tasks
          {activeTasks > 0 && <span className="later">{activeTasks} running</span>}
        </a>
        <a className={`navrow ${view === 'sessions' ? 'active' : ''}`} href="#/sessions">
          <Icon name="clock" /> Sessions
        </a>
        <a className={`navrow ${view === 'settings' ? 'active' : ''}`} href="#/settings">
          <Icon name="settings" /> Settings
        </a>
        <div className="eyebrow">Chats</div>
        {shown.length === 0 && <p className="rail-empty">No chats yet.</p>}
        {shown.map((r) => (
          <a key={r.id} className={`sessrow ${view === 'runs' && id === r.id ? 'active' : ''}`} href={`#/runs/${r.id}`} title={`${runLabel(r)} · ${r.prompt}`}>
            <span className={`sdot ${runTone(r)}`} />
            <span className="t">{r.prompt.split('\n')[0]}</span>
          </a>
        ))}
      </div>
      <div className="rail-footer">
        <RuntimePicker />
        <ThemeSwitch />
      </div>
    </nav>
  );
}

function UserMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = me.user?.name ?? 'Local account';
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener('mousedown', close);
    addEventListener('keydown', close);
    return () => (removeEventListener('mousedown', close), removeEventListener('keydown', close));
  }, [open]);
  const item = (href: string, icon: Parameters<typeof Icon>[0]['name'], text: string) => (
    <a className="menu-item" href={href} role="menuitem" onClick={() => setOpen(false)}>
      <Icon name={icon} size={15} /> {text}
    </a>
  );
  return (
    <div className="user-menu" ref={ref}>
      <button className="avatar-btn" aria-label="Account menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {initials(label)}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <span className="avatar-btn static">{initials(label)}</span>
            <div style={{ minWidth: 0 }}>
              <b className="ellipsis">{label}</b>
              <small>Local account</small>
            </div>
          </div>
          <div className="menu-label">You</div>
          {item('#/activity', 'clock', 'My activity')}
          {item('#/settings', 'settings', 'Settings')}
          <div className="menu-label">Team</div>
          {item('#/team', 'box', 'Team activity')}
          <div className="menu-sep" />
          <button
            className="menu-item"
            role="menuitem"
            onClick={async () => {
              await api.logout().catch(() => undefined);
              location.reload();
            }}
          >
            <Icon name="close" size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

const initials = (s: string) =>
  s
    .split('@')[0]
    .split(/[.\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

// Which harness new chats and tasks run on. Only Claude Code has an adapter so far.
const RUNTIMES = [
  { id: 'claude-code', name: 'Claude Code', note: 'claude.ai account · this Mac', ready: true },
  { id: 'codex', name: 'Codex', note: 'coming later', ready: false },
  { id: 'hermes', name: 'Hermes', note: 'coming later', ready: false },
];

function RuntimePicker() {
  const [value, setValue] = useState('claude-code');
  const current = RUNTIMES.find((r) => r.id === value)!;
  return (
    <label className="runtime-picker">
      <span className="avatar">{current.name.charAt(0)}</span>
      <span className="runtime-copy">
        <small>Runtime</small>
        <b>{current.name}</b>
        <small>{current.note}</small>
      </span>
      <span className="sdot good" />
      <Icon name="chevron" size={14} />
      <select aria-label="Runtime" value={value} onChange={(e) => setValue(e.target.value)}>
        {RUNTIMES.map((r) => (
          <option key={r.id} value={r.id} disabled={!r.ready}>
            {r.name}
            {r.ready ? '' : ' — coming later'}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------- Overview ----------

function evidenceOf(r: Run, now: number) {
  const toolErrors = r.events.filter((e) => e.kind === 'tool_result' && e.isError).length;
  const errors = toolErrors + (r.error ? 1 : 0);
  return { errors, last: ago(ALIVE.includes(r.status) ? r.lastEventAt : r.endedAt, now) };
}

function calloutOf(r: Run, pending: number, now: number): { icon: 'check' | 'stop' | 'clock' | 'spark' | 'close'; title: string; text: string } {
  switch (r.status) {
    case 'awaiting_decision':
      return { icon: 'stop', title: 'Waiting for your approval', text: `${pending} open request${pending === 1 ? '' : 's'} · nothing runs until you answer` };
    case 'starting':
    case 'running':
      return { icon: 'spark', title: 'Working', text: `Last event ${ago(r.lastEventAt, now)} · turn ${r.turns}` };
    case 'idle':
      return { icon: 'check', title: 'Your turn', text: `Turn ${r.turns} finished ${ago(r.lastEventAt, now)} · reply to continue` };
    case 'failed':
      return { icon: 'close', title: r.kind === 'task' ? 'Task failed' : 'Run failed', text: r.error?.split('\n')[0] ?? 'Unknown error' };
    default:
      if (r.kind === 'task')
        return r.endedBy === 'user'
          ? { icon: 'close', title: 'Task cancelled', text: 'Stopped by you before it finished' }
          : { icon: 'check', title: 'Task done', text: r.result?.split('\n').find((l) => l.trim()) ?? 'Finished without a summary' };
      return { icon: 'clock', title: 'Session ended', text: r.endedBy === 'idle_timeout' ? 'Closed after 30 min idle · continue anytime' : 'Ended by you · continue anytime' };
  }
}

function Glance({ live }: { live: Live }) {
  const runs = [...live.runs.values()];
  const tabs = [
    { key: 'working', label: 'Working', n: runs.filter((r) => r.status === 'running' || r.status === 'starting').length, detail: 'Runs actively executing a turn' },
    { key: 'needs', label: 'Needs you', n: live.decisions.size, detail: 'Permission requests and questions waiting on you' },
    { key: 'turn', label: 'Your turn', n: runs.filter((r) => r.status === 'idle').length, detail: 'Sessions finished a turn and are waiting for a reply' },
  ];
  const [sel, setSel] = useState(1);
  return (
    <div className="glance">
      <div className="glance-head">
        <h2>Right now</h2>
        <span>{live.conn === 'connected' ? 'Live' : 'Reconnecting…'}</span>
      </div>
      <div className="glance-switch" role="tablist" aria-label="Run activity">
        <span className="glance-indicator" style={{ transform: `translateX(${sel * 100}%)` }} />
        {tabs.map((t, i) => (
          <button
            key={t.key}
            role="tab"
            className="glance-tab"
            aria-selected={sel === i}
            onClick={() => setSel(i)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') setSel((sel + 1) % 3);
              if (e.key === 'ArrowLeft') setSel((sel + 2) % 3);
            }}
          >
            {t.label} <b>{t.n}</b>
          </button>
        ))}
      </div>
      <div className="glance-detail">{tabs[sel].detail}</div>
    </div>
  );
}

function Overview({
  live,
  sessions,
  error,
  onNew,
  onContinue,
}: {
  live: Live;
  sessions: SessionSummary[] | null;
  error: string | null;
  onNew: (k: RunKind) => void;
  onContinue: (r: ResumeReq) => void;
}) {
  const now = useNow(10000);
  const review = useReview();
  const runs = [...live.runs.values()].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.lastEventAt.localeCompare(a.lastEventAt)).slice(0, 6);
  const decisions = [...live.decisions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const [selId, setSelId] = useState<string | null>(null);
  const selected = runs.find((r) => r.id === selId) ?? runs[0];
  const needs = runs.filter((r) => r.status === 'awaiting_decision').length;
  const yours = runs.filter((r) => r.status === 'idle').length;

  const all = sessions ?? [];
  const withUsage = all.filter((s) => s.usage);
  const tokens = withUsage.reduce((n, s) => n + totalTokens(s.usage)!, 0);
  const priced = [...live.runs.values()].filter((r) => r.estimatedCostUsd !== null);
  const cost = priced.reduce((n, r) => n + r.estimatedCostUsd!, 0);
  const last = all.find((s) => s.cwd && !s.activeRunId);

  return (
    <Frame
      crumb={
        <>
          <span>Workspace / </span>Overview
        </>
      }
    >
      <div className="scroll">
        <div className="page">
          <div className="page-heading">
            <div>
              <div className="page-eyebrow">
                Workspace / Overview <span className="badge">Live data</span>
              </div>
              <h1>Mission control</h1>
              <p className="lead">Pick a card to see what needs a closer look.</p>
            </div>
            <Glance live={live} />
          </div>

          <div className="sectionbar" style={{ marginTop: 0 }}>
            <h2>Runs</h2>
            <span className="meta">{runs.length ? `${needs} need you · ${yours} your turn` : 'Chats and tasks started here'}</span>
          </div>
          {!selected ? (
            <div className="empty">
              <p style={{ marginBottom: 12 }}>Nothing running. Start a chat to discuss, or hand off a task.</p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn primary" onClick={() => onNew('chat')}>
                  <Icon name="chat" size={15} /> New chat
                </button>
                <button className="btn" onClick={() => onNew('task')}>
                  <Icon name="spark" size={15} /> New task
                </button>
              </div>
            </div>
          ) : (
            <div className="monitor">
              <div>
                <div className="rail-headline">
                  Runs <b>{[...live.runs.values()].filter((r) => ALIVE.includes(r.status)).length} live</b>
                </div>
                <div className="cards" role="tablist" aria-label="Runs">
                  {runs.map((r) => {
                    const ev = evidenceOf(r, now);
                    return (
                      <button
                        key={r.id}
                        role="tab"
                        aria-selected={r.id === selected.id}
                        className={`run-tab ${runTone(r)}`}
                        onClick={() => setSelId(r.id)}
                        onDoubleClick={() => go(`#/runs/${r.id}`)}
                      >
                        <div className="card-head">
                          <div className="card-ident">
                            <span className="card-avatar">{projectName(r.cwd).charAt(0).toUpperCase()}</span>
                            <span className="card-name">{r.prompt.split('\n')[0]}</span>
                          </div>
                          <span className="card-state">{runLabel(r)}</span>
                        </div>
                        <div className="card-foot">
                          <span className="card-evidence">
                            {r.ticket && `${r.ticket} · `}
                            {r.kind === 'task' ? 'Task' : r.fromTask ? 'Chat · from task' : 'Chat'} · {projectName(r.cwd)} · {ev.last}
                            {ev.errors > 0 && ` · ${ev.errors} error${ev.errors > 1 ? 's' : ''}`}
                          </span>
                          <span className="card-arrow">
                            <Icon name="arrow" size={14} />
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <p className="cards-note">Select to inspect · double-click to open</p>
              </div>
              <RunDetail key={selected.id} run={selected} live={live} now={now} onContinue={onContinue} />
            </div>
          )}

          <details className="usage">
            <summary>
              <h2>Workspace usage</h2>
              <span className="meta">
                {all.length} sessions · {fmtTokens(tokens)} measured tokens <Icon name="chevron" size={15} />
              </span>
            </summary>
            <div className="kpis">
              <div className="kpi">
                <div className="label">Sessions</div>
                <strong>{all.length}</strong>
                <small>Most recent on this machine, terminal ones included</small>
              </div>
              <div className="kpi">
                <div className="label">Measured tokens</div>
                <strong>{fmtTokens(tokens)}</strong>
                <small>
                  {withUsage.length} of {all.length} sessions report usage · uncached + cache read/write + output
                </small>
              </div>
              <div className="kpi cost">
                <div className="label">Run cost (est.)</div>
                <strong>{priced.length ? `~$${cost.toFixed(2)}` : 'Unknown'}</strong>
                <small>API-equivalent estimate for {priced.length} run{priced.length === 1 ? '' : 's'} this server session · not an invoice</small>
              </div>
            </div>
          </details>

          <div className="two-col">
            <div>
              <div className="sectionbar">
                <h2>
                  Needs you <small>{decisions.length || ''}</small>
                </h2>
              </div>
              {decisions.length === 0 ? (
                <div className="empty">Nothing is waiting on you.</div>
              ) : (
                <div className="section-list">
                  {decisions.map((d) => (
                    <DecisionRow key={d.id} d={d} conn={live.conn} onReview={review} />
                  ))}
                </div>
              )}
              <div className="sectionbar">
                <h2>Recent sessions</h2>
                <a className="text-action" href="#/sessions">
                  All sessions →
                </a>
              </div>
              {error ? (
                <p className="error">Could not read sessions: {error}</p>
              ) : !sessions ? (
                <div className="empty">Reading ~/.claude/projects…</div>
              ) : (
                <div className="section-list">
                  {sessions.slice(0, 5).map((s) => (
                    <a key={s.id} className="row link" href={`#/sessions/${s.id}`}>
                      <div className="copy">
                        <b>{s.title}</b>
                        <span>
                          {s.ticket && <TicketChip ticket={s.ticket} />} {projectName(s.cwd)} · {s.turns} prompt{s.turns === 1 ? '' : 's'} · {ago(s.lastActivityAt, now)}
                        </span>
                      </div>
                      <span className="text-action">Open →</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="sectionbar">
                <h2>Quick actions</h2>
              </div>
              <div className="section-list">
                <div className="row">
                  <div className="copy">
                    <b>Start a chat</b>
                    <span>Discuss and work together in any repo</span>
                  </div>
                  <button className="text-action" onClick={() => onNew('chat')}>
                    New chat →
                  </button>
                </div>
                <div className="row">
                  <div className="copy">
                    <b>Hand off a task</b>
                    <span>Claude works until done and reports back</span>
                  </div>
                  <button className="text-action" onClick={() => onNew('task')}>
                    New task →
                  </button>
                </div>
                {last && (
                  <div className="row">
                    <div className="copy">
                      <b>Continue last session in chat</b>
                      <span>
                        {last.title} · {projectName(last.cwd)}
                      </span>
                    </div>
                    <button
                      className="text-action"
                      onClick={() => onContinue({ sessionId: last.id, cwd: last.cwd!, recentlyActive: !!last.lastActivityAt && now - Date.parse(last.lastActivityAt) < RECENT_MS })}
                    >
                      Continue →
                    </button>
                  </div>
                )}
                <div className="row">
                  <div className="copy">
                    <b>Search sessions</b>
                    <span>Find any Claude Code conversation on this Mac</span>
                  </div>
                  <button className="text-action" onClick={openSearch}>
                    Search →
                  </button>
                </div>
              </div>
            </div>
          </div>
          <p className="footnote">Statuses come from live runs and your local transcripts. Costs are Claude Code's own API-equivalent estimates.</p>
        </div>
      </div>
    </Frame>
  );
}

function RunDetail({ run, live, now, onContinue }: { run: Run; live: Live; now: number; onContinue: (r: ResumeReq) => void }) {
  const tone = runTone(run);
  const pending = [...live.decisions.values()].filter((d) => d.runId === run.id).length;
  const c = calloutOf(run, pending, now);
  const ev = evidenceOf(run, now);
  const alive = ALIVE.includes(run.status);
  const review = useReview();
  const firstPending = [...live.decisions.values()].find((d) => d.runId === run.id);
  const runClass = tone === 'good' ? 'good' : tone === 'alert' ? 'alert' : tone === 'watch' ? 'watch' : '';
  return (
    <div className={`detail-anim tone-box-${tone}`}>
      <div className="detail-head">
        <div style={{ minWidth: 0 }}>
          <div className="kicker">Inspecting · {run.kind}</div>
          <h3>{run.prompt.split('\n')[0]}</h3>
          <p className="mono">{run.cwd}</p>
          <div className="chips" style={{ marginTop: 6 }}>
            <TicketChip ticket={run.ticket} />
            <ShareBadge share={run.share} />
          </div>
        </div>
        <span className="pulse-word">{runLabel(run)}</span>
      </div>
      <div className="callout">
        <span className="ic">
          <Icon name={c.icon} size={15} />
        </span>
        <div>
          <b>{c.title}</b>
          <span>{c.text}</span>
        </div>
      </div>
      <div className="evidence">
        <div className="evidence-row">
          <span>Last event</span>
          <b className={tone === 'watch' ? 'watch' : ''}>{ev.last}</b>
        </div>
        <div className="evidence-row">
          <span>Run</span>
          <b className={runClass}>
            {runLabel(run)} · {run.turns} turn{run.turns === 1 ? '' : 's'}
          </b>
        </div>
        <div className="evidence-row">
          <span>Errors</span>
          <b className={ev.errors ? 'alert' : 'good'}>{ev.errors ? `${ev.errors} in this run` : '0 open'}</b>
        </div>
        <div className="evidence-row">
          <span>Model</span>
          <b>{run.model ?? `${run.requestedModel} · not reported yet`}</b>
        </div>
        <div className="evidence-row">
          <span>Cost</span>
          <b>{run.estimatedCostUsd === null ? 'Unknown until the first turn ends' : `~$${run.estimatedCostUsd.toFixed(2)} · API-equivalent est.`}</b>
        </div>
      </div>
      <div className="detail-foot">
        {firstPending && (
          <button className="btn sm primary" onClick={() => review(firstPending.id)}>
            Review request
          </button>
        )}
        <a className={`btn sm ${firstPending ? '' : 'primary'}`} href={`#/runs/${run.id}`}>
          {run.kind === 'task' ? 'Open task →' : 'Open chat →'}
        </a>
        {!alive && run.sessionId && (
          <button className="btn sm" onClick={() => onContinue({ sessionId: run.sessionId!, cwd: run.cwd, recentlyActive: false })}>
            {run.kind === 'task' ? 'Discuss in chat' : 'Continue'}
          </button>
        )}
        {run.sessionId && (
          <a className="text-action" href={`#/sessions/${run.sessionId}`}>
            Full transcript →
          </a>
        )}
      </div>
    </div>
  );
}

// ---------- Sessions ----------

function Sessions({ sessions, error, live }: { sessions: SessionSummary[] | null; error: string | null; live: Live }) {
  const now = useNow();
  const [q, setQ] = useState('');
  const [project, setProject] = useState('');
  const [filter, setFilter] = useState<'all' | 'live' | 'today'>('all');
  const projects = useMemo(() => [...new Set((sessions ?? []).map((s) => s.cwd ?? ''))].filter(Boolean).sort(), [sessions]);
  // live runs are fresher than the last sessions fetch
  const liveIds = new Set([...live.runs.values()].filter((r) => ALIVE.includes(r.status) && r.sessionId).map((r) => r.sessionId!));
  const filtered = (sessions ?? []).filter(
    (s) =>
      (!project || s.cwd === project) &&
      (!q || `${s.title} ${s.cwd} ${s.gitBranch}`.toLowerCase().includes(q.toLowerCase())) &&
      (filter === 'all' || (filter === 'live' ? liveIds.has(s.id) : !!s.lastActivityAt && now - Date.parse(s.lastActivityAt) < 86400000)),
  );
  return (
    <Frame
      crumb={
        <>
          <span>Workspace / </span>Sessions
        </>
      }
    >
      <div className="scroll">
        <div className="page">
          <div className="page-heading">
            <div>
              <h1>Sessions</h1>
              <p className="lead">Every Claude Code conversation on this Mac, including terminal ones. Read-only until you continue one.</p>
            </div>
          </div>
          <div className="tool-bar">
            <input id="session-search" className="input" placeholder="Search conversations…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="input" aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {projectName(p)}
                </option>
              ))}
            </select>
            <div className="segmented" role="tablist">
              {(['all', 'live', 'today'] as const).map((f) => (
                <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : f === 'live' ? 'Live' : 'Today'}
                </button>
              ))}
            </div>
          </div>
          {error ? (
            <p className="error">Could not read sessions: {error}</p>
          ) : !sessions ? (
            <div className="empty">Reading ~/.claude/projects…</div>
          ) : filtered.length === 0 ? (
            <div className="empty">No sessions match.</div>
          ) : (
            <div className="list-card">
              {filtered.map((s) => {
                const total = totalTokens(s.usage);
                const isLive = liveIds.has(s.id);
                return (
                  <a key={s.id} className="list-item" href={`#/sessions/${s.id}`}>
                    <span className={`glyph ${isLive ? 'run' : ''}`}>
                      <Icon name="chat" size={16} />
                    </span>
                    <div className="copy">
                      <b>{s.title}</b>
                      <span>
                        {s.ticket && <TicketChip ticket={s.ticket} />} {projectName(s.cwd)}
                        {s.gitBranch && ` · ${s.gitBranch}`} · {s.turns} prompt{s.turns === 1 ? '' : 's'} · {s.toolCalls} tool calls
                        {s.toolErrors > 0 && <span className="error"> · {s.toolErrors} errors</span>}
                      </span>
                    </div>
                    <div className="side">
                      <b>{isLive ? 'Live run' : ago(s.lastActivityAt, now)}</b>
                      <ShareBadge share={s.share} />{' '}
                      {total === null ? 'tokens unknown' : `${fmtTokens(total)} tokens`}
                    </div>
                  </a>
                );
              })}
            </div>
          )}
          <p className="footnote">Sessions are read from ~/.claude/projects. Titles come from /rename or the first prompt.</p>
        </div>
      </div>
    </Frame>
  );
}

// ---------- chat views ----------

// Keeps the thread pinned to the bottom while new events arrive, unless the user scrolled up.
function useStickyScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  return { ref, onScroll };
}

function SessionView({ id, live, onContinue }: { id: string; live: Live; onContinue: (r: ResumeReq) => void }) {
  const now = useNow();
  const { data: s, error } = useFetch(() => api.session(id), [id]);
  const scroll = useStickyScroll(s?.events.length);
  if (error || !s) {
    return (
      <Frame
        crumb={
          <>
            <span>Sessions / </span>
            {error ? 'Not found' : 'Loading…'}
          </>
        }
      >
        <div className="page">{error ? <p className="error">{error}</p> : <Empty>Loading session…</Empty>}</div>
      </Frame>
    );
  }
  const activeRun = [...live.runs.values()].find((r) => r.sessionId === s.id && ALIVE.includes(r.status));
  const recentlyActive = !!s.lastActivityAt && now - Date.parse(s.lastActivityAt) < RECENT_MS;
  const cont = () => s.cwd && onContinue({ sessionId: s.id, cwd: s.cwd, recentlyActive });

  const inspector = (
    <>
      <div className="inspect-head">
        <h3>Context</h3>
        <span className="badge">Transcript</span>
      </div>
      <section>
        <div className="section-title">Session</div>
        <div className="inspect-item">
          Project <b>{projectName(s.cwd)}</b>
        </div>
        <div className="inspect-item">
          Ticket <b>{s.ticket ? <TicketChip ticket={s.ticket} /> : 'None'}</b>
        </div>
        <div className="inspect-item">
          Team sharing <ShareBadge share={s.share} />
        </div>
        {s.gitBranch && (
          <div className="inspect-item">
            Branch <b>{s.gitBranch}</b>
          </div>
        )}
        <div className="inspect-item">
          Last activity <b>{ago(s.lastActivityAt, now)}</b>
        </div>
        <div className="inspect-item">
          Started <b>{s.startedAt ? new Date(s.startedAt).toLocaleDateString() : 'unknown'}</b>
        </div>
        <div className="inspect-item">
          Models <b>{s.models.length ? s.models.join(', ') : 'unknown'}</b>
        </div>
        <div className="inspect-item">
          Tool calls{' '}
          <b>
            {s.toolCalls}
            {s.toolErrors ? ` · ${s.toolErrors} errors` : ''}
          </b>
        </div>
      </section>
      <section>
        <div className="section-title">Working directory</div>
        <p className="inspect-path">{s.cwd ?? 'unknown'}</p>
      </section>
      <section>
        <div className="section-title">Token usage</div>
        <UsageRows usage={s.usage} subagents={s.subagents} />
      </section>
      <section>
        <div className="section-title">Quick actions</div>
        {activeRun ? (
          <a className="inspect-action" href={`#/runs/${activeRun.id}`}>
            <Icon name="arrow" size={14} /> Open live run
          </a>
        ) : (
          <button className="inspect-action" disabled={!s.cwd} onClick={cont}>
            <Icon name="chat" size={14} /> Continue session
          </button>
        )}
        <button className="inspect-action" onClick={() => navigator.clipboard?.writeText(s.id)}>
          <Icon name="box" size={14} /> Copy session id
        </button>
      </section>
    </>
  );

  return (
    <Frame
      crumb={
        <>
          <span>Sessions / </span>
          {s.title}
        </>
      }
      inspector={inspector}
    >
      <div className="chat">
        <div className="thread" ref={scroll.ref} onScroll={scroll.onScroll}>
          <Thread events={s.events} title={<>Transcript · {projectName(s.cwd)} · {s.startedAt ? new Date(s.startedAt).toLocaleString() : ''}</>} />
        </div>
        <div className="ended-bar">
          <Icon name="clock" size={16} />
          <span className="grow">{activeRun ? 'This session has a live run.' : 'Read-only transcript. Continue it to keep working in this conversation.'}</span>
          {activeRun ? (
            <a className="btn sm primary" href={`#/runs/${activeRun.id}`}>
              Open live run →
            </a>
          ) : (
            <button className="btn sm primary" disabled={!s.cwd} onClick={cont}>
              Continue session
            </button>
          )}
        </div>
      </div>
    </Frame>
  );
}

function RunView({
  id,
  live,
  onContinue,
  onNew,
}: {
  id: string;
  live: Live;
  onContinue: (r: ResumeReq) => void;
  onNew: (k: RunKind, defaults?: LaunchReq['defaults']) => void;
}) {
  const now = useNow(5000);
  const review = useReview();
  const fetched = useFetch(() => api.run(id), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Prefer live state; fall back to fetched (e.g. after a hard refresh before the snapshot lands).
  const run = live.runs.get(id) ?? fetched.data;
  const pending = [...live.decisions.values()].filter((d) => d.runId === id);
  const scroll = useStickyScroll(`${run?.events.length}:${pending.length}:${run?.status}`);

  if (!run) {
    return (
      <Frame
        crumb={
          <>
            <span>Runs / </span>Unknown
          </>
        }
      >
        <div className="page">
          {fetched.error ? (
            <Empty>This run isn't known to the server — runs live in memory and are cleared on restart. Its transcript is still under Sessions.</Empty>
          ) : (
            <Empty>Loading run…</Empty>
          )}
        </div>
      </Frame>
    );
  }
  const alive = ALIVE.includes(run.status);
  const working = alive && run.status !== 'idle';
  const paused = live.conn !== 'connected';
  const toolCalls = run.events.filter((e) => e.kind === 'tool_use').length;
  const toolErrors = run.events.filter((e) => e.kind === 'tool_result' && e.isError).length;

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  const cont = () => run.sessionId && onContinue({ sessionId: run.sessionId, cwd: run.cwd, recentlyActive: false });
  const isTask = run.kind === 'task';
  const runAgain = () => onNew('task', { cwd: run.cwd, prompt: run.prompt });
  const modeLabel = run.permissionMode === 'default' ? 'Ask before tools' : run.permissionMode === 'acceptEdits' ? 'Auto-accept edits' : 'Plan only';

  const inspector = (
    <>
      <div className="inspect-head">
        <h3>Context</h3>
        <StatusPill run={run} />
      </div>
      <section>
        <div className="section-title">Current session</div>
        <div className="inspect-item">
          Runtime <b>Claude Code</b>
        </div>
        <div className="inspect-item">
          Mode <b>{isTask ? 'Task' : run.fromTask ? 'Chat · from task' : 'Chat'}</b>
        </div>
        <div className="inspect-item">
          Ticket <b>{run.ticket ? <TicketChip ticket={run.ticket} /> : 'None'}</b>
        </div>
        <div className="inspect-item">
          Team sharing <ShareBadge share={run.share} />
        </div>
        <div className="inspect-item">
          Model <b>{run.model ?? run.requestedModel}</b>
        </div>
        <div className="inspect-item">
          Turns <b>{run.turns}</b>
        </div>
        <div className="inspect-item">
          {alive ? 'Last event' : 'Ended'}{' '}
          <b>
            {ago(alive ? run.lastEventAt : run.endedAt, now)}
            {run.endedBy === 'idle_timeout' ? ' · idle' : ''}
          </b>
        </div>
        <div className="inspect-item" title="Claude Code's API-equivalent estimate. Not an invoice; subscription usage may be included in your plan.">
          Cost <b>{run.estimatedCostUsd === null ? 'Unknown yet' : `~$${run.estimatedCostUsd.toFixed(2)} est.`}</b>
        </div>
        <div className="inspect-item">
          Permissions <b>{modeLabel}</b>
        </div>
      </section>
      <section>
        <div className="section-title">Working directory</div>
        <p className="inspect-path">{run.cwd}</p>
      </section>
      <section>
        <div className="section-title">In this thread</div>
        <div className="inspect-item">
          Tool calls <b>{toolCalls}</b>
        </div>
        <div className="inspect-item">
          Tool errors <b className={toolErrors ? 'error' : ''}>{toolErrors}</b>
        </div>
        <div className="inspect-item">
          Waiting on you <b>{pending.length}</b>
        </div>
      </section>
      <section>
        <div className="section-title">Quick actions</div>
        {isTask ? (
          alive ? (
            <button className="inspect-action danger" disabled={!!busy || paused} onClick={() => act('end', () => api.end(id))}>
              <Icon name="close" size={14} /> Cancel task
            </button>
          ) : (
            <>
              <button className="inspect-action" disabled={!run.sessionId} onClick={cont}>
                <Icon name="chat" size={14} /> Discuss in chat
              </button>
              <button className="inspect-action" onClick={runAgain}>
                <Icon name="spark" size={14} /> Run again
              </button>
            </>
          )
        ) : alive ? (
          <>
            <button className="inspect-action" disabled={!working || !!busy || paused} onClick={() => act('interrupt', () => api.interrupt(id))}>
              <Icon name="stop" size={14} /> Stop current turn
            </button>
            <button className="inspect-action danger" disabled={!!busy || paused} onClick={() => act('end', () => api.end(id))}>
              <Icon name="close" size={14} /> End session
            </button>
          </>
        ) : (
          <button className="inspect-action" disabled={!run.sessionId} onClick={cont}>
            <Icon name="chat" size={14} /> Continue session
          </button>
        )}
        {run.sessionId && (
          <a className="inspect-action" href={`#/sessions/${run.sessionId}`}>
            <Icon name="clock" size={14} /> Full transcript
          </a>
        )}
      </section>
    </>
  );

  return (
    <Frame
      crumb={
        <>
          <span>{isTask || run.fromTask ? 'Tasks / ' : 'Chats / '}</span>
          {run.prompt.split('\n')[0]}
        </>
      }
      inspector={inspector}
    >
      <div className="chat">
        <div className="thread" ref={scroll.ref} onScroll={scroll.onScroll}>
          <Thread
            events={run.events}
            working={working && pending.length === 0}
            waiting={pending.length > 0}
            title={
              <>
                {projectName(run.cwd)} · started {new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {run.resumedFrom ? ' · continued session' : ''}
              </>
            }
          >
            {pending.map((d) => (
              <div key={d.id} className="message">
                <span className="mark sm">L</span>
                <div className="assistant-body">
                  <ApprovalCard d={d} conn={live.conn} onReview={review} />
                </div>
              </div>
            ))}
            {run.error && !isTask && <p className="sys-line error">Last turn failed: {run.error}</p>}
          </Thread>
        </div>
        {isTask ? (
          <TaskBar run={run} busy={!!busy} paused={paused} err={err} onCancel={() => act('end', () => api.end(id))} onDiscuss={cont} onRunAgain={runAgain} />
        ) : alive ? (
          <Composer
            key={id}
            initialModel={run.requestedModel}
            working={working}
            paused={paused}
            busy={busy}
            err={err}
            onSend={(text) => act('send', () => api.send(id, text))}
            onInterrupt={() => act('interrupt', () => api.interrupt(id))}
            onModel={(m) => act('model', () => api.setModel(id, m))}
            onResumeTask={run.fromTask ? (text) => act('resume', () => api.resumeTask(id, text)) : undefined}
          />
        ) : (
          <div className="ended-bar">
            <Icon name="clock" size={16} />
            <span className="grow">
              {run.status === 'failed' ? 'This run failed.' : run.endedBy === 'idle_timeout' ? 'Session closed after 30 min idle.' : 'Session ended.'} Continue it to pick up where it left off.
            </span>
            <button className="btn sm primary" disabled={!run.sessionId} onClick={cont}>
              Continue session
            </button>
          </div>
        )}
      </div>
    </Frame>
  );
}

function Composer({
  initialModel,
  working,
  paused,
  busy,
  err,
  onSend,
  onInterrupt,
  onModel,
  onResumeTask,
}: {
  onResumeTask?: (text: string) => Promise<void>;
  initialModel: string;
  working: boolean;
  paused: boolean;
  busy: string | null;
  err: string | null;
  onSend: (text: string) => Promise<void>;
  onInterrupt: () => void;
  onModel: (m: string) => void;
}) {
  const [text, setText] = useState('');
  const [model, setModel] = useState(initialModel);
  const send = async () => {
    if (!text.trim() || paused) return;
    const t = text;
    setText('');
    await onSend(t);
  };
  return (
    <div className="composer-wrap">
      {onResumeTask && (
        <div className="resume-bar">
          <Icon name="spark" size={15} />
          <span className="grow">This chat started as a task. Done discussing? Hand it back and it runs to completion.</span>
          <button
            className="btn sm primary"
            disabled={working || paused || !!busy}
            title={working ? 'Wait for Claude to finish this turn' : 'Optional: type an instruction first, it goes along'}
            onClick={async () => {
              const t = text;
              setText('');
              await onResumeTask(t);
            }}
          >
            Continue task{text.trim() ? ' with this note' : ''}
          </button>
        </div>
      )}
      <div className="composer">
        <textarea
          aria-label="Message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && send()}
          placeholder={working ? 'Claude is working — a message now is queued for after this step' : 'Reply to Claude…'}
        />
        <div className="composer-bottom">
          <ModelSelect
            chip
            value={model}
            disabled={paused}
            onChange={(m) => {
              setModel(m);
              onModel(m);
            }}
          />
          <span className="composer-hint">{err ? <span className="error">{err}</span> : paused ? 'Reconnecting… sending paused' : 'Model change applies next turn'}</span>
          {working && (
            <button className="stop" style={{ marginLeft: 'auto' }} aria-label="Stop current turn" title="Stop current turn" disabled={!!busy || paused} onClick={onInterrupt}>
              <Icon name="stop" size={15} />
            </button>
          )}
          <button className="send" style={working ? { marginLeft: 0 } : undefined} aria-label="Send" title="Send (⌘↵)" disabled={!text.trim() || paused || busy === 'send'} onClick={send}>
            <Icon name="send" size={16} />
          </button>
        </div>
      </div>
      <p className="composer-meta">Interactive Claude Code session · ⌘↵ to send · closes after 30 min idle</p>
    </div>
  );
}

function TaskBar({
  run,
  busy,
  paused,
  err,
  onCancel,
  onDiscuss,
  onRunAgain,
}: {
  run: Run;
  busy: boolean;
  paused: boolean;
  err: string | null;
  onCancel: () => void;
  onDiscuss: () => void;
  onRunAgain: () => void;
}) {
  const now = useNow(5000);
  const tone = runTone(run);
  if (ALIVE.includes(run.status)) {
    return (
      <div className="ended-bar">
        <span className="pulse" />
        <span className="grow">
          {run.status === 'awaiting_decision' ? 'Task is waiting for your approval above.' : `Claude is working on this task · last event ${ago(run.lastEventAt, now)}.`} The result will appear here.
          {err && <span className="error"> {err}</span>}
        </span>
        <button className="btn sm danger" disabled={busy || paused} onClick={onCancel}>
          Cancel task
        </button>
      </div>
    );
  }
  const seconds = run.endedAt ? Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000) : null;
  const took = seconds === null ? '' : seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
  return (
    <div className={`task-result tone-box-${tone}`}>
      <div className="callout">
        <span className="ic">
          <Icon name={tone === 'good' ? 'check' : 'close'} size={15} />
        </span>
        <div>
          <b>{run.status === 'failed' ? 'Task failed' : run.endedBy === 'user' ? 'Task cancelled' : 'Task done'}</b>
          <span>
            {took && `Took ${took}`}
            {run.estimatedCostUsd !== null && ` · ~$${run.estimatedCostUsd.toFixed(2)} est.`}
            {run.status === 'failed' && run.error && ` · ${run.error.split('\n')[0]}`}
          </span>
        </div>
        <div className="task-actions">
          <button className="btn sm" onClick={onRunAgain}>
            Run again
          </button>
          <button className="btn sm primary" disabled={!run.sessionId} onClick={onDiscuss}>
            Discuss in chat
          </button>
        </div>
      </div>
    </div>
  );
}

function Tasks({ live, onNew }: { live: Live; onNew: (k: RunKind, defaults?: LaunchReq['defaults']) => void }) {
  const now = useNow(10000);
  const conns = useFetch(api.connections, []);
  const hasWorkbench = !!conns.data?.connections.some((c) => c.kind === 'workbench' && c.connected);
  const [picked, setSource] = useState<'tasks' | 'jira'>(() => (storage('lf:tasks-tab') === 'jira' ? 'jira' : 'tasks'));
  const source = hasWorkbench ? picked : 'tasks';
  const pickSource = (v: 'tasks' | 'jira') => (setSource(v), storage('lf:tasks-tab', v));
  const review = useReview();
  const [filter, setFilter] = useState<'all' | 'active' | 'needs' | 'done' | 'failed'>('all');
  // discussed tasks stay listed while they're chats
  const tasks = [...live.runs.values()].filter((r) => r.kind === 'task' || r.fromTask).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const match = (r: Run) =>
    filter === 'all' ||
    (filter === 'active' && ALIVE.includes(r.status)) ||
    (filter === 'needs' && r.status === 'awaiting_decision') ||
    (filter === 'done' && r.status === 'completed') ||
    (filter === 'failed' && r.status === 'failed');
  const shown = tasks.filter(match);
  const pendingOf = (runId: string) => [...live.decisions.values()].find((d) => d.runId === runId);
  return (
    <Frame
      crumb={
        <>
          <span>Workspace / </span>Tasks
        </>
      }
    >
      <div className="scroll">
        <div className="page">
          <div className="page-heading" style={{ alignItems: 'center' }}>
            <div>
              <h1>Tasks</h1>
              <p className="lead">Jobs you handed off. Each runs to completion on its own and reports back.</p>
              {hasWorkbench && (
                <div className="segmented source-tabs" role="tablist" aria-label="Task source">
                  <button role="tab" aria-selected={source === 'tasks'} className={source === 'tasks' ? 'active' : ''} onClick={() => pickSource('tasks')}>
                    Your tasks <span className="tab-count">{tasks.length}</span>
                  </button>
                  <button role="tab" aria-selected={source === 'jira'} className={source === 'jira' ? 'active' : ''} onClick={() => pickSource('jira')}>
                    From Jira
                  </button>
                </div>
              )}
            </div>
            <button className="btn primary" onClick={() => onNew('task')}>
              <Icon name="plus" size={15} /> New task
            </button>
          </div>
          {source === 'jira' ? (
            <JiraIssues live={live} onNew={onNew} />
          ) : (
          <>
          <div className="tool-bar">
            <div className="segmented" role="tablist">
              {(
                [
                  ['all', 'All'],
                  ['active', 'Running'],
                  ['needs', 'Needs you'],
                  ['done', 'Done'],
                  ['failed', 'Failed'],
                ] as const
              ).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {tasks.length === 0 ? (
            <div className="empty">
              <p style={{ marginBottom: 12 }}>No tasks yet. Hand off a job — a fix, a review, a refactor — and come back for the result.</p>
              <button className="btn primary" onClick={() => onNew('task')}>
                <Icon name="spark" size={15} /> New task
              </button>
            </div>
          ) : shown.length === 0 ? (
            <div className="empty">No tasks match.</div>
          ) : (
            <div className="list-card">
              {shown.map((r) => {
                const tone = runTone(r);
                return (
                  <a key={r.id} className="list-item" href={`#/runs/${r.id}`}>
                    <span className={`glyph tone-${tone}`}>
                      <Icon name={tone === 'good' ? 'check' : tone === 'alert' ? 'close' : 'spark'} size={16} />
                    </span>
                    <div className="copy">
                      <b>{r.prompt.split('\n')[0]}</b>
                      <span>
                        {r.ticket && <TicketChip ticket={r.ticket} />} {projectName(r.cwd)} · {r.model ?? r.requestedModel} · started {ago(r.startedAt, now)}
                        {r.status === 'failed' && r.error && <span className="error"> · {r.error.split('\n')[0]}</span>}
                      </span>
                    </div>
                    <div className="side">
                      {pendingOf(r.id) ? (
                        <button
                          className="btn sm primary"
                          onClick={(e) => {
                            e.preventDefault();
                            review(pendingOf(r.id)!.id);
                          }}
                        >
                          Review
                        </button>
                      ) : (
                        <StatusPill run={r} />
                      )}
                      <div style={{ marginTop: 4 }}>{r.estimatedCostUsd === null ? '' : `~$${r.estimatedCostUsd.toFixed(2)} est.`}</div>
                    </div>
                  </a>
                );
              })}
            </div>
          )}
          <p className="footnote">Tasks live in memory while the server runs; their transcripts stay under Sessions.</p>
          </>
          )}
        </div>
      </div>
    </Frame>
  );
}

function SettingsPage() {
  const { data: s, error } = useFetch(api.settings, []);
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const loadConns = () => api.connections().then((r) => (setConns(r.connections), setConnError(null), r.connections), (e) => (setConnError(e.message), null));
  useEffect(() => {
    loadConns();
  }, []);
  const wb = conns?.find((c) => c.kind === 'workbench' && c.connected);
  return (
    <Frame
      crumb={
        <>
          <span>Workspace / </span>Settings
        </>
      }
    >
      <div className="scroll">
        <div className="page">
          <div className="page-heading">
            <div>
              <h1>Settings</h1>
              <p className="lead">Servers your chats and tasks can reach, and how tickets are detected.</p>
            </div>
          </div>
          <Connections list={conns} error={connError} reload={loadConns} />
          {wb && <Integrations key={wb.name} workbenchUrl={new URL(wb.url).origin} />}
          {error && <p className="error">{error}</p>}
          {s && (
            <>
              <div className="sectionbar">
                <h2>Ticket detection</h2>
              </div>
              <div className="section-list">
                <div className="row">
                  <div className="copy">
                    <b>{s.ticketKeys.length ? s.ticketKeys.join(', ') : 'Any KEY-123 pattern'}</b>
                    <span>Detected from the prompt, then the git branch. You can always type one when starting a chat or task.</span>
                  </div>
                </div>
              </div>
              <p className="footnote">
                Set <code>ticketKeys</code> (e.g. <code>["PROJ"]</code>) in <span className="mono">{s.path}</span> to only match your projects.
              </p>
            </>
          )}
        </div>
      </div>
    </Frame>
  );
}

function Connections({ list, error, reload }: { list: Connection[] | null; error: string | null; reload: () => Promise<Connection[] | null> }) {
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // after opening an OAuth link, watch for the connection to flip to connected
  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const t = setInterval(async () => {
      const l = await reload();
      if (l?.find((c) => c.name === pending)?.connected || Date.now() - started > 5 * 60_000) {
        clearInterval(t);
        setPending(null);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [pending]);

  const act = async (f: () => Promise<unknown>) => {
    setErr(null);
    try {
      await f();
    } catch (e: any) {
      setErr(e.message);
    }
    await reload();
  };
  const connect = (name: string) =>
    act(async () => {
      const { url } = await api.connectConnection(name);
      window.open(url, '_blank', 'noopener');
      setPending(name);
    });

  return (
    <>
      <div className="sectionbar" style={{ marginTop: 0 }}>
        <h2>Connections</h2>
        {!adding && (
          <button className="text-action" onClick={() => setAdding(true)}>
            + Add connection
          </button>
        )}
      </div>
      {adding && (
        <AddConnection
          onCancel={() => setAdding(false)}
          onAdded={async (c) => {
            setAdding(false);
            await reload();
            if (c.auth === 'oauth') await connect(c.name);
          }}
        />
      )}
      {(err || error) && <p className="error">{err ?? error}</p>}
      {list && !list.length && !adding && <div className="empty">No connections yet. Add workbench or any MCP server — every chat and task can then use it.</div>}
      {!!list?.length && (
        <div className="section-list">
          {list.map((c) => (
            <div key={c.name} className="row">
              <span className="marker soft">{c.name.charAt(0).toUpperCase()}</span>
              <div className="copy">
                <b>
                  {c.name} <span className="badge">{c.kind === 'workbench' ? 'Workbench' : 'MCP'}</span>
                </b>
                <span>
                  {c.url} · {c.auth === 'oauth' ? 'OAuth' : `Header ${c.headerNames.join(', ')}`}
                  {c.user?.email && ` · ${c.user.email}`}
                </span>
              </div>
              <div className="actions">
                {c.connected ? (
                  <span className="status-pill tone-good">Connected</span>
                ) : pending === c.name ? (
                  <span className="status-pill tone-watch">Finish in browser…</span>
                ) : (
                  <span className="status-pill tone-off">Not connected</span>
                )}
                {c.auth === 'oauth' &&
                  (c.connected ? (
                    <button className="btn sm" onClick={() => act(() => api.disconnectConnection(c.name))}>
                      Disconnect
                    </button>
                  ) : (
                    <button className="btn sm" onClick={() => connect(c.name)}>
                      Connect
                    </button>
                  ))}
                {removing === c.name ? (
                  <button className="btn sm danger" onClick={() => (setRemoving(null), act(() => api.removeConnection(c.name)))}>
                    Confirm remove
                  </button>
                ) : (
                  <button className="btn sm ghost" onClick={() => setRemoving(c.name)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="footnote">
        Connected servers join every new chat and task as MCP tools (<code>mcp__&lt;name&gt;__…</code>). Credentials stay on this machine and are attached by
        legos-factory, never handed to the agent.
      </p>
    </>
  );
}

function AddConnection({ onCancel, onAdded }: { onCancel: () => void; onAdded: (c: Connection) => void }) {
  const [kind, setKind] = useState<'workbench' | 'mcp'>('workbench');
  const [name, setName] = useState('workbench');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<'oauth' | 'header'>('oauth');
  const [header, setHeader] = useState('Authorization');
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pickKind = (k: 'workbench' | 'mcp') => {
    setKind(k);
    if (k === 'workbench') setAuth('oauth');
    if (!name || name === 'workbench') setName(k === 'workbench' ? 'workbench' : '');
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onAdded(await api.addConnection({ name: name.trim(), kind, url: url.trim(), auth, ...(auth === 'header' && { headers: { [header.trim()]: value } }) }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="add-conn" onSubmit={submit}>
      <div className="segmented" role="tablist" aria-label="Connection type">
        {(
          [
            ['workbench', 'Workbench'],
            ['mcp', 'MCP server'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => pickKind(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="field-row">
        <label className="field">
          Name
          <input className="input" value={name} placeholder="e.g. tools" onChange={(e) => setName(e.target.value.toLowerCase())} />
        </label>
        <label className="field">
          {kind === 'workbench' ? 'Workbench URL' : 'MCP endpoint URL'}
          <input className="input" value={url} placeholder={kind === 'workbench' ? 'https://workbench.example.com' : 'https://example.com/mcp'} onChange={(e) => setUrl(e.target.value)} />
        </label>
      </div>
      {kind === 'mcp' && (
        <label className="field">
          Authentication
          <select className="input" value={auth} onChange={(e) => setAuth(e.target.value as 'oauth' | 'header')}>
            <option value="oauth">OAuth — sign in through the browser</option>
            <option value="header">Static header — API key or token</option>
          </select>
        </label>
      )}
      {auth === 'header' && (
        <div className="field-row">
          <label className="field">
            Header
            <input className="input" value={header} onChange={(e) => setHeader(e.target.value)} />
          </label>
          <label className="field">
            Value
            <input className="input" type="password" autoComplete="off" value={value} placeholder="Bearer …" onChange={(e) => setValue(e.target.value)} />
          </label>
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <div className="add-conn-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !name.trim() || !url.trim() || (auth === 'header' && (!header.trim() || !value))}>
          {busy ? 'Adding…' : auth === 'oauth' ? 'Add and connect' : 'Add'}
        </button>
      </div>
    </form>
  );
}

// workbench integration ids -> names as workbench shows them
const APP_NAMES: Record<string, string> = {
  'atlassian-jira': 'Jira',
  'atlassian-confluence': 'Confluence',
  'atlassian-bitbucket': 'Bitbucket',
  'google-gmail': 'Gmail',
  'google-drive': 'Google Drive',
  'google-sheets': 'Google Sheets',
  'google-calendar': 'Google Calendar',
  'google-gemini': 'Google Gemini',
  'google-docs': 'Google Docs',
  'google-slides': 'Google Slides',
  github: 'GitHub',
  gitlab: 'GitLab',
  newrelic: 'New Relic',
  'httpbin-cookie': 'HTTPBin (cookie demo)',
  clevertap: 'CleverTap',
  kafkahq: 'KafkaHQ (AKHQ)',
  testrail: 'TestRail',
};
const appName = (id: string) => APP_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

function Integrations({ workbenchUrl }: { workbenchUrl: string | null }) {
  const [list, setList] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'all' | 'connected' | 'available'>('all');
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<string | null>(null);

  const load = () => api.integrations().then((r) => (setList(r.integrations), setError(null)), (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  // after opening a connect link, watch for the integration to flip to connected
  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const t = setInterval(async () => {
      const r = await api.integrations().catch(() => null);
      if (r) setList(r.integrations);
      if (r?.integrations.find((i) => i.name === pending)?.connected || Date.now() - started > 3 * 60_000) {
        clearInterval(t);
        setPending(null);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [pending]);

  const connect = async (name: string) => {
    setError(null);
    try {
      const { url } = await api.connect(name);
      if (!url) throw new Error('workbench did not return a link');
      window.open(url, '_blank', 'noopener');
      setPending(name);
    } catch (e: any) {
      setError(`Could not start connecting ${appName(name)}: ${e.message}`);
    }
  };

  const all = list ?? [];
  const connected = all.filter((i) => i.connected);
  const shown = all
    .filter((i) => (tab === 'all' ? true : tab === 'connected' ? i.connected : !i.connected))
    .filter((i) => !q || `${i.name} ${appName(i.name)}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="sectionbar">
        <h2>Workbench apps</h2>
        {workbenchUrl && (
          <a className="text-action" href={workbenchUrl} target="_blank" rel="noreferrer">
            Open workbench →
          </a>
        )}
      </div>
      <div className="tool-bar">
        <div className="segmented" role="tablist">
          {(
            [
              ['all', 'All', all.length],
              ['connected', 'Connected', connected.length],
              ['available', 'Available', all.length - connected.length],
            ] as const
          ).map(([k, label, n]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {label} <span className="tab-count">{n}</span>
            </button>
          ))}
        </div>
        <input className="input" placeholder="Search apps" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {!list && !error ? (
        <div className="empty">Asking workbench…</div>
      ) : (
        <div className="app-grid">
          {shown.map((i) => (
            <div key={i.name} className="app-card">
              <span className={`app-icon ${i.connected ? 'on' : ''}`}>{appName(i.name).charAt(0)}</span>
              <div className="copy">
                <b>{appName(i.name)}</b>
                <span>v{i.version ?? '?'}</span>
              </div>
              {i.connected ? (
                <span className="status-pill tone-good">Connected</span>
              ) : pending === i.name ? (
                <span className="status-pill tone-watch">Finish in workbench…</span>
              ) : (
                <button className="btn sm" onClick={() => connect(i.name)}>
                  Connect
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="footnote">Connected apps are available to every chat and task as workbench tools, using your own access.</p>
    </>
  );
}

const JIRA_FILTERS = [
  ['mine', 'Assigned to me'],
  ['sprint', 'Current sprint'],
] as const;

const jiraTone = (status: string | null) => {
  const st = (status ?? '').toLowerCase();
  if (/done|closed|resolved/.test(st)) return 'good';
  if (/review|testing|qa|blocked/.test(st)) return 'watch';
  if (/progress|develop/.test(st)) return 'run';
  return 'off';
};

function taskPrompt(i: { key: string; summary: string; description: string | null; url: string | null }, kind: RunKind) {
  const details = i.description ? `\n\nTicket details:\n${i.description.slice(0, 4000)}${i.description.length > 4000 ? '\n…(truncated)' : ''}` : '';
  const link = i.url ? `\n\nLink: ${i.url}` : '';
  return kind === 'task'
    ? `Work on Jira ticket ${i.key}: ${i.summary}${details}${link}\n\nRead the relevant code, implement the change, and verify it (tests/build). Use the workbench Jira tools if you need more context. Don't transition or comment on the ticket unless I ask. Finish with a short summary of what changed and what's left open.`
    : `Let's discuss Jira ticket ${i.key}: ${i.summary}${details}${link}\n\nStart by summarising what it asks for, how you'd approach it in this repo, and the open questions.`;
}

function JiraIssues({ live, onNew }: { live: Live; onNew: (k: RunKind, defaults?: LaunchReq['defaults']) => void }) {
  const now = useNow(30000);
  const [filter, setFilter] = useState<string>(() => storage('lf:jira-filter') ?? 'mine');
  const [rows, setRows] = useState<JiraRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const load = async (more = false) => {
    setError(null);
    if (!more) setRows(null);
    try {
      const r = await api.jiraIssues(filter, more ? (next ?? undefined) : undefined);
      setRows((prev) => (more && prev ? [...prev, ...r.issues] : r.issues));
      setNext(r.nextPageToken);
    } catch (e: any) {
      setError(e.message);
      if (!more) setRows([]);
    }
  };
  useEffect(() => {
    storage('lf:jira-filter', filter);
    void load();
  }, [filter]);

  // Pull full ticket details so the run starts with real context, not just a title.
  const start = async (row: JiraRow, kind: RunKind) => {
    setOpening(`${row.key}:${kind}`);
    setError(null);
    try {
      const issue = await api.jiraIssue(row.key);
      onNew(kind, { prompt: taskPrompt(issue, kind), ticket: issue.key });
    } catch (e: any) {
      setError(`Could not read ${row.key}: ${e.message}`);
    } finally {
      setOpening(null);
    }
  };

  const runsFor = (key: string) => [...live.runs.values()].filter((r) => r.ticket === key);

  return (
    <>
      <div className="tool-bar">
        <div className="segmented" role="tablist">
          {JIRA_FILTERS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <button className="btn sm ghost" onClick={() => load()}>
          Refresh
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!rows ? (
        <div className="empty">Asking Jira through workbench…</div>
      ) : rows.length === 0 ? (
        !error && <div className="empty">No open issues here.</div>
      ) : (
        <div className="list-card">
          {rows.map((i) => {
            const linked = runsFor(i.key);
            const active = linked.find((r) => ALIVE.includes(r.status));
            return (
              <div key={i.key} className="list-item jira-row">
                <TicketChip ticket={i.key} />
                <div className="copy">
                  <b title={i.summary}>{i.summary}</b>
                  <span>
                    <span className={`status-pill tone-${jiraTone(i.status)}`}>{i.status ?? 'Unknown'}</span> {i.priority && `· ${i.priority} `}· updated {ago(i.updated, now)}
                    {linked.length > 0 && (
                      <a className="text-action" href={`#/runs/${(active ?? linked[0]).id}`}>
                        {' '}
                        · {active ? 'task running →' : `${linked.length} run${linked.length > 1 ? 's' : ''} →`}
                      </a>
                    )}
                  </span>
                </div>
                <div className="actions">
                  <button className="btn sm" disabled={!!opening} onClick={() => start(i, 'chat')}>
                    {opening === `${i.key}:chat` ? 'Opening…' : 'Discuss'}
                  </button>
                  <button className="btn sm primary" disabled={!!opening} onClick={() => start(i, 'task')}>
                    {opening === `${i.key}:task` ? 'Opening…' : 'Work on this'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {next && rows && rows.length > 0 && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button className="btn sm" onClick={() => load(true)}>
            Load more
          </button>
        </div>
      )}
      <p className="footnote">Read through workbench with your own Jira access. “Work on this” opens a task with the ticket's details; pick the repo before starting.</p>
    </>
  );
}

const RANGES = [
  [1, 'Today'],
  [7, '7 days'],
  [30, '30 days'],
] as const;

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
};

const took = (i: { startedAt: string; endedAt: string | null }) => {
  if (!i.endedAt) return null;
  const s = Math.round((Date.parse(i.endedAt) - Date.parse(i.startedAt)) / 1000);
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

// since local midnight for "Today", else rolling days
const sinceDays = (days: number) => (days === 1 ? Math.max(1, Math.ceil((Date.now() - new Date().setHours(0, 0, 0, 0)) / 86_400_000)) : days);

function MyActivity({ live }: { live: Live }) {
  const [days, setDays] = useState<number>(7);
  const { data, error } = useFetch(() => api.myActivity(sinceDays(days)), [days]);
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const items = (data?.items ?? []).filter((i) => days !== 1 || Date.parse(i.lastEventAt) >= startOfToday);
  const tasks = items.filter((i) => i.kind === 'task');
  const done = tasks.filter((i) => i.status === 'completed' && i.endedBy !== 'user').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  const tickets = new Set(items.map((i) => i.ticket).filter(Boolean));
  const priced = items.filter((i) => i.estimatedCostUsd !== null);
  const cost = priced.reduce((n, i) => n + i.estimatedCostUsd!, 0);
  const groups = new Map<string, typeof items>();
  for (const i of items) groups.set(dayLabel(i.startedAt), [...(groups.get(dayLabel(i.startedAt)) ?? []), i]);

  return (
    <Frame
      crumb={
        <>
          <span>You / </span>My activity
        </>
      }
    >
      <div className="scroll">
        <div className="page">
          <div className="page-heading" style={{ alignItems: 'center' }}>
            <div>
              <h1>My activity</h1>
              <p className="lead">Chats and tasks you ran from legos-factory on this Mac.</p>
            </div>
            <div className="segmented" role="tablist">
              {RANGES.map(([d, label]) => (
                <button key={d} role="tab" aria-selected={days === d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {error && <p className="error">{error}</p>}
          <div className="kpis kpis-4">
            <div className="kpi">
              <div className="label">Chats</div>
              <strong>{items.length - tasks.length}</strong>
              <small>interactive sessions</small>
            </div>
            <div className="kpi">
              <div className="label">Tasks</div>
              <strong>{tasks.length}</strong>
              <small>
                {done} done{failed ? ` · ${failed} failed` : ''}
              </small>
            </div>
            <div className="kpi">
              <div className="label">Tickets</div>
              <strong>{tickets.size}</strong>
              <small>{[...tickets].slice(0, 3).join(', ') || 'none tagged'}</small>
            </div>
            <div className="kpi cost">
              <div className="label">Cost (est.)</div>
              <strong>{priced.length ? `~$${cost.toFixed(2)}` : 'Unknown'}</strong>
              <small>API-equivalent · only you see this</small>
            </div>
          </div>
          {!data ? (
            <div className="empty">Loading…</div>
          ) : items.length === 0 ? (
            <div className="empty">Nothing in this range yet.</div>
          ) : (
            [...groups].map(([day, rows]) => (
              <div key={day}>
                <div className="sectionbar">
                  <h2>{day}</h2>
                  <span className="meta">{rows.length} run{rows.length === 1 ? '' : 's'}</span>
                </div>
                <div className="list-card">
                  {rows.map((i) => {
                    const href = live.runs.has(i.runId) ? `#/runs/${i.runId}` : i.sessionId ? `#/sessions/${i.sessionId}` : undefined;
                    return (
                      <a key={i.runId} className="list-item" href={href}>
                        <span className={`glyph tone-${runTone(i)}`}>
                          <Icon name={i.kind === 'task' ? 'spark' : 'chat'} size={16} />
                        </span>
                        <div className="copy">
                          <b>{i.title}</b>
                          <span>
                            {i.ticket && <TicketChip ticket={i.ticket} />} {i.kind === 'task' ? 'Task' : 'Chat'} · {i.project} ·{' '}
                            {new Date(i.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            {took(i) && ` · ${took(i)}`}
                          </span>
                        </div>
                        <div className="side">
                          <StatusPill run={i} />
                          <div style={{ marginTop: 4 }}>{i.estimatedCostUsd === null ? '' : `~$${i.estimatedCostUsd.toFixed(2)}`}</div>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </div>
            ))
          )}
          <p className="footnote">Kept in ~/.legos-factory/activity.jsonl. Costs are Claude Code's API-equivalent estimates, not invoices.</p>
        </div>
      </div>
    </Frame>
  );
}

function TeamActivity() {
  const now = useNow(30000);
  const [days, setDays] = useState<number>(1);
  const [q, setQ] = useState('');
  const [tick, setTick] = useState(0);
  const { data, error } = useFetch(() => api.team(sinceDays(days)), [days, tick]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const notConfigured = error?.includes('not configured');
  const match = (i: TeamItem) => !q || `${i.ticket ?? ''} ${i.title} ${i.project}`.toLowerCase().includes(q.toLowerCase());
  const members = (data?.members ?? []).map((m) => ({ ...m, items: m.items.filter(match) })).filter((m) => !q || m.items.length);

  return (
    <Frame
      crumb={
        <>
          <span>Team / </span>Team activity
        </>
      }
    >
      <div className="scroll">
        <div className="page">
          <div className="page-heading" style={{ alignItems: 'center' }}>
            <div>
              <h1>Team activity</h1>
              <p className="lead">What everyone's agents are working on. Status only — no conversations, no costs.</p>
            </div>
            <div className="segmented" role="tablist">
              {RANGES.map(([d, label]) => (
                <button key={d} role="tab" aria-selected={days === d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {notConfigured ? (
            <div className="empty">
              <p>
                <b>Team hub isn't connected.</b>
              </p>
              <p style={{ marginTop: 6 }}>
                For now the hub runs locally: start everything with <code>npm run dev:team</code>. Once it's deployed for your team, point <code>LEGOS_HUB_URL</code> at it.
              </p>
            </div>
          ) : error ? (
            <p className="error">{error}</p>
          ) : !data ? (
            <div className="empty">Asking the team hub…</div>
          ) : (
            <>
              <div className="tool-bar">
                <input className="input" placeholder="Filter by ticket, title or project (e.g. PROJ-123)" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              {members.length === 0 ? (
                <div className="empty">{q ? 'Nobody matches.' : 'No shared activity in this range yet. Private folders never show up here.'}</div>
              ) : (
                <div className="team-grid">
                  {members.map((m) => {
                    const active = m.items.filter((i) => ALIVE.includes(i.status));
                    const waiting = m.items.filter((i) => i.status === 'awaiting_decision').length;
                    const doneToday = m.items.filter((i) => i.status === 'completed' && i.endedAt && Date.parse(i.endedAt) >= new Date().setHours(0, 0, 0, 0)).length;
                    return (
                      <div key={m.email} className="team-card">
                        <div className="team-head">
                          <span className="avatar-btn static">{initials(m.email)}</span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <b className="ellipsis">
                              {m.email}
                              {m.email === data.me && <span className="badge" style={{ marginLeft: 6 }}>You</span>}
                            </b>
                            <small>seen {ago(m.lastSeen, now)}</small>
                          </div>
                        </div>
                        <div className="team-stats">
                          <span className={active.length ? 'on' : ''}>
                            <b>{active.length}</b> active
                          </span>
                          <span className={waiting ? 'warn' : ''}>
                            <b>{waiting}</b> waiting
                          </span>
                          <span>
                            <b>{doneToday}</b> done today
                          </span>
                        </div>
                        <ul className="team-items">
                          {m.items.slice(0, 6).map((i) => (
                            <li key={i.runId}>
                              <span className={`sdot ${runTone(i)}`} />
                              <span className="t">
                                {i.ticket && <TicketChip ticket={i.ticket} />} {i.title}
                              </span>
                              <small>{runLabel(i)}</small>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
          <p className="footnote">Every signed-in member sees everyone. Only runs from folders shared as Status (e.g. work repos) are sent; refreshes every 30s.</p>
        </div>
      </div>
    </Frame>
  );
}
