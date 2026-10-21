import { useContext, useState, type KeyboardEvent } from 'react';
import type { Run, RunKind, SessionSummary, WorkItem } from '../../shared/types.ts';
import { api, ago, fmtTokens, projectName, useFetch, useNow } from '../api.ts';
import { ShareBadge, TicketChip, go, runLabel, runTone, totalTokens } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { ALIVE, ORDER, type Live, type ResumeReq, Chrome, useReview, Frame } from '../chrome.tsx';
import './Overview.css';

// The ARIA tabs pattern: arrows move focus around the tablist, wrapping; Home and End jump to the ends.
function tabStep(key: string, index: number, count: number): number | null {
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index + count - 1) % count;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

function onTabKey(index: number, select: (next: number) => void) {
  return (e: KeyboardEvent<HTMLButtonElement>) => {
    const tabs = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    const next = tabs ? tabStep(e.key, index, tabs.length) : null;
    if (next === null) return;
    e.preventDefault();
    tabs?.item(next).focus();
    select(next);
  };
}

function evidenceOf(r: Run, now: number) {
  const toolErrors = r.events.filter((e) => e.kind === 'tool_result' && e.isError).length;
  const errors = toolErrors + (r.error ? 1 : 0);
  return { errors, last: ago(ALIVE.includes(r.status) ? r.lastEventAt : r.endedAt, now) };
}

