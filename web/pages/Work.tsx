import { useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { PipelineStage } from '../../shared/types.ts';
import { api, useFetch, type JiraRow, type WorkItem } from '../api.ts';
import { Chrome, Frame, initials } from '../chrome.tsx';
import './Work.css';

type BoardItem = WorkItem & { owner?: { id: string; name: string | null; email: string | null } };

const STAGES: PipelineStage[] = ['backlog', 'shaping', 'spec_review', 'building', 'pr_review', 'ready', 'done'];

type Column = { stage: PipelineStage; name: string; dot: string; hint: string; gate?: boolean };

const COLUMNS: Column[] = [
  { stage: 'backlog', name: 'Backlog', dot: '#cdd1dc', hint: 'From Jira, or created here' },
  { stage: 'shaping', name: 'Shaping', dot: '#a6adbd', hint: 'Brainstorm and spec draft' },
  { stage: 'spec_review', name: 'Spec review', dot: '#8f87f5', hint: 'A person approves the spec', gate: true },
  { stage: 'building', name: 'Building', dot: '#6259db', hint: 'Build and agent review, on their own' },
  { stage: 'pr_review', name: 'PR review', dot: '#c98a2e', hint: 'Rules routed it to a person', gate: true },
  { stage: 'ready', name: 'Ready to merge', dot: '#3d7bd9', hint: 'Low risk, passed agent review' },
  { stage: 'done', name: 'Done', dot: '#2f9c74', hint: 'Merged; Jira at Ready for QA' },
];

const REPO_STATE: Record<PipelineStage, { label: string; tone: string }> = {
  backlog: { label: 'backlog', tone: 'off' },
  shaping: { label: 'shaping', tone: 'run' },
  spec_review: { label: 'spec review', tone: 'watch' },
  building: { label: 'building', tone: 'run' },
  pr_review: { label: 'to you', tone: 'watch' },
  ready: { label: 'ready', tone: 'good' },
  done: { label: 'merged', tone: 'good' },
};

const NEXT: Partial<Record<PipelineStage, string>> = {
  shaping: 'Reply',
  spec_review: 'Review spec',
  building: 'Watch',
  pr_review: 'Review',
  ready: 'Merge',
  done: 'Open',
};

const SOURCES = [
  { value: 'mine', label: 'Backlog: assigned to me' },
  { value: 'projects', label: 'Backlog: my projects' },
  { value: 'sprint', label: 'Backlog: current sprint' },
] as const;

type Source = (typeof SOURCES)[number]['value'];

type Card = {
  key: string;
  src: 'Jira' | 'Local';
  title: string | null;
  repos: { name: string; state: string; tone: string }[];
  href: string;
  next?: string;
  start?: JiraRow;
  meta?: string;
  who?: { initials: string; name: string };
};

const workHref = (ticket: string) => `#/work/${encodeURIComponent(ticket)}`;

// A ticket sits in the stage of its slowest repo: the earliest stage any of its repos reached.
function stageOf(item: WorkItem): PipelineStage {
  if (!item.repos.length) return 'shaping';
  return item.repos.reduce((slowest, repo) => (STAGES.indexOf(repo.stage) < STAGES.indexOf(slowest) ? repo.stage : slowest), item.repos[0].stage);
}

function repoRows(item: WorkItem): Card['repos'] {
  return item.repos.map((repo) => {
    const of = (kind: 'impl' | 'spec') => item.links.filter((l) => l.kind === kind && l.repo.toLowerCase() === repo.name.toLowerCase()).pop();
    const impl = of('impl');
    const spec = repo.stage === 'spec_review' ? of('spec') : undefined;
    const pr = impl ?? spec;
    const state = REPO_STATE[repo.stage];
    return { name: repo.name, state: pr ? `#${pr.prId}` : state.label, tone: impl?.state === 'DECLINED' ? 'bad' : state.tone };
  });
}

// Jira summaries are fetched once per ticket and kept: the board must not refetch on every render.
function useSummaries(keys: string[]) {
  const cache = useRef(new Map<string, string | null>());
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    for (const key of keys) {
      if (cache.current.has(key)) continue;
      cache.current.set(key, null);
      api.jiraIssue(key).then(
        (issue) => {
          cache.current.set(key, issue.summary || null);
          bump();
        },
        () => {
          cache.current.set(key, null);
          bump();
        },
      );
    }
  }, [keys.join(' ')]);
  return cache.current;
}

function WorkCard({ card, readOnly, onStart }: { card: Card; readOnly: boolean; onStart: (row: JiraRow) => void }) {
  return (
    <div className="work-card">
      <div className="work-card-head">
        <span className="ticket-chip">{card.key}</span>
        <span className="work-src">{card.src}</span>
        {card.who && (
          <span className="work-who" title={card.who.name}>
            {card.who.initials}
          </span>
        )}
      </div>
      <a className="work-title" href={card.href}>
        {card.title ?? 'Title unavailable'}
      </a>
      {card.repos.map((repo) => (
        <div className="work-repo" key={repo.name}>
          <span title={repo.name}>{repo.name}</span>
          <span className={`work-pill tone-${repo.tone}`}>{repo.state}</span>
        </div>
      ))}
      {!readOnly && card.meta && (
        <div className="work-foot">
          <span className="work-meta">{card.meta}</span>
          {card.start && (
            <button className="btn sm" onClick={() => onStart(card.start!)}>
              Start
            </button>
          )}
        </div>
      )}
      {!readOnly && card.next && (
        <a className="work-next" href={card.href}>
          {card.next} →
        </a>
      )}
    </div>
  );
}

