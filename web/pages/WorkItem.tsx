import { useContext, useState } from 'react';
import type { Persona, PipelineStage, PlanTask, Run } from '../../shared/types.ts';
import { ago, api, useFetch, useNow } from '../api.ts';
import { Chrome, Frame, type Live } from '../chrome.tsx';
import './WorkItem.css';

const STAGES: PipelineStage[] = ['backlog', 'shaping', 'spec_review', 'building', 'pr_review', 'ready', 'done'];
const PERSONAS = { foreman: 'Foreman', builder: 'Builder', inspector: 'Inspector', cataloger: 'Cataloger' };
const STEPS: { label: string; personas: Persona[]; gate?: string; stages: PipelineStage[] }[] = [
  { label: 'Brainstorm', personas: ['foreman'], gate: 'Optional', stages: [] },
  { label: 'Spec', personas: ['foreman'], gate: 'You', stages: ['shaping', 'spec_review'] },
  { label: 'Build + agent review', personas: ['builder', 'inspector'], stages: ['building'] },
  { label: 'PR review', personas: [], gate: 'If routed', stages: ['pr_review'] },
  { label: 'Merge', personas: [], gate: 'You', stages: ['ready'] },
  { label: 'Ready for QA', personas: [], stages: ['done'] },
  { label: 'Catalog', personas: ['cataloger'], stages: [] },
];

export function flowColumns(tasks: PlanTask[]): PlanTask[][] {
  const columns: PlanTask[][] = [];
  const placed = new Set<string>();
  let pending = [...tasks];
  while (pending.length) {
    const column = pending.filter((t) => t.needs.every((id) => placed.has(id)));
    if (!column.length) return [...columns, pending];
    columns.push(column);
    column.forEach((t) => placed.add(t.id));
    pending = pending.filter((t) => !placed.has(t.id));
  }
  return columns;
}

function PersonaBadge({ persona }: { persona: Run['persona'] }) {
  return <span className="wi-persona"><span className={`wi-avatar ${persona ?? 'unknown'}`}>{persona ? PERSONAS[persona][0] : '?'}</span>{persona ? PERSONAS[persona] : 'Persona unavailable'}</span>;
}

const cost = (value: number | null) => value === null ? '— est. (unpriced)' : `$${value.toFixed(2)} est.`;
const prHref = (repo: string, id: number) => `#/prs/${repo.split('/').map(encodeURIComponent).join('/')}/${id}`;

