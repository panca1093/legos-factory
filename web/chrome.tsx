import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Run, RunKind, Stage } from '../shared/types.ts';
import { api, useLive, type Conn, type Me } from './api.ts';
import { ConnChip, go } from './components.tsx';
import { Icon } from './icons.tsx';

export const ALIVE: Run['status'][] = ['queued', 'starting', 'running', 'awaiting_decision', 'idle'];
export const RECENT_MS = 5 * 60 * 1000;
export const ORDER: Run['status'][] = ['awaiting_decision', 'running', 'starting', 'queued', 'idle', 'failed', 'completed'];

export type Live = ReturnType<typeof useLive>;
export type ResumeReq = { sessionId: string; cwd: string; recentlyActive: boolean };
export type LaunchReq = { kind: RunKind; resume?: ResumeReq; defaults?: { cwd?: string; prompt?: string; ticket?: string; stage?: Stage; repo?: string; branch?: string; model?: string } };

// Topbar controls shared by every page frame.
export const Chrome = createContext<{ conn: Conn; openRail: () => void; inspector: boolean; toggleInspector: () => void; review: (decisionId: string) => void; me: Me }>(null!);
export const useReview = () => useContext(Chrome).review;

export function openSearch() {
  go('#/activity');
  setTimeout(() => document.getElementById('session-search')?.focus(), 50);
}

export function Frame({ crumb, inspector, children }: { crumb: ReactNode; inspector?: ReactNode; children: ReactNode }) {
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

function UserMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = me.user?.name ?? 'Local account';
  const kind = me.user?.kind === 'workbench' ? (me.user.email ?? 'Workbench') : 'Local user';
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
              <small className="ellipsis">{kind}</small>
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

export const initials = (s: string) =>
  s
    .split('@')[0]
    .split(/[.\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

// Keeps the thread pinned to the bottom while new events arrive, unless the user scrolled up.
export function useStickyScroll(dep: unknown) {
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

export const PR_TONE: Record<string, string> = { OPEN: 'run', MERGED: 'good', DECLINED: 'bad', SUPERSEDED: 'off' };