function calloutOf(r: Run, pending: number, now: number): { icon: 'check' | 'stop' | 'clock' | 'spark' | 'close'; title: string; text: string } {
  switch (r.status) {
    case 'awaiting_decision':
      return { icon: 'stop', title: 'Waiting for you → Needs you', text: `${pending} open request${pending === 1 ? '' : 's'} · nothing runs until you answer` };
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

function Glance({ live, needs, merge }: { live: Live; needs: number | null; merge: number | null }) {
  const runs = [...live.runs.values()];
  const tabs = [
    { key: 'needs', label: 'Needs you', n: needs, detail: 'Paused runs and gates waiting on you' },
    { key: 'working', label: 'Working', n: runs.filter((r) => r.status === 'running' || r.status === 'starting').length, detail: 'Runs executing a stage on their own' },
    { key: 'merge', label: 'To merge', n: merge, detail: 'Ready to merge · open the work item to continue' },
  ];
  const [sel, setSel] = useState(0);
  return (
    <div className="glance">
      <div className="glance-head">
        <h2>Right now</h2>
        <span>{live.conn === 'connected' ? 'Live' : 'Reconnecting…'}</span>
      </div>
      <div className="glance-switch" role="tablist" aria-label="Right now">
        <span className="glance-indicator" style={{ transform: `translateX(${sel * 100}%)` }} />
        {tabs.map((t, i) => (
          <button
            key={t.key}
            role="tab"
            className="glance-tab"
            aria-selected={sel === i}
            tabIndex={sel === i ? 0 : -1}
            onClick={() => setSel(i)}
            onKeyDown={onTabKey(i, setSel)}
          >
            {t.label} <b>{t.n ?? '—'}</b>
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
}: {
  live: Live;
  sessions: SessionSummary[] | null;
  error: string | null;
  onNew: (k: RunKind) => void;
  onContinue: (r: ResumeReq) => void;
}) {
  const now = useNow(10000);
  const { me } = useContext(Chrome);
  const runSig = [...live.runs.values()].map((r) => `${r.id}:${r.status}`).join();
  const decisionSig = [...live.decisions.values()].map((d) => d.id).join();
  const work = useFetch(() => api.workItems(), [runSig, decisionSig, Math.floor(now / 30000)]);
  const reviews = useFetch(() => api.reviews(), [Math.floor(now / 60000)]);
  const review = useReview();
  const runs = [...live.runs.values()].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.lastEventAt.localeCompare(a.lastEventAt)).slice(0, 6);
  const decisions = [...live.decisions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const [selId, setSelId] = useState<string | null>(null);
  const selected = runs.find((r) => r.id === selId) ?? runs[0];
  const paused = [...new Set(decisions.map((d) => d.runId))];
  const items = work.data?.items ?? [];
  const gates = items.flatMap((item) => item.repos.filter((repo) => repo.stage === 'spec_review' || repo.stage === 'pr_review').map((repo) => ({ item, repo })));
  const ready = items.flatMap((item) => item.repos.filter((repo) => repo.stage === 'ready').map((repo) => ({ item, repo })));
  const escalated = items.filter((item) => item.plan?.tasks.some((task) => task.state === 'failed'));
  const brainstorm = items.filter((item) => item.repos.some((repo) => repo.stage === 'shaping') && [...live.runs.values()].some((r) => r.ticket === item.ticket && r.kind === 'chat' && r.status === 'idle'));
  const needs = work.data ? paused.length + gates.length + ready.length + escalated.length + brainstorm.length : null;
  const groups = [
    { kind: 'paused', label: 'Run paused', count: paused.length, detail: paused.map((id) => live.runs.get(id)?.ticket ?? projectName(live.runs.get(id)?.cwd ?? null)).join(' · '), action: 'Review', onClick: () => review(decisions[0].id) },
    { kind: 'review', label: 'To review', count: gates.length, detail: gates.map(({ item, repo }) => `${item.ticket} · ${repo.name} · ${stageLabel[repo.stage]}`).join(' · '), action: 'Review', href: '#/reviews' },
    { kind: 'merge', label: 'To merge', count: ready.length, detail: ready.map(({ item, repo }) => `${item.ticket} · ${repo.name}`).join(' · '), action: 'Open', href: ready.length === 1 ? workHref(ready[0].item.ticket) : '#/work' },
    { kind: 'escalated', label: 'Escalated', count: escalated.length, detail: escalated.map((item) => `${item.ticket} · failed plan tasks`).join(' · '), action: 'Decide', href: escalated.length === 1 ? workHref(escalated[0].ticket) : '#/work' },
    { kind: 'brainstorm', label: 'Brainstorm', count: brainstorm.length, detail: brainstorm.map((item) => `${item.ticket} · your turn`).join(' · '), action: 'Reply', href: brainstorm.length === 1 ? workHref(brainstorm[0].ticket) : '#/work' },
  ].filter((group) => group.count > 0);
  const hour = new Date(now).getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const all = sessions ?? [];
  const withUsage = all.filter((s) => s.usage);
  const tokens = withUsage.reduce((n, s) => n + totalTokens(s.usage)!, 0);
  const priced = [...live.runs.values()].filter((r) => r.estimatedCostUsd !== null);
  const cost = priced.reduce((n, r) => n + r.estimatedCostUsd!, 0);

  return (
    <Frame
      crumb={
        <>
          <span>Workspace / </span>Overview
        </>
      }
    >
      <div className="scroll">
        <div className="page overview-page">
          <div className="page-heading">
            <div>
              <div className="page-eyebrow">
                {new Date(now).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} <span className="badge">Live data</span>
              </div>
              <h1>{greeting}{me.user?.name ? `, ${me.user.name.split(' ')[0]}` : ''}</h1>
              <p className="lead">{paused.length} run{paused.length === 1 ? ' is' : 's are'} paused for you, {needs === null ? '—' : needs - paused.length} things wait on your call.</p>
            </div>
            <Glance live={live} needs={needs} merge={work.data ? ready.length : null} />
          </div>

          <div className="sectionbar" style={{ marginTop: 0 }}>
            <h2>Runs</h2>
            <span className="meta">{`${paused.length} paused · ${work.data ? ready.length : '—'} ready to merge · ${work.data ? escalated.length : '—'} escalated`}</span>
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
                  {runs.map((r, i) => {
                    const ev = evidenceOf(r, now);
                    return (
                      <button
                        key={r.id}
                        role="tab"
                        aria-selected={r.id === selected.id}
                        tabIndex={r.id === selected.id ? 0 : -1}
                        className={`run-tab ${runTone(r)}`}
                        onClick={() => setSelId(r.id)}
                        onKeyDown={onTabKey(i, (n) => setSelId(runs[n].id))}
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
                            {runStage(r, items)} · {r.repo ?? projectName(r.cwd)} · {ev.last}
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
              <RunDetail key={selected.id} run={selected} live={live} now={now} items={items} />
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

          <div className="overview-panels">
            <section>
              <div className="sectionbar"><h2>Needs you <small>{needs ?? '—'}</small></h2><span className="meta">only you can unblock these</span></div>
              <div className="overview-panel">
                {work.error && <p className="error">Could not read work items: {work.error}</p>}
                {!work.data && !work.error && <div className="empty">Reading work items…</div>}
                {groups.map((group) => (
                  <div className={`overview-row overview-${group.kind}`} key={group.kind}>
                    <span className="overview-dot" />
                    <div className="overview-body"><div className="overview-row-heading"><span className="overview-tag">{group.label}</span><b>{group.count}</b></div><span className="overview-sub">{group.detail}</span></div>
                    {group.onClick ? <button className="btn sm primary" onClick={group.onClick}>{group.action}</button> : <a className="btn sm" href={group.href}>{group.action}</a>}
                  </div>
                ))}
                {work.data && !groups.length && <div className="empty">Nothing is waiting on you.</div>}
              </div>
            </section>
            <section>
              <div className="sectionbar"><h2>Reviews <small>{reviews.data?.items.filter((r) => !r.approvedByMe).length ?? '—'}</small></h2><a className="text-action" href="#/reviews">All reviews →</a></div>
              <div className="overview-panel">
                {reviews.error ? <p className="error">Could not read reviews: {reviews.error}</p> : !reviews.data ? <div className="empty">Reading reviews…</div> : <>
                  {reviews.data.failed.length > 0 && <p className="error">Some repositories could not be read: {reviews.data.failed.join(', ')}</p>}
                  {reviews.data.items.filter((r) => !r.approvedByMe).slice(0, 5).map((r) => (
                    <div className="overview-row overview-review" key={`${r.repo}/${r.id}`}>
                      <span className="overview-dot" />
                      <div className="overview-body"><div className="overview-row-heading"><span className="overview-tag">{r.why.includes('mentioned') ? 'Mentioned you' : 'Teammate PR'}</span></div><b className="overview-review-title">{r.title}</b><span className="overview-sub">{r.repo} #{r.id}{r.author ? ` · ${r.author}` : ''}</span></div>
                      <a className="btn sm" href={`#/prs/${r.repo}/${r.id}`}>Open</a>
                    </div>
                  ))}
                  {!reviews.data.items.some((r) => !r.approvedByMe) && <div className="empty">No reviews waiting on you.</div>}
                </>}
              </div>
            </section>
          </div>
          <div className="sectionbar"><h2>Recent sessions</h2><a className="text-action" href="#/activity">All activity →</a></div>
          {error ? <p className="error">Could not read sessions: {error}</p> : !sessions ? <div className="empty">Reading sessions…</div> : !sessions.length ? <div className="empty">No recent sessions.</div> : (
            <div className="section-list">
              {sessions.slice(0, 5).map((s) => (
                <a key={s.id} className="row link" href={`#/sessions/${s.id}`}>
                  <div className="copy"><b>{s.title}</b><span>{s.ticket && <TicketChip ticket={s.ticket} />} {projectName(s.cwd)} · {s.turns} prompt{s.turns === 1 ? '' : 's'} · {ago(s.lastActivityAt, now)}</span></div><span className="text-action">Open →</span>
                </a>
              ))}
            </div>
          )}
          <p className="footnote">Statuses come from live runs and your local transcripts. Costs are Claude Code's own API-equivalent estimates.</p>
        </div>
      </div>
    </Frame>
  );
}

function RunDetail({ run, live, now, items }: { run: Run; live: Live; now: number; items: WorkItem[] }) {
  const tone = runTone(run);
  const pending = [...live.decisions.values()].filter((d) => d.runId === run.id).length;
  const c = calloutOf(run, pending, now);
  const ev = evidenceOf(run, now);
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
            <span className="overview-tag">{runStage(run, items)}</span>
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
        <div className="evidence-row"><span>Pipeline</span><b>{runStage(run, items)}</b></div>
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
      {run.ticket && <div className="detail-foot"><a className="btn sm" href={workHref(run.ticket)}>Open work item →</a></div>}
    </div>
  );
}

const stageLabel = { backlog: 'Backlog', shaping: 'Shaping', spec_review: 'Spec review', building: 'Building', pr_review: 'PR review', ready: 'Ready to merge', done: 'Done' };
const workHref = (ticket: string) => `#/work/${encodeURIComponent(ticket)}`;
function runStage(run: Run, items: WorkItem[]) {
  const repo = items.find((item) => item.ticket === run.ticket)?.repos.find((repo) => repo.name === run.repo);
  return repo ? stageLabel[repo.stage] : run.stage === 'design' ? 'Spec' : run.stage === 'build' ? 'Build' : run.kind === 'chat' ? 'Chat' : 'Task';
}