export function WorkItem({ ticket, live }: { ticket: string; live: Live }) {
  const now = useNow(15000);
  const chrome = useContext(Chrome);
  const items = useFetch(api.workItems, [ticket, now]);
  const item = items.data?.items.find((i) => i.ticket === ticket);
  const issue = useFetch(() => item?.source === 'jira' ? api.jiraIssue(ticket) : Promise.resolve(null), [ticket, item?.source]);
  const automation = useFetch(api.automation, []);
  const activity = useFetch(() => api.myActivity(30), [ticket, now]);
  const jira = issue.data?.key === ticket ? issue.data : null;
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string[]>([]);
  const observed = new Map((activity.data?.items ?? []).filter((r) => r.ticket === ticket).map((r) => [r.runId, { ...r, id: r.runId, task: null as string | null, persona: null as Run['persona'], owner: null as string | null }]));
  for (const run of live.runs.values()) {
    if (run.ticket === ticket) observed.set(run.id, { ...run, runId: run.id, title: run.prompt, project: run.repo ?? '' });
  }
  const runs = [...observed.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const runIds = new Set(runs.map((r) => r.id));
  const decisions = [...live.decisions.values()].filter((d) => runIds.has(d.runId) && !answered.includes(d.id));
  const stage = item?.repos.length ? item.repos.reduce((slowest, repo) => STAGES.indexOf(repo.stage) < STAGES.indexOf(slowest) ? repo.stage : slowest, item.repos[0].stage) : null;
  const tasks = item?.plan?.tasks ?? [];
  const failed = tasks.filter((t) => t.state === 'failed');
  const priced = runs.filter((r) => r.estimatedCostUsd !== null);
  const knownCost = priced.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
  const activeRules = automation.data?.routing.filter((r) => r.on) ?? [];
  const act = async (id: string, request: () => Promise<unknown>, dismiss = false) => {
    if (busy) return;
    setBusy(id);
    setActionError(null);
    try {
      await request();
      if (dismiss) setAnswered((ids) => [...ids, id]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Frame crumb={<><a href="#/work">Work</a> / <span>{ticket}</span></>}>
      <div className="scroll"><div className="page work-item-page">
        <header className="wi-header">
          <div className="wi-heading">
            <div className="wi-inline"><span className="wi-ticket mono">{ticket}</span>{item && <span className="wi-state">{item.source === 'jira' ? 'Jira' : 'Local'}</span>}{(jira?.status ?? item?.status) && <span className="wi-state">{jira?.status ?? item?.status}</span>}</div>
            <h1>{jira?.summary ?? (item?.source === 'local' ? 'Local work item' : 'Work item')}</h1>
            {jira ? <p className="wi-meta">{[jira.issueType, jira.priority, jira.reporter && `reported by ${jira.reporter}`, jira.assignee && `assigned to ${jira.assignee}`].filter(Boolean).join(' · ')}</p> : <p className="wi-meta">{issue.error ?? (item?.source === 'local' ? 'Title unavailable: local work items do not provide a title.' : 'Ticket details unavailable.')}</p>}
          </div>
          <div className="wi-actions">
            {jira?.url && <a className="btn" href={jira.url} target="_blank" rel="noreferrer">Open in Jira ↗</a>}
            <button className="btn" disabled title="Tracked brainstorm launch is not available in the current contract">Brainstorm</button>
          </div>
        </header>
        {items.error && <p className="error" role="alert">{items.error}</p>}
        {!items.data && !items.error && <p role="status">Loading work item…</p>}
        {items.data && !item && <p className="empty">No tracked work item found for {ticket}.</p>}
        {item && <>
          <section className="wi-panel wi-stepper" aria-label="Ticket stages">
            {STEPS.map((step) => {
              const current = !!stage && step.stages.includes(stage);
              const personaRun = runs.find((r) => r.persona && step.personas.some((p) => p === r.persona) && ['starting', 'running', 'awaiting_decision'].includes(r.status));
              return <div className={`wi-step ${current ? 'current' : ''}`} key={step.label} aria-current={current ? 'step' : undefined}>
                <div className="wi-bar" />
                <b>{step.label} {step.gate && <span className="wi-gate">{step.gate}</span>}</b>
                <div className="wi-inline">{step.personas.map((p) => <PersonaBadge key={p} persona={p} />)}</div>
                <span className="wi-meta">{current ? `Repo stage: ${stage}` : step.label === 'Brainstorm' ? 'History unavailable' : step.label === 'Catalog' && personaRun ? `Live run: ${personaRun.status}` : '—'}</span>
              </div>;
            })}
          </section>
          <p className="wi-meta">Slowest repo: {stage ?? '—'}. Historical gate approvals, brainstorm outcomes and QA transitions are unavailable.</p>
          {decisions.map((d) => {
            const run = live.runs.get(d.runId)!;
            const command = d.toolName === 'Bash' && typeof d.input.command === 'string' ? d.input.command : null;
            return <section className="wi-paused" key={d.id} aria-label="Paused run">
              <div className="wi-paused-copy"><b>{run.persona ? PERSONAS[run.persona] : 'Agent (persona unavailable)'} on {run.task ?? 'task unavailable'} ({run.repo ?? 'repo unavailable'}) is paused</b><span>{command ? <code>{command}</code> : d.title ?? d.toolName} · {d.reason ?? 'Waiting for your decision'} · {ago(d.createdAt, now)}</span></div>
              <button className="btn" disabled={busy !== null || live.conn !== 'connected'} onClick={() => act(d.id, () => api.end(run.id), true)}>Stop run</button>
              {command ? <>
                {chrome.me.isOwner === true && <button className="btn" disabled={busy !== null || live.conn !== 'connected'} onClick={() => act(d.id, () => api.answer(d.id, { behavior: 'allow' }, true), true)}>Add to allowlist</button>}
                <button className="btn primary" disabled={busy !== null || live.conn !== 'connected'} onClick={() => act(d.id, () => api.answer(d.id, { behavior: 'allow' }), true)}>Allow once</button>
              </> : <button className="btn primary" disabled={busy !== null || live.conn !== 'connected'} onClick={() => chrome.review(d.id)}>Review request</button>}
            </section>;
          })}
          {actionError && <p className="error" role="alert">{actionError}</p>}
          {!!failed.length && <div className="wi-paused" role="status"><b>Escalated · {failed.map((t) => t.id).join(', ')}</b><span>These plan tasks failed and need a person. <a href="#/reviews">Open Reviews →</a></span></div>}
          <div className="wi-body">
            <section className="wi-panel wi-flow" aria-label="Ticket flow">
              <div className="wi-section-head"><h2>Flow</h2><span className="wi-meta">{item.plan ? `${tasks.length} tasks · one plan across repos` : 'No task plan is available'}</span><div className="wi-legend">{['done', 'running', 'paused', 'next'].map((state) => <span key={state}><i className={`wi-dot ${state}`} />{state}</span>)}</div></div>
              {item.plan?.error && <p className="wi-warning">Plan fallback: {item.plan.error}</p>}
              <div className="wi-graph-scroll" tabIndex={0} aria-label="Flow graph, columns by dependency depth">
                <div className="wi-graph">
                  {item.plan ? flowColumns(tasks).map((column, index) => <div className="wi-wave" key={index}>
                    <div className="wi-column" aria-label={`Dependency depth ${index}`}>
                      {column.map((t) => <article className={`wi-node ${t.state}`} key={t.id}>
                        <div className="wi-node-head"><b className="mono">{t.id}</b><span className="wi-state">{t.state}</span><span className="wi-repo" title={t.repo}>{t.repo}</span></div>
                        <b>{t.do}</b><span className="wi-meta mono">needs {t.needs.join(', ') || '—'}</span><PersonaBadge persona="builder" />
                      </article>)}
                    </div><span className="wi-arrow" aria-hidden="true">→</span>
                  </div>) : item.repos.map((repo) => <div className="wi-wave" key={repo.name}><article className="wi-node fallback"><b className="mono">{repo.name}</b><span>Repo stage: {repo.stage}</span><span className="wi-meta">Task state unavailable</span><PersonaBadge persona="builder" /></article><span className="wi-arrow" aria-hidden="true">→</span></div>)}
                  <section className="wi-prbox" aria-label="Pull requests"><div className="wi-section-head"><h3>Pull requests</h3><span className="wi-meta">per repo</span></div>
                    {item.repos.map((repo) => {
                      const links = item.links.filter((l) => l.repo === repo.name && l.kind === 'impl');
                      const ids = tasks.filter((t) => t.repo === repo.name).map((t) => t.id);
                      return <div className="wi-pr-row" key={repo.name}><b className="wi-repo">{repo.name}</b>
                        {links.length ? links.map((link) => <div className="wi-inline" key={link.prId}><a href={prHref(link.repo, link.prId)} title={link.title}>#{link.prId}</a><span className="wi-state">{link.state}</span></div>) : <span className="wi-meta">PR not yet linked</span>}
                        <span className="wi-meta">Plan tasks: {ids.join(', ') || 'unavailable'}</span><span className="wi-meta">{repo.stage} · attempt {repo.attempt}</span>
                      </div>;
                    })}
                    {!item.repos.length && <span className="wi-meta">No repos attached.</span>}
                  </section>
                </div>
              </div>
              <p className="wi-meta">Columns run left to right by dependency depth. Parallel execution also requires disjoint files and workspace settings. Plan task associations do not verify a PR’s contents.</p>
              <div className="wi-runs"><h2>Runs <span className="wi-meta">last 30 days + live</span></h2>{runs.map((r) => <div className="wi-runrow" key={r.id}>
                <span className={`wi-state ${r.status}`}>{r.status === 'awaiting_decision' ? 'paused' : r.status}</span><div className="wi-run-title"><PersonaBadge persona={r.persona} /><b>{r.task ?? 'Task unavailable'}</b><span className="wi-repo">{r.repo ?? 'Repo unavailable'}</span></div><span className="wi-meta">{r.model ?? 'Model unavailable'} · {ago(r.startedAt, now)} · {cost(r.estimatedCostUsd)}</span><a href={`#/runs/${encodeURIComponent(r.id)}`}>Open →</a>
              </div>)}{activity.error && <p className="error">Historical runs: {activity.error}</p>}{!runs.length && <p className="wi-meta">No runs in the last 30 days or the live snapshot.</p>}<p className="wi-meta">Historical task and persona data are unavailable. <a href="#/activity">Earlier runs in Activity →</a></p></div>
            </section>
            <aside className="wi-aside">
              <section className="wi-panel"><h2>When this needs a person</h2><p>A PR goes to you if any rule matches. The Inspector may add a reason, never remove one.</p>
                {automation.error ? <p className="error">{automation.error}</p> : !automation.data ? <p className="wi-meta">Loading workspace rules…</p> : activeRules.length ? <ul className="wi-rules">{activeRules.map((rule) => <li key={rule.id}>{rule.kind}: <code>{rule.value}</code></li>)}</ul> : <p className="wi-meta">No active workspace rules.</p>}
                <p className="wi-meta">Matched routing reasons are unavailable for this work item.</p><a href="#/settings">Workspace rules →</a>
              </section>
              <section className="wi-panel"><h2>What happened</h2>
                {item.note && <div className="wi-event"><span className="wi-avatar unknown">?</span><div><b>{item.note.text}</b><p className="wi-meta">Actor unavailable · {ago(item.note.at, now)}</p></div></div>}
                {runs.slice(0, 5).map((r) => <div className="wi-event" key={r.id}><PersonaBadge persona={r.persona} /><div><a href={`#/runs/${encodeURIComponent(r.id)}`}>{r.task ?? 'Task unavailable'} · {r.status}</a><p className="wi-meta">Run owner: {r.owner ?? 'unavailable'} · {ago(r.lastEventAt ?? r.startedAt, now)}</p></div></div>)}
                <p className="wi-meta">Latest observed run states and sync note. Event actors and gate history are unavailable.</p>
              </section>
              <section className="wi-panel"><h2>Cost so far</h2><b className="wi-total">{priced.length ? cost(knownCost) : '— est.'}</b><p className="wi-meta">{priced.length ? `Known subtotal from ${priced.length} of ${runs.length} observed runs (last 30 days + live).` : 'No priced runs available.'} Lifetime total is unavailable; unpriced runs are excluded. API-equivalent estimate, never an invoice.</p></section>
            </aside>
          </div>
        </>}
      </div></div>
    </Frame>
  );
}