export function Work({ onStart }: { onStart: (ticket: JiraRow) => void }) {
  const { me } = useContext(Chrome);
  const isOwner = !!me.isOwner;
  const [scope, setScope] = useState<'mine' | 'team'>('mine');
  const [source, setSource] = useState<Source>('mine');
  const [q, setQ] = useState('');
  const readOnly = scope === 'team';

  const work = useFetch(() => (readOnly ? api.teamWorkItems() : api.workItems()), [scope]);
  const mine = useFetch(api.myRepos, []);
  const projects = useMemo(() => [...new Set((mine.data?.repos ?? []).flatMap((r) => r.projects))], [mine.data]);
  const jql = projects.length ? `project in (${projects.join(',')})` : null;
  const backlog = useFetch(
    () =>
      source === 'mine'
        ? api.jiraIssues('mine')
        : source === 'sprint'
          ? api.jiraIssues('sprint')
          : jql
            ? api.jiraSearch(jql)
            : Promise.resolve({ issues: [] as JiraRow[], nextPageToken: null }),
    [source, jql],
  );

  useEffect(() => {
    const refresh = () => document.visibilityState === 'visible' && work.reload();
    const t = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const items: BoardItem[] = work.data?.items ?? [];
  const summaries = useSummaries(useMemo(() => items.filter((i) => i.source === 'jira').map((i) => i.ticket), [items]));

  const started = new Set(items.map((i) => i.ticket.toUpperCase()));
  const jiraCards: Card[] = (backlog.data?.issues ?? [])
    .filter((row) => !started.has(row.key.toUpperCase()))
    .map((row) => ({
      key: row.key,
      src: 'Jira',
      title: row.summary || null,
      repos: [],
      href: workHref(row.key),
      start: row,
      meta: [row.status, row.priority].filter(Boolean).join(' · ') || '—',
    }));

  const itemCards = items.map((item): { card: Card; stage: PipelineStage } => {
    const stage = stageOf(item);
    const who = item.owner ? item.owner.name || item.owner.email || item.owner.id : null;
    return {
      stage,
      card: {
        key: item.ticket,
        src: item.source === 'local' ? 'Local' : 'Jira',
        title: item.source === 'local' ? null : summaries.get(item.ticket) ?? null,
        repos: repoRows(item),
        href: workHref(item.ticket),
        next: NEXT[stage],
        meta: stage === 'backlog' ? (item.source === 'local' ? 'created here' : item.status ?? '—') : undefined,
        who: who ? { initials: initials(who), name: who } : undefined,
      },
    };
  });

  const needle = q.trim().toLowerCase();
  const matches = (card: Card) => !needle || [card.key, card.title ?? '', ...card.repos.map((r) => r.name)].some((s) => s.toLowerCase().includes(needle));

  const columns = COLUMNS.map((col) => {
    const cards =
      col.stage === 'backlog'
        ? [...jiraCards, ...itemCards.filter((i) => i.stage === 'backlog').map((i) => i.card)]
        : itemCards.filter((i) => i.stage === col.stage).map((i) => i.card);
    return { ...col, cards: cards.filter(matches) };
  });

  const loaded = !!work.data && !!backlog.data;
  const total = columns.reduce((n, col) => n + col.cards.length, 0);
  const scopeNote = !isOwner ? 'Showing your work' : readOnly ? 'Showing everyone in this workspace' : 'Showing your work · Team view is for owners';

  return (
    <Frame
      crumb={
        <>
          <span>Workspace / </span>Work
        </>
      }
    >
      <div className="scroll">
        <div className="page work-page">
          <div className="page-heading">
            <div>
              <h1>Work</h1>
              <p className="lead">Every ticket, from backlog to done. Columns marked You are gates; the rest runs on its own.</p>
            </div>
            <a className="btn primary" href="#/work">
              + New task
            </a>
          </div>

          <div className="work-toolbar">
            {isOwner && (
              <div className="segmented" role="tablist" aria-label="Whose work">
                <button role="tab" aria-selected={!readOnly} className={!readOnly ? 'active' : ''} onClick={() => setScope('mine')}>
                  Mine
                </button>
                <button role="tab" aria-selected={readOnly} className={readOnly ? 'active' : ''} onClick={() => setScope('team')}>
                  Team
                </button>
              </div>
            )}
            <input className="input" type="search" placeholder="Filter by key, title or repo" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="input" aria-label="Backlog source" value={source} onChange={(e) => setSource(e.target.value as Source)}>
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className="work-scope">{scopeNote}</span>
          </div>

          {work.error && <p className="error">Could not read the board: {work.error}</p>}
          {backlog.error && <p className="error">Could not read Jira: {backlog.error}</p>}

          <div className="work-board">
            {columns.map((col) => (
              <section className="work-col" key={col.stage} aria-label={col.name}>
                <div className="work-col-head">
                  <span className="work-dot" style={{ background: col.dot }} />
                  <h2>{col.name}</h2>
                  <span className="work-count">{loaded ? col.cards.length : '—'}</span>
                  {col.gate && <span className="work-gate">You</span>}
                </div>
                <span className="work-hint">{col.hint}</span>
                {col.stage === 'backlog' && source === 'projects' && !jql && (
                  <div className="empty">No Jira projects mapped to your repos yet. Map a project to a repo in Settings.</div>
                )}
                {col.cards.map((card) => (
                  <WorkCard key={card.key} card={card} readOnly={readOnly} onStart={onStart} />
                ))}
              </section>
            ))}
          </div>

          {loaded && total === 0 && <div className="empty">Nothing on the board. Start a task with a ticket and it shows up here.</div>}
          <p className="footnote">Columns follow the factory stages: a ticket sits in the stage of its slowest repo. Titles come from Jira; a ticket the app cannot read shows “Title unavailable”.</p>
        </div>
      </div>
    </Frame>
  );
}
