import { useEffect, useState, type KeyboardEvent } from 'react';
import { api, ago, storage, useFetch, useNow, type ReviewRequest, type RoutingInfo, type WorkItem, type PrComment, type FixQueue } from '../api.ts';
import { Empty } from '../components.tsx';
import { Frame } from '../chrome.tsx';
import './Reviews.css';

// The ARIA tabs pattern: arrows move focus around the tablist, wrapping; Home and End jump to the ends.
function tabStep(key: string, index: number, count: number): number | null {
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index + count - 1) % count;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

// automatic activation: moving focus with the arrows also selects that tab
const onTabKey = (index: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
  const tabs = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  const next = tabs ? tabStep(e.key, index, tabs.length) : null;
  if (next === null) return;
  e.preventDefault();
  tabs?.item(next).focus();
  tabs?.item(next).click();
};

function Teammates() {
  const now = useNow(60000);
  const [refresh, setRefresh] = useState(0);
  const { data, error } = useFetch(() => api.reviews(refresh > 0), [refresh]);
  const [loading, setLoading] = useState(false);
  useEffect(() => setLoading(false), [data, error]);
  const reload = () => (setLoading(true), setRefresh((n) => n + 1));
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(() => storage('lf:bb-name') ?? '');
  const saveName = () => {
    storage('lf:bb-name', name.trim());
    setNaming(false);
    reload();
  };
  const noRepos = /repos you review/.test(error ?? '');
  const rows: ReviewRequest[] = data?.items ?? [];
  const todo = rows.filter((p) => !p.approvedByMe);
  return (
    <section className="reviews-team">
          <div className="reviews-team-heading"><h2>Teammates</h2><button className="btn sm ghost" disabled={loading} onClick={reload}>{loading ? 'Checking…' : 'Refresh'}</button></div>
          {error && !noRepos && (
            <p className="error">
              {error}
              {/workbench in Settings/.test(error) && (
                <>
                  {' '}
                  <a href="#/settings">Open Settings</a>
                </>
              )}
            </p>
          )}
          {(naming || /Bitbucket name/.test(error ?? '')) && (
            <div className="pr-box name-box">
              <label className="field">
                Your name in Bitbucket, exactly as reviewers see it (leave empty to use the one from your email)
                <input className="input" value={name} placeholder="e.g. Jane Doe" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveName()} />
              </label>
              <div className="pr-reply-actions">
                <button type="button" className="btn sm ghost" onClick={() => setNaming(false)}>
                  Cancel
                </button>
                <button type="button" className="btn sm primary" onClick={saveName}>
                  Save
                </button>
              </div>
            </div>
          )}
          {noRepos ? (
            <Empty>
              Add the repos you review in <a href="#/settings">Settings</a>.
            </Empty>
          ) : !data ? (
            !error && <Empty>Looking through your repos' open pull requests…</Empty>
          ) : rows.length === 0 ? (
            <Empty>Nothing is waiting on you.</Empty>
          ) : (
            <>
              <h2 className="section-title">
                To review <span className="muted">· {todo.length}</span>
              </h2>
              <div className="list-card">
                {[...todo, ...rows.filter((p) => p.approvedByMe)].map((p) => (
                  <a key={`${p.repo}#${p.id}`} className="list-item review-row" href={`#/prs/${p.repo}/${p.id}`}>
                    <span className={`dev-chip tone-${p.approvedByMe ? 'good' : 'run'}`}>{p.approvedByMe ? '✓ approved' : 'to review'}</span>
                    <div className="copy">
                      <b className="ellipsis" title={p.title}>
                        {p.title}
                      </b>
                      <span>
                        <span className="mono">
                          {p.repo} #{p.id}
                        </span>
                        {p.why.map((w) => (
                          <span key={w} className="dev-chip tone-off">
                            {w === 'reviewer' ? 'reviewer' : 'mentioned'}
                          </span>
                        ))}
                        <span className="row-meta">
                          {[p.author, `${p.comments} comment${p.comments === 1 ? '' : 's'}`, p.updated && `updated ${ago(p.updated, now)}`].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </div>
                  </a>
                ))}
              </div>
            </>
          )}
          {data && (
            <p className="footnote">
              Checked the {data.scanned} most recently updated open PRs in your {data.searched.length} repo{data.searched.length === 1 ? '' : 's'}, matching you as “{data.me}”{data.matchedById ? ' by Bitbucket account' : ' by name'} (
              <button type="button" className="text-action" onClick={() => setNaming(true)}>
                change
              </button>
              ) · {ago(data.at, now)}.
            </p>
          )}
          {data && data.failed.length > 0 && (
            <p className="footnote">
              Couldn't read {data.failed.length} PR{data.failed.length === 1 ? '' : 's'} ({data.failed.join(', ')}); they may be missing above.
            </p>
          )}
    </section>
  );
}


