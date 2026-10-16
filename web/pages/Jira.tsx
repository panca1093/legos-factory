import { useEffect, useState, type ReactNode } from 'react';
import type { RunKind } from '../../shared/types.ts';
import { api, ago, storage, useFetch, useNow, type JiraDev, type JiraRow, type PrRow, type Stage, type WorkItem } from '../api.ts';
import { Empty, Markdown, TicketChip, go } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { ALIVE, PR_TONE, type Live, type LaunchReq } from '../chrome.tsx';

const JIRA_FILTERS = [
  ['mine', 'Assigned to me'],
  ['sprint', 'Current sprint'],
] as const;

const jiraTone = (status: string | null) => {
  const st = (status ?? '').toLowerCase();
  if (/done|closed|resolved/.test(st)) return 'good';
  if (/blocked|impediment/.test(st)) return 'bad';
  if (/review|testing|qa/.test(st)) return 'watch';
  if (/progress|develop/.test(st)) return 'run';
  return 'off';
};

// What Jira's Development panel says about the ticket's PRs, builds and deploys.
// The PR itself is an action button on open tickets; withPr shows it as a chip instead (done tickets).
function DevChips({ dev, withPr }: { dev: JiraDev | null; withPr: boolean }) {
  if (!dev) return null;
  const chips: [string, string][] = [];
  if (dev.prs && withPr) {
    const n = dev.prs.count > 1 ? `${dev.prs.count} PRs` : 'PR';
    const st = (dev.prs.state ?? '').toLowerCase();
    chips.push([dev.prs.open ? `${n} open` : `${n} ${st || 'closed'}`, dev.prs.open ? 'run' : st === 'merged' ? 'good' : 'off']);
  }
  if (dev.builds) chips.push(dev.builds.failed > 0 ? [`build failed`, 'bad'] : [`build passed`, 'good']);
  for (const d of dev.deploys) chips.push([`${d.env} ${d.status.toLowerCase().replace(/_/g, ' ')}`, d.status === 'SUCCESSFUL' || d.status === 'DEPLOYED' ? 'good' : 'off']);
  const title = dev.stale ? "From Jira's Development panel; it may lag a few minutes behind Bitbucket." : "From Jira's Development panel.";
  return (
    <>
      {chips.map(([text, tone]) => (
        <span key={text} className={`dev-chip tone-${tone}`} title={title}>
          {text}
        </span>
      ))}
    </>
  );
}

// The ticket's PRs as the factory recorded them, per repo.
function LinkChips({ item }: { item: WorkItem }) {
  return (
    <>
      {item.links.map((l) => (
        <a key={`${l.repo}#${l.prId}`} className={`dev-chip tone-${PR_TONE[l.state] ?? 'off'}`} href={`#/prs/${l.repo}/${l.prId}`} title={`${l.repo} #${l.prId}: ${l.title}`}>
          {l.kind} {l.repo.split('/')[1]} #{l.prId} {l.state.toLowerCase()}
        </a>
      ))}
    </>
  );
}

// What a ticket allows right now. Underway with an open PR: the work is on the PR. A To Do ticket's "PR" is
// only one that mentions it (e.g. a planning PR), so it stays workable. Done: nothing to do.
function ticketState(status: string | null, dev: JiraDev | null) {
  const tone = jiraTone(status);
  const prs = dev?.prs ?? null;
  return { tone, done: tone === 'good', prs, onPr: !!prs?.open && tone !== 'off' };
}

function TicketActions({ row, item, finding, onStart, onPr }: { row: JiraRow; item: WorkItem | null; finding: boolean; onStart: (k: RunKind) => void; onPr: () => void }) {
  const state = ticketState(row.status, row.dev);
  const { done } = state;
  // with a work item the factory knows the ticket's PRs itself; Jira's Development field is only a hint
  const prs = item ? null : state.prs;
  const blocked = !item && state.onPr;
  if (done) return null;
  const why = blocked ? 'A PR is open for this ticket — review it instead' : undefined;
  return (
    <div className="actions">
      <button className="btn sm" disabled={blocked} title={why} onClick={() => onStart('chat')}>
        Brief
      </button>
      <button className={`btn sm ${blocked ? '' : 'primary'}`} disabled={blocked} title={why} onClick={() => onStart('task')}>
        Work on this
      </button>
      {prs && (
        <button className={`btn sm ${blocked ? 'primary' : ''}`} disabled={finding} onClick={onPr}>
          {finding ? 'Finding PR…' : blocked ? `Review PR${prs.count > 1 ? 's' : ''} →` : prs.open ? 'View linked PR →' : 'View PR →'}
        </button>
      )}
    </div>
  );
}

