import { useState } from 'react';
import type { Run, RunKind, SessionSummary } from '../../shared/types.ts';
import { ago, fmtTokens, projectName, useNow } from '../api.ts';
import { DecisionRow, ShareBadge, TicketChip, go, runLabel, runTone, totalTokens } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { ALIVE, RECENT_MS, ORDER, type Live, type ResumeReq, useReview, openSearch, Frame } from '../chrome.tsx';

function evidenceOf(r: Run, now: number) {
  const toolErrors = r.events.filter((e) => e.kind === 'tool_result' && e.isError).length;
  const errors = toolErrors + (r.error ? 1 : 0);
  return { errors, last: ago(ALIVE.includes(r.status) ? r.lastEventAt : r.endedAt, now) };
}

function calloutOf(r: Run, pending: number, now: number): { icon: 'check' | 'stop' | 'clock' | 'spark' | 'close'; title: string; text: string } {
  switch (r.status) {
    case 'awaiting_decision':
      return { icon: 'stop', title: 'Waiting for your approval', text: `${pending} open request${pending === 1 ? '' : 's'} · nothing runs until you answer` };
    case 'queued':
      return { icon: 'clock', title: 'Queued', text: 'Waiting for a free slot · starts on its own when another run ends' };
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

export function Overview({
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
                    <span>Find any of your chats and tasks</span>
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