type Gate = { item: WorkItem; repo: WorkItem['repos'][number] };

// shared/types.ts has no routing field yet: the pipeline branch adds it per repo.
const routingOf = (item: WorkItem) => (item as WorkItem & { routing?: Record<string, RoutingInfo> | null }).routing ?? null;

function GatePrStats({ repo, prId, spec }: { repo: string; prId: number; spec: boolean }) {
  const { data } = useFetch(() => api.pr(repo, prId), [repo, prId]);
  const files = data?.files ?? [];
  if (!files.length) return null;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const count = files.length;
  return <>{spec ? ` · ${count} file${count === 1 ? '' : 's'} · ${added + removed} lines` : ` · +${added} −${removed} · ${count} file${count === 1 ? '' : 's'}`}</>;
}

function FactoryGates({ items, reload }: { items: WorkItem[]; reload: () => void }) {
  const now = useNow(60000);
  const gates: Gate[] = items.flatMap((item) => item.repos.filter((repo) => repo.stage === 'spec_review' || repo.stage === 'pr_review').map((repo) => ({ item, repo })));
  const [picked, setPicked] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'approve' | 'changes' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const gate = gates.find(({ item, repo }) => `${item.ticket}/${repo.name}` === picked) ?? gates[0];
  if (!gate) return <Empty>No factory gates are waiting on you.</Empty>;
  const { item, repo } = gate;
  const spec = repo.stage === 'spec_review';
  const link = item.links.find((l) => l.repo === repo.name && l.kind === (spec ? 'spec' : 'impl') && l.state === 'OPEN');
  const info = routingOf(item)?.[repo.name] ?? null;
  const matches = info?.matches ?? [];
  const inspectorReasons = info?.inspectorReasons ?? [];
  const plainReasons = matches.length || inspectorReasons.length ? [] : info?.reasons ?? [];
  const findings = info?.findings ?? '';
  const hasRouting = !!(matches.length || inspectorReasons.length || plainReasons.length || findings);
  const approve = async () => {
    if (busy) return;
    setBusy('approve');
    setError(null);
    setStatus(null);
    try {
      if (spec) await api.approveSpec(item.ticket);
      else await api.approvePr(item.ticket, repo.name);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const requestChanges = async () => {
    if (busy || !comment.trim()) return;
    setBusy('changes');
    setError(null);
    setStatus(null);
    try {
      if (spec) await api.requestSpecChanges(item.ticket, comment.trim());
      else await api.requestPrChanges(item.ticket, repo.name, comment.trim());
      setComment('');
      setStatus('The change request was sent to the agent.');
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return <div className="reviews-gates">
    <div className="reviews-gate-list">
      {gates.map((g) => {
        const key = `${g.item.ticket}/${g.repo.name}`;
        const isSpec = g.repo.stage === 'spec_review';
        const pr = g.item.links.find((l) => l.repo === g.repo.name && l.kind === (isSpec ? 'spec' : 'impl') && l.state === 'OPEN');
        const gInfo = routingOf(g.item)?.[g.repo.name] ?? null;
        const rules = gInfo?.matches ?? [];
        const raised = gInfo?.inspectorReasons ?? [];
        return <button type="button" className={`reviews-gate-row${g === gate ? ' selected' : ''}`} key={key} aria-pressed={g === gate} disabled={busy !== null} onClick={() => { setPicked(key); setError(null); setStatus(null); setComment(''); }}>
          <span className={`reviews-dot ${isSpec ? 'spec' : 'pr'}`} />
          <span className="reviews-row-copy">
            <span className="reviews-row-head"><span className={`reviews-tag ${isSpec ? 'spec' : 'pr'}`}>{isSpec ? 'Spec' : 'PR'}</span> <span className="mono">{g.item.ticket}</span> <span className="reviews-gate-you">You</span>{pr?.updatedAt && <span className="muted">{ago(pr.updatedAt, now)}</span>}</span>
            <b>{pr?.title ?? g.item.ticket}</b>
            <span className="muted mono">{g.repo.name}{pr ? ` #${pr.prId}` : ' · PR unavailable'}{pr && <GatePrStats repo={g.repo.name} prId={pr.prId} spec={isSpec} />}</span>
            {(rules.length || raised.length) > 0 && <span className="reviews-chips">{rules.map((m) => <span key={m.id} className="reviews-rule">rule: {m.reason}</span>)}{raised.map((r, i) => <span key={i} className="reviews-rule agent">agent raised: {r}</span>)}</span>}
          </span>
        </button>;
      })}
    </div>
    <section className="reviews-detail" aria-label={`${spec ? 'Spec' : 'PR'} ${item.ticket}`}>
      <div><span className={`reviews-tag ${spec ? 'spec' : 'pr'}`}>{spec ? 'Spec review' : 'PR review'}</span> <span className="mono muted">{repo.name}{link && ` #${link.prId}`}</span></div>
      <h2>{link?.title ?? item.ticket}</h2>
      {spec ? <div className="reviews-summary"><b>Plan</b>{item.plan ? <><span>{item.plan.tasks.length} task{item.plan.tasks.length === 1 ? '' : 's'} across {item.repos.length} repo{item.repos.length === 1 ? '' : 's'}.</span>{item.plan.error && <p className="error">{item.plan.error}</p>}</> : <span>— No plan is available.</span>}<a href={`#/work/${encodeURIComponent(item.ticket)}`}>Open work item</a></div> : <>
        {hasRouting ? <div className="reviews-routing">
          <b>Why this came to you</b>
          {matches.map((m) => <span key={m.id}>Rule {m.id} matched — {m.reason}</span>)}
          {inspectorReasons.map((r, i) => <span key={i}>Inspector — {r}</span>)}
          {plainReasons.map((r, i) => <span key={i}>{r}</span>)}
          {findings ? <span>Inspector findings: {findings}</span> : null}
        </div> : <p className="muted">No routing reasons yet.</p>}
        <div className="reviews-summary"><b>Agent review</b><span>Review attempt: {repo.attempt}</span>{findings ? null : <span>— Findings are unavailable.</span>}</div>
      </>}
      <label className="field">Comment for the agent (required for changes)<textarea className="input" rows={3} value={comment} disabled={busy !== null} onChange={(e) => setComment(e.target.value)} placeholder="Describe what needs to change" /></label>
      <p className="muted">{spec ? 'Request changes sends the comment back to the Foreman: it revises the spec on the same PR and the spec comes back to you.' : 'Request changes sends the comment back to the Builder: it revises the PR on the same branch and the Inspector reviews again. Nothing is merged automatically.'}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {status && <p className="muted" role="status">{status}</p>}
      <div className="reviews-actions">{link && <a className="btn" href={`#/prs/${link.repo}/${link.prId}`}>{spec ? 'Open full PR' : 'Open diff'}</a>}<button type="button" className="btn" disabled={busy !== null || !comment.trim()} title={comment.trim() ? undefined : 'Write what needs to change first.'} onClick={requestChanges}>{busy === 'changes' ? 'Sending…' : 'Request changes'}</button><button type="button" className="btn primary" disabled={busy !== null} onClick={approve}>{busy === 'approve' ? 'Approving…' : spec ? 'Approve spec · start build' : 'Approve · ready to merge'}</button></div>
    </section>
  </div>;
}

function FactoryComments({ item, link }: { item: WorkItem; link: WorkItem['links'][number] }) {
  const { data, error } = useFetch(() => Promise.all([api.pr(link.repo, link.prId), api.fixQueue(link.repo, link.prId)]).then(([pr, fixes]) => ({ ...pr, queue: fixes.queue })), [link.repo, link.prId]);
  const [picked, setPicked] = useState<number[]>([]);
  const [queue, setQueue] = useState<FixQueue | null>(null);
  const [busy, setBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const currentQueue = queue ?? data?.queue;
  const queueOpen = currentQueue && ['preparing', 'working', 'waiting'].includes(currentQueue.status);
  const ask = async () => {
    setBusy(true);
    setAskError(null);
    try {
      setQueue(await api.startFixes(link.repo, link.prId, data!.comments.filter((c) => picked.includes(c.id)).map((c) => c.id)));
      setPicked([]);
    } catch (e) {
      setAskError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (data && !data.comments.length) return <p className="muted">No comments on {link.repo} #{link.prId}.</p>;
  return <section className="reviews-comments">
    <div className="reviews-comment-heading"><span className="mono">{item.ticket}</span><a href={`#/prs/${link.repo}/${link.prId}`}>{link.repo} #{link.prId}</a><b>{link.title}</b>{data && <span className="muted">{data.comments.length} comments</span>}</div>
    {error ? <p className="error" role="alert">{error}</p> : !data ? <p className="muted">Loading comments…</p> : <>
      {data.comments.map((c: PrComment) => <label key={c.id} className="reviews-comment"><input type="checkbox" checked={picked.includes(c.id)} disabled={busy || !!queueOpen || data.pr.state !== 'OPEN'} onChange={(e) => setPicked((ids) => e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id))} /><span><span className="mono muted">{c.path ? `${c.path}${c.line ? `:${c.line}` : ''}` : 'general'} · {c.author ?? 'Someone'}</span><span className="reviews-comment-text">{c.text}</span></span></label>)}
      {currentQueue && <p className="muted">Factory fixes: {currentQueue.status}. <a href={`#/prs/${link.repo}/${link.prId}`}>Open proposals and progress</a>{currentQueue.error && <span className="error"> {currentQueue.error}</span>}</p>}
      {askError && <p className="error" role="alert">{askError}</p>}
      <div className="reviews-actions"><span className="muted">The agent proposes a fix per comment; you approve before it pushes and replies.</span><button type="button" className="btn primary" disabled={busy || !picked.length || !!queueOpen || data.pr.state !== 'OPEN'} onClick={ask}>{busy ? 'Asking…' : `Ask factory · ${picked.length} comment${picked.length === 1 ? '' : 's'}`}</button></div>
    </>}
  </section>;
}

export function Reviews() {
  const [tab, setTab] = useState('gates');
  const [refresh, setRefresh] = useState(0);
  const { data, error, reload } = useFetch(() => api.workItems(), [refresh]);
  const items = data?.items ?? [];
  const gates = items.flatMap((item) => item.repos.filter((repo) => repo.stage === 'spec_review' || repo.stage === 'pr_review'));
  const factoryPrs = items.flatMap((item) => item.links.filter((link) => link.kind === 'impl' && link.runId && link.state === 'OPEN').map((link) => ({ item, link })));
  const uniquePrs = factoryPrs.filter((p, i) => factoryPrs.findIndex((other) => other.link.repo === p.link.repo && other.link.prId === p.link.prId) === i);
  return <Frame crumb={<span>Workspace / Reviews</span>}><div className="scroll"><div className="page reviews-page">
    <div className="page-heading"><div><h1>Reviews</h1><p className="lead">Code that waits on you: gates the factory routed to you, teammates' PRs, and comments on PRs the factory opened for you.</p></div><button className="btn sm ghost" onClick={() => setRefresh((n) => n + 1)}>Refresh</button></div>
    <div className="reviews-tabs" role="tablist" aria-label="Review type">{[['gates', `Factory gates · ${data ? gates.length : '—'}`], ['team', 'Teammates'], ['comments', 'Comments on your PRs']].map(([id, label], i) => <button type="button" key={id} id={`reviews-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`reviews-panel-${id}`} tabIndex={tab === id ? 0 : -1} onKeyDown={onTabKey(i)} onClick={() => setTab(id)}>{label}</button>)}</div>
    <div role="tabpanel" id={`reviews-panel-${tab}`} aria-labelledby={`reviews-tab-${tab}`}>
      {tab === 'team' ? <Teammates key={refresh} /> : error ? <p className="error" role="alert">{error}</p> : !data ? <Empty>Loading factory work…</Empty> : tab === 'gates' ? <FactoryGates items={items} reload={reload} /> : uniquePrs.length ? <div className="reviews-comment-list">{uniquePrs.map(({ item, link }) => <FactoryComments key={`${link.repo}/${link.prId}/${refresh}`} item={item} link={link} />)}</div> : <Empty>No comments on factory PRs.</Empty>}
    </div>
  </div></div></Frame>;
}