function TicketModal({ row, item, onClose, onStart, onPr, onItem }: { row: JiraRow; item: WorkItem | null; onClose: () => void; onStart: (k: RunKind) => void; onPr: () => void; onItem: () => void }) {
  const now = useNow(60000);
  const { data, error } = useFetch(() => api.jiraIssue(row.key), [row.key]);
  const { tone } = ticketState(row.status, row.dev);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, []);
  const facts: [string, ReactNode][] = [
    ['Type', data?.issueType],
    ['Priority', row.priority],
    ['Assignee', data?.assignee ?? row.assignee],
    ['Reporter', data?.reporter],
    ['Parent', data?.parent && <TicketChip ticket={data.parent} />],
    ['Created', data?.created && ago(data.created, now)],
    ['Updated', row.updated && ago(row.updated, now)],
  ];
  // the tool's url is the REST resource; only link out when it's a page people can open
  const browse = data?.url && /\/browse\//.test(data.url) ? data.url : null;
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog ticket-modal" role="dialog" aria-modal="true" aria-labelledby="ticket-title" onClick={(e) => e.stopPropagation()}>
        <div className="ticket-modal-head">
          <TicketChip ticket={row.key} />
          <span className={`status-pill jira-status tone-${tone}`}>{row.status ?? 'Unknown'}</span>
          <DevChips dev={row.dev} withPr={!item} />
          <button className="btn sm ghost ticket-modal-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>
        <h2 id="ticket-title">{row.summary}</h2>
        <dl className="ticket-facts">
          {facts
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
        {data && data.labels.length > 0 && (
          <div className="ticket-labels">
            {data.labels.map((l) => (
              <span key={l} className="dev-chip tone-off">
                {l}
              </span>
            ))}
          </div>
        )}
        <WorkItemPanel ticket={row.key} item={item} onChange={onItem} />
        <div className="ticket-desc">
          {error ? <p className="error">{error}</p> : !data ? <Empty>Loading ticket…</Empty> : data.description ? (
            <div className="ticket-desc-text">
              <Markdown text={data.description} />
            </div>
          ) : (
            <Empty>No description.</Empty>
          )}
        </div>
        <footer>
          {browse && (
            <a className="btn sm ghost" href={browse} target="_blank" rel="noreferrer">
              Open in Jira
            </a>
          )}
          <TicketActions row={row} item={item} finding={false} onStart={(k) => (onClose(), onStart(k))} onPr={() => (onClose(), onPr())} />
        </footer>
      </div>
    </div>
  );
}

// Short on purpose: the run has the Jira tools, so it reads the ticket itself. The server adds what the stage should produce.
const workPrompt = (i: { key: string; summary: string }) =>
  `Work on Jira ticket ${i.key}: ${i.summary}\nRead the ticket with the Jira tools first. Don't transition or comment on the ticket; the factory does that.`;
const briefPrompt = (i: { key: string; summary: string }) =>
  `Brief me on Jira ticket ${i.key}: ${i.summary}\nRead the ticket with the Jira tools first, then give me the approach and open questions.`;

const STAGES: { value: Stage; label: string; hint: string }[] = [
  { value: 'design', label: 'Design', hint: 'Write the spec where each repo keeps specs and open a spec PR' },
  { value: 'build', label: 'Build', hint: 'Implement it and open an implementation PR' },
];

