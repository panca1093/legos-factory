import { useEffect, useState } from 'react';
import type { TeamItem } from '../../shared/types.ts';
import { api, ago, useFetch, useLive, useNow } from '../api.ts';
import { TicketChip, StatusPill, LaunchDialog, runLabel, runTone } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { ALIVE, RECENT_MS, type Live, type ResumeReq, Frame, initials } from '../chrome.tsx';

import { Sessions } from './Sessions.tsx';
import './Activity.css';

const RANGES = [
  [1, 'Today'],
  [7, '7 days'],
  [30, '30 days'],
] as const;

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
};

const took = (i: { startedAt: string; endedAt: string | null }) => {
  if (!i.endedAt) return null;
  const s = Math.round((Date.parse(i.endedAt) - Date.parse(i.startedAt)) / 1000);
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

export function MyActivity({ live }: { live: Live }) {
  return <Activity live={live} />;
}

export function TeamActivity() {
  const live = useLive();
  return <Activity live={live} initialTab="team" />;
}

function Activity({ live, initialTab = 'mine' }: { live?: Live; initialTab?: 'mine' | 'team' }) {
  const [tab, setTab] = useState(initialTab);
  const [days, setDays] = useState<number>(7);
  const [query, setQuery] = useState('');
  const [resume, setResume] = useState<ResumeReq | null>(null);
  const mineLive: Live = live ?? { conn: 'connected', runs: new Map(), decisions: new Map() };
  return <Frame crumb={<><span>Workspace / </span>Activity</>}>
    <div className="scroll"><div className="page activity-page">
      <div className="page-heading"><div><h1>Activity</h1><p className="lead">{tab === 'mine' ? 'Everything you and your factory did, with outcome and est. cost.' : 'What everyone’s factory is doing right now, and who is waiting on whom.'}</p></div>
        <div className="segmented" role="tablist" aria-label="Range">{RANGES.map(([d, label]) => <button key={d} role="tab" aria-selected={days === d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>{label}</button>)}</div>
      </div>
      <div className="activity-toolbar"><div className="segmented" role="tablist" aria-label="Whose activity">{(['mine', 'team'] as const).map((value) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value === 'mine' ? 'Mine' : 'Team'}</button>)}</div>
        <input id="session-search" type="search" className="input" aria-label="Filter activity and sessions" placeholder={tab === 'mine' ? 'Filter by ticket, repo or text' : 'Filter by person, ticket, repo or text'} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div role="tabpanel" aria-label={tab === 'mine' ? 'Mine' : 'Team'}>{tab === 'mine' ? <MineActivity live={mineLive} days={days} query={query} onContinue={setResume} /> : <TeamContent days={days} q={query} />}</div>
    </div></div>
    {resume && <LaunchDialog kind="chat" projects={[resume.cwd]} resume={resume} onClose={() => setResume(null)} />}
  </Frame>;
}

function MineActivity({ live, days, query, onContinue }: { live: Live; days: number; query: string; onContinue: (r: ResumeReq) => void }) {
  const { data, error } = useFetch(() => api.myActivity(days), [days, live.runs]);
  const sessions = useFetch(api.sessions, [live.runs]);
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const items = (data?.items ?? []).filter((i) => (days !== 1 || Date.parse(i.lastEventAt) >= startOfToday) && `${i.title} ${i.ticket ?? ''} ${i.repo ?? ''} ${i.project}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const priced = items.filter((i) => i.estimatedCostUsd !== null);
  const cost = priced.reduce((n, i) => n + i.estimatedCostUsd!, 0);
  const groups = new Map<string, typeof items>();
  for (const i of items) groups.set(dayLabel(i.startedAt), [...(groups.get(dayLabel(i.startedAt)) ?? []), i]);

  return (
    <>
          {error && <p className="error">{error}</p>}
          <div className="activity-stats">
            <div><b>{data ? items.length : '—'}</b><span>runs</span></div>
            <div><b>—</b><span>tickets shipped</span><small>Shipping history is not available</small></div>
            <div><b>—</b><span>gates you passed</span><small>Gate history is not available</small></div>
            <div><b>{data ? items.filter((i) => i.status === 'awaiting_decision').length : '—'}</b><span>runs paused for you</span></div>
            <div><b>{priced.length ? `~$${cost.toFixed(2)}` : '—'}</b><span>est. cost{items.length > priced.length ? ` · ${items.length - priced.length} runs “—”` : ''}</span></div>
          </div>
          {!data && !error ? (
            <div className="empty">Loading…</div>
          ) : data && items.length === 0 ? (
            <div className="empty">Nothing in this range yet.</div>
          ) : (
            [...groups].map(([day, rows]) => (
              <div key={day}>
                <div className="sectionbar">
                  <h2>{day}</h2>
                  <span className="meta">{rows.length} run{rows.length === 1 ? '' : 's'}</span>
                </div>
                <div className="list-card">
                  <div className="activity-row activity-columns" aria-hidden="true"><span /><span>What</span><span>Stage</span><span>Outcome</span><span>Took</span><span>Cost</span><span /></div>
                  {rows.map((i) => {
                    const href = live.runs.has(i.runId) ? `#/runs/${i.runId}` : i.sessionId ? `#/sessions/${i.sessionId}` : undefined;
                    return (
                      <div key={i.runId} className="activity-row">
                        <span className={`glyph tone-${runTone(i)}`}>
                          <Icon name={i.kind === 'task' ? 'spark' : 'chat'} size={16} />
                        </span>
                        <div className="copy">
                          <b>{i.title}</b>
                          <span>
                            {i.ticket && <TicketChip ticket={i.ticket} />} {i.repo ?? i.project} ·{' '}
                            {new Date(i.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            {took(i) && ` · ${took(i)}`}
                          </span>
                        </div>
                        <span>{i.stage === 'design' ? 'Spec' : i.stage === 'build' ? 'Build' : i.kind === 'chat' ? 'Chat' : 'Task'}</span>
                        <StatusPill run={i} />
                        <span className="meta">{took(i) ?? '—'}</span>
                        <span className="meta">{i.estimatedCostUsd === null ? '—' : `~$${i.estimatedCostUsd.toFixed(2)}`}</span>
                        <div className="activity-actions">
                          {href ? <a href={href}>Open</a> : <span className="meta">No transcript</span>}
                          {i.kind === 'chat' && !ALIVE.includes(i.status) && sessions.data?.some((session) => session.id === i.sessionId && session.cwd) && <button className="btn sm" onClick={() => {
                            const session = sessions.data!.find((row) => row.id === i.sessionId)!;
                            onContinue({ sessionId: session.id, cwd: session.cwd!, recentlyActive: !!session.lastActivityAt && Date.now() - Date.parse(session.lastActivityAt) < RECENT_MS });
                          }}>Continue</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
          <p className="footnote">Cost is Claude Code's API-equivalent estimate; “—” means no usage was available, not zero. A partial total includes priced runs only.</p>
          <Sessions sessions={sessions.data} error={sessions.error} live={live} embedded query={query} onContinue={onContinue} />
    </>
  );
}

function TeamContent({ days, q }: { days: number; q: string }) {
  const now = useNow(30000);
  const [tick, setTick] = useState(0);
  const { data, error } = useFetch(() => api.team(days), [days, tick]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const notConfigured = data?.configured === false || error?.includes('not configured');
  const cutoff = days === 1 ? new Date(now).setHours(0, 0, 0, 0) : now - days * 86400000;
  const match = (i: TeamItem) => !q || `${i.ticket ?? ''} ${i.title} ${i.repo ?? ''} ${i.project}`.toLowerCase().includes(q.toLowerCase());
  const members = (data?.members ?? []).map((m) => ({ ...m, items: m.items.filter((i) => Date.parse(i.lastEventAt) >= cutoff && (m.email.toLowerCase().includes(q.toLowerCase()) || match(i))) })).filter((m) => !q || m.items.length);
  return (
    <>
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
          <p className="footnote">Status only: no conversations, no costs. Folders set to Private never show up here. Refreshes every 30s.</p>
    </>
  );
}
