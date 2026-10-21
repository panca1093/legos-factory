import { useEffect, useMemo, useState } from 'react';
import type { RunKind } from '../shared/types.ts';
import { api, onSignedOut, useFetch, useLive, type Me } from './api.ts';
import { LaunchDialog, ReviewModal, ThemeSwitch, runLabel, runTone } from './components.tsx';
import { Icon } from './icons.tsx';
import { ALIVE, type Live, type ResumeReq, type LaunchReq, Chrome, openSearch } from './chrome.tsx';
import { MyActivity, TeamActivity } from './pages/Activity.tsx';
import { Overview } from './pages/Overview.tsx';
import { PrPage } from './pages/PrPage.tsx';
import { Reviews } from './pages/Reviews.tsx';
import { RunView } from './pages/RunView.tsx';
import { SessionView } from './pages/Sessions.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { Work } from './pages/Work.tsx';
import { WorkItem } from './pages/WorkItem.tsx';

export function redirectTarget(hash: string): string | null {
  const legacy = hash.replace(/^#\/?/, '').replace(/\/$/, '');
  return legacy === 'tasks' ? '#/work' : legacy === 'sessions' ? '#/activity' : null;
}

function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => {
      const target = redirectTarget(location.hash);
      if (target) history.replaceState(null, '', target);
      setHash(location.hash);
    };
    on();
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

// Sign in before anything else loads; the API and live stream need a session.
export function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = () => api.me().then((m) => (setMe(m), setError(null)), (e) => setError(e.message));
  useEffect(() => {
    check();
    return onSignedOut(() => setMe((m) => (m ? { ...m, authenticated: false, user: null } : m)));
  }, []);
  if (error) return <SignIn me={null} error={`Can't reach legos-factory: ${error}`} onDone={check} />;
  if (!me) return null;
  if (me.authEnabled && !me.authenticated) return <SignIn me={me} onDone={check} />;
  return <App me={me} />;
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
        {view === 'work' && !id && <Work onStart={(row) => setLaunch({ kind: 'task', defaults: { ticket: row.key } })} onNew={() => setLaunch({ kind: 'task' })} />}
        {view === 'work' && id && <WorkItem ticket={decodeURIComponent(id)} live={live} />}
        {view === 'reviews' && <Reviews />}
        {view === 'prs' && route.length === 4 && <PrPage repo={`${route[1]}/${route[2]}`} id={Number(route[3])} />}
        {view === 'settings' && <SettingsPage />}
        {view === 'activity' && <MyActivity live={live} />}
        {view === 'team' && <TeamActivity />}
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
        <a className={`navrow ${!view ? 'active' : ''}`} href="#/" aria-current={!view ? 'page' : undefined}>
          <Icon name="box" /> Overview
          {live.decisions.size > 0 && <span className="count">{live.decisions.size}</span>}
        </a>
        <a className={`navrow ${view === 'work' || runView?.kind === 'task' ? 'active' : ''}`} href="#/work" aria-current={view === 'work' || runView?.kind === 'task' ? 'page' : undefined}>
          <Icon name="spark" /> Work
          {activeTasks > 0 && <span className="later">{activeTasks} running</span>}
        </a>
        <a className={`navrow ${view === 'reviews' ? 'active' : ''}`} href="#/reviews" aria-current={view === 'reviews' ? 'page' : undefined}>
          <Icon name="check" /> Reviews
        </a>
        <a className={`navrow ${view === 'activity' || view === 'team' || view === 'sessions' ? 'active' : ''}`} href="#/activity" aria-current={view === 'activity' || view === 'team' || view === 'sessions' ? 'page' : undefined}>
          <Icon name="clock" /> Activity
        </a>
        <a className={`navrow ${view === 'settings' ? 'active' : ''}`} href="#/settings" aria-current={view === 'settings' ? 'page' : undefined}>
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