// "Work on this": the ticket's work item (repos) plus one task per picked repo.
function WorkDialog({ row, item, onClose }: { row: JiraRow; item: WorkItem | null; onClose: () => void }) {
  const { data: mine, error: mineErr } = useFetch(api.myRepos, []);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!mine || picked) return;
    const project = row.key.split('-')[0];
    setPicked(new Set(item?.repos.length ? item.repos.map((r) => r.name) : mine.repos.filter((r) => r.projects.includes(project)).map((r) => r.name)));
  }, [mine]);
  const [stage, setStage] = useState<Stage>(() => (item?.links.some((l) => l.kind === 'spec') ? 'build' : 'design'));
  const [prompt, setPrompt] = useState(() => workPrompt(row));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const repos = [...(picked ?? [])];
  const toggle = (name: string) => setPicked((p) => new Set(p?.has(name) ? [...p].filter((x) => x !== name) : [...(p ?? []), name]));
  const submit = async () => {
    if (!repos.length || !prompt.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.setWorkItemRepos(row.key, [...new Set([...(item?.repos.map((r) => r.name) ?? []), ...repos])]);
      const runs = [];
      for (const repo of repos) runs.push(await api.start({ kind: 'task', repo, prompt, permissionMode: 'default', ticket: row.key, stage }));
      onClose();
      go(runs.length === 1 ? `#/runs/${runs[0].id}` : '#/tasks');
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="work-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div>
          <h2 id="work-title">Work on {row.key}</h2>
          <p>One task per repo, each in a fresh clone. The factory links the PRs they open and moves the Jira status forward.</p>
        </div>
        <div className="field">
          <span>Repos</span>
          {mineErr && <small className="error">{mineErr}</small>}
          {mine && !mine.repos.length ? (
            <div className="empty">
              No repos yet — add them in{' '}
              <a href="#/settings" onClick={onClose}>
                Settings
              </a>
            </div>
          ) : (
            <div className="check-list">
              {mine?.repos.map((r) => (
                <label key={r.name} className="check">
                  <input type="checkbox" checked={!!picked?.has(r.name)} onChange={() => toggle(r.name)} />
                  <span className="mono">{r.name}</span>
                  {r.projects.length > 0 && <small className="muted">{r.projects.join(', ')}</small>}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="field">
          <span>Stage</span>
          <div className="segmented" role="tablist" aria-label="Stage">
            {STAGES.map((s) => (
              <button key={s.value} role="tab" aria-selected={stage === s.value} className={stage === s.value ? 'active' : ''} title={s.hint} onClick={() => setStage(s.value)}>
                {s.label}
              </button>
            ))}
          </div>
          <small className="muted">{STAGES.find((s) => s.value === stage)!.hint}.</small>
        </div>
        <label className="field">
          <span>Task</span>
          <textarea className="input" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        {err && <p className="error">{err}</p>}
        <footer>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !repos.length || !prompt.trim()} onClick={submit}>
            {busy ? 'Starting…' : `Start ${repos.length > 1 ? `${repos.length} tasks` : 'task'}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

// The ticket's work item: repos, their spec and implementation PRs, and what the Jira sync did.
function WorkItemPanel({ ticket, item, onChange }: { ticket: string; item: WorkItem | null; onChange: () => void }) {
  const now = useNow(60000);
  const { data: mine } = useFetch(api.myRepos, []);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addRepo, setAddRepo] = useState('');
  const setRepos = async (repos: string[]) => {
    setErr(null);
    setBusy(true);
    try {
      await api.setWorkItemRepos(ticket, repos);
      onChange();
      setAddRepo('');
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy(false);
  };
  const names = item?.repos.map((r) => r.name) ?? [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const unlinked = item?.repos.filter((r) => !item.links.some((l) => same(l.repo, r.name))).map((r) => r.name).join() ?? '';
  // PRs that already mention the ticket, offered for the repos that have none linked yet
  const found = useFetch(() => (unlinked ? api.findPrs(ticket) : Promise.resolve(null)), [ticket, unlinked]);
  const suggested = (repo: string) => (found.data?.prs ?? []).filter((p) => same(p.repo, repo));
  const link = async (p: PrRow, kind: 'spec' | 'impl') => {
    setErr(null);
    setBusy(true);
    try {
      await api.linkPr(ticket, p.repo, p.id, kind);
      onChange();
    } catch (e: any) {
      setErr(e.message);
    }
    setBusy(false);
  };
  const addable = (mine?.repos ?? []).filter((r) => !names.some((n) => n.toLowerCase() === r.name.toLowerCase()));
  return (
    <section className="work-item">
      <div className="sectionbar">
        <h3>Work item</h3>
      </div>
      {!item ? (
        <p className="muted">No work item yet — “Work on this” starts one, or add a repo.</p>
      ) : (
        <>
          {item.repos.map((r) => {
            const links = item.links.filter((l) => l.repo.toLowerCase() === r.name.toLowerCase());
            return (
              <div key={r.name} className="work-item-repo">
                <span className="mono">{r.name}</span>
                {links.length ? (
                  <LinkChips item={{ ...item, links }} />
                ) : (
                  <>
                    <span className="muted">{suggested(r.name).length ? 'PR found, not linked yet' : 'no PR yet'}</span>
                    <button type="button" className="text-action" disabled={busy} onClick={() => setRepos(names.filter((n) => n !== r.name))}>
                      remove
                    </button>
                    {suggested(r.name).map((p) => (
                      <div key={p.id} className="found-pr">
                        <span className={`dev-chip tone-${PR_TONE[p.state] ?? 'off'}`}>{p.state.toLowerCase()}</span>
                        <span className="mono">#{p.id}</span>
                        <span className="ellipsis" title={p.title}>{p.title}</span>
                        <a className="btn sm ghost" href={`#/prs/${p.repo}/${p.id}`}>
                          Open
                        </a>
                        <button type="button" className="btn sm primary" disabled={busy} onClick={() => link(p, 'impl')}>
                          Link as impl
                        </button>
                        <button type="button" className="btn sm" disabled={busy} onClick={() => link(p, 'spec')}>
                          Link as spec
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })}
          <p className="muted">
            Jira status (last read): <b>{item.status ?? 'not synced yet'}</b>
          </p>
          {item.note && (
            <p className={item.note.text.startsWith('Error') ? 'error' : 'muted'}>
              {item.note.text} <span className="muted">· {ago(item.note.at, now)}</span>
            </p>
          )}
        </>
      )}
      {addable.length > 0 && (
        <div className="work-item-actions">
          <span>
            <select className="input sm mono" value={addRepo} onChange={(e) => setAddRepo(e.target.value)}>
              <option value="">Add repo…</option>
              {addable.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
            <button className="btn sm" disabled={!addRepo || busy} onClick={() => setRepos([...names, addRepo])}>
              Add repo
            </button>
          </span>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

export function JiraIssues({ live, onNew }: { live: Live; onNew: (k: RunKind, defaults?: LaunchReq['defaults']) => void }) {
  const now = useNow(30000);
  const [filter, setFilter] = useState<string>(() => storage('lf:jira-filter') ?? 'mine');
  const [rows, setRows] = useState<JiraRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<JiraRow | null>(null);
  const [working, setWorking] = useState<JiraRow | null>(null);
  const workItems = useFetch(api.workItems, []);
  useEffect(() => {
    const refresh = () => document.visibilityState === 'visible' && workItems.reload();
    const t = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => (clearInterval(t), window.removeEventListener('focus', refresh));
  }, []);
  const itemOf = (key: string) => workItems.data?.items.find((w) => w.ticket === key) ?? null;
  // a ticket's PR lookup: in progress, or what came back when it wasn't exactly one PR
  const [prFind, setPrFind] = useState<{ key: string; prs?: PrRow[]; searched?: string[]; error?: string } | null>(null);
  const openPr = async (key: string) => {
    setPrFind({ key });
    try {
      const r = await api.findPrs(key);
      if (r.prs.length === 1) {
        setPrFind(null);
        go(`#/prs/${r.prs[0].repo}/${r.prs[0].id}`);
      } else setPrFind({ key, ...r });
    } catch (e: any) {
      setPrFind({ key, error: e.message });
    }
  };

  const linkPr = async (key: string, p: PrRow, kind: 'spec' | 'impl') => {
    try {
      await api.linkPr(key, p.repo, p.id, kind);
      workItems.reload();
    } catch (e: any) {
      setPrFind((f) => (f ? { ...f, error: e.message } : f));
    }
  };

  const load = async (more = false) => {
    setError(null);
    if (!more) setRows(null);
    try {
      const r = await api.jiraIssues(filter, more ? (next ?? undefined) : undefined);
      setRows((prev) => (more && prev ? [...prev, ...r.issues] : r.issues));
      setNext(r.nextPageToken);
    } catch (e: any) {
      setError(e.message);
      if (!more) setRows([]);
    }
  };
  useEffect(() => {
    storage('lf:jira-filter', filter);
    void load();
  }, [filter]);

  // A brief is a conversation, not work on the ticket: no stage and no work item.
  const start = (row: JiraRow, kind: RunKind) => (kind === 'task' ? setWorking(row) : onNew(kind, { prompt: briefPrompt(row) }));

  const runsFor = (key: string) => [...live.runs.values()].filter((r) => r.ticket === key);

  return (
    <>
      <div className="tool-bar">
        <div className="segmented" role="tablist">
          {JIRA_FILTERS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <button className="btn sm ghost" onClick={() => load()}>
          Refresh
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!rows ? (
        <div className="empty">Asking Jira through workbench…</div>
      ) : rows.length === 0 ? (
        !error && <div className="empty">No open issues here.</div>
      ) : (
        <div className="list-card">
          {rows.map((i) => {
            const linked = runsFor(i.key);
            const active = linked.find((r) => ALIVE.includes(r.status));
            const { tone, done } = ticketState(i.status, i.dev);
            const item = itemOf(i.key);
            const finding = prFind?.key === i.key && !prFind.prs && !prFind.error;
            const open = () => setDetail(i);
            return (
              <div key={i.key} className="list-item jira-row" onClick={(e) => !(e.target as HTMLElement).closest('button, a, input') && open()}>
                <TicketChip ticket={i.key} />
                <div className="copy">
                  <b title={i.summary} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()}>
                    {i.summary}
                  </b>
                  <span>
                    <span className={`status-pill jira-status tone-${tone}`}>{i.status ?? 'Unknown'}</span>
                    {item && <LinkChips item={item} />}
                    <DevChips dev={i.dev} withPr={done && !item} />
                    <span className="row-meta">{[i.priority, `updated ${ago(i.updated, now)}`].filter(Boolean).join(' · ')}</span>
                    {linked.length > 0 && (
                      <a className="text-action row-meta" href={`#/runs/${(active ?? linked[0]).id}`}>
                        {active ? 'task running →' : `${linked.length} run${linked.length > 1 ? 's' : ''} →`}
                      </a>
                    )}
                  </span>
                  {prFind?.key === i.key && (prFind.prs || prFind.error) && (
                    <div className="pr-find">
                      {prFind.error ? (
                        <span className="error">{prFind.error}</span>
                      ) : prFind.prs!.length === 0 ? (
                        <span>
                          {prFind.searched!.length ? (
                            `No PR for ${i.key} in your repos (${prFind.searched!.join(', ')}).`
                          ) : (
                            <>
                              No repos yet — add them in <a href="#/settings">Settings</a> to find {i.key}'s PR.
                            </>
                          )}
                        </span>
                      ) : (
                        <>
                          <span className="muted">Found by search (key in branch or title):</span>
                          {prFind.prs!.map((p) => {
                            const inItem = item?.repos.some((r) => r.name.toLowerCase() === p.repo.toLowerCase());
                            const isLinked = item?.links.some((l) => l.repo.toLowerCase() === p.repo.toLowerCase() && l.prId === p.id);
                            return (
                              <div key={`${p.repo}#${p.id}`} className="pr-find-row">
                                <a className="pr-find-row" href={`#/prs/${p.repo}/${p.id}`}>
                                  <span className={`dev-chip tone-${PR_TONE[p.state] ?? 'off'}`}>{p.state.toLowerCase()}</span>
                                  <span className="mono">{p.repo} #{p.id}</span>
                                  <span className="ellipsis">{p.title}</span>
                                </a>
                                {isLinked ? (
                                  <span className="muted">linked</span>
                                ) : inItem ? (
                                  (['impl', 'spec'] as const).map((kind) => (
                                    <button key={kind} type="button" className="text-action" onClick={() => linkPr(i.key, p, kind)}>
                                      Link as {kind}
                                    </button>
                                  ))
                                ) : item ? (
                                  <span className="muted">add {p.repo} to link it</span>
                                ) : null}
                              </div>
                            );
                          })}
                        </>
                      )}
                      <button type="button" className="text-action" onClick={() => setPrFind(null)}>
                        close
                      </button>
                    </div>
                  )}
                  <TicketActions row={i} item={item} finding={finding} onStart={(k) => start(i, k)} onPr={() => openPr(i.key)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {next && rows && rows.length > 0 && (
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button className="btn sm" onClick={() => load(true)}>
            Load more
          </button>
        </div>
      )}
      {detail && (
        <TicketModal row={detail} item={itemOf(detail.key)} onClose={() => setDetail(null)} onStart={(k) => start(detail, k)} onPr={() => openPr(detail.key)} onItem={workItems.reload} />
      )}
      {working && <WorkDialog row={working} item={itemOf(working.key)} onClose={() => (setWorking(null), workItems.reload())} />}
      <p className="footnote">Read through workbench with your own Jira access. Click a ticket for its details; “Work on this” starts a task per repo and the factory moves the Jira status as its PRs progress.</p>
    </>
  );
}
