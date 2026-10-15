import { useMemo, useState } from 'react';
import type { SessionSummary } from '../../shared/types.ts';
import { api, ago, fmtTokens, projectName, useFetch, useNow } from '../api.ts';
import { Empty, ShareBadge, TicketChip, Thread, UsageRows, totalTokens } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { ALIVE, RECENT_MS, type Live, type ResumeReq, useStickyScroll, Frame } from '../chrome.tsx';

export function Sessions({ sessions, error, live }: { sessions: SessionSummary[] | null; error: string | null; live: Live }) {
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
              <p className="lead">Your chats and tasks started from legos-factory. Read-only until you continue one.</p>
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
          <p className="footnote">Only sessions you started here are listed; terminal sessions stay private. Titles come from /rename or the first prompt.</p>
        </div>
      </div>
    </Frame>
  );
}

// ---------- chat views ----------

export function SessionView({ id, live, onContinue }: { id: string; live: Live; onContinue: (r: ResumeReq) => void }) {
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
