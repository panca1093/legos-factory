import { useEffect, useState } from 'react';
import type { TeamItem } from '../../shared/types.ts';
import { api, ago, useFetch, useNow } from '../api.ts';
import { TicketChip, StatusPill, runLabel, runTone } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { ALIVE, type Live, Frame, initials } from '../chrome.tsx';

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

export function MyActivity({ live }: { live: Live }) {
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

export function TeamActivity() {
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
