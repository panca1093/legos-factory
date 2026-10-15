import { useEffect, useState, type ReactNode } from 'react';
import type { RunKind } from '../../shared/types.ts';
import { api, ago, storage, useFetch, useNow, type JiraDev, type JiraRow, type PrRow, rememberRepo } from '../api.ts';
import { Empty, Markdown, RepoPicker, TicketChip, go } from '../components.tsx';
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

// What a ticket allows right now. Underway with an open PR: the work is on the PR. A To Do ticket's "PR" is
// only one that mentions it (e.g. a planning PR), so it stays workable. Done: nothing to do.
function ticketState(status: string | null, dev: JiraDev | null) {
  const tone = jiraTone(status);
  const prs = dev?.prs ?? null;
  return { tone, done: tone === 'good', prs, onPr: !!prs?.open && tone !== 'off' };
}

function TicketActions({ row, finding, onStart, onPr }: { row: JiraRow; finding: boolean; onStart: (k: RunKind) => void; onPr: () => void }) {
  const { done, prs, onPr: blocked } = ticketState(row.status, row.dev);
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

function TicketModal({ row, onClose, onStart, onPr }: { row: JiraRow; onClose: () => void; onStart: (k: RunKind) => void; onPr: () => void }) {
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
          <DevChips dev={row.dev} withPr />
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
          <TicketActions row={row} finding={false} onStart={(k) => (onClose(), onStart(k))} onPr={() => (onClose(), onPr())} />
        </footer>
      </div>
    </div>
  );
}

// Short on purpose: the run has the Jira tools, so it reads the ticket itself.
function taskPrompt(i: { key: string; summary: string }, kind: RunKind) {
  return kind === 'task'
    ? `Work on Jira ticket ${i.key}: ${i.summary}\nRead the ticket with the Jira tools first. Implement and verify it; don't transition or comment on the ticket.`
    : `Brief me on Jira ticket ${i.key}: ${i.summary}\nRead the ticket with the Jira tools first, then give me the approach and open questions.`;
}

export function JiraIssues({ live, onNew }: { live: Live; onNew: (k: RunKind, defaults?: LaunchReq['defaults']) => void }) {
  const now = useNow(30000);
  const [filter, setFilter] = useState<string>(() => storage('lf:jira-filter') ?? 'mine');
  const [rows, setRows] = useState<JiraRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<JiraRow | null>(null);
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
  // "Work on this" asks for a repo next; start loading the (slow, cached) list now
  useEffect(() => void api.repos(storage('lf:bb-ws') ?? undefined).catch(() => undefined), []);

  // Pull full ticket details so the run starts with real context, not just a title.
  const start = (row: JiraRow, kind: RunKind) => onNew(kind, { prompt: taskPrompt(row, kind), ticket: row.key });

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
                    <DevChips dev={i.dev} withPr={done} />
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
                        <>
                          <span>
                            No PR for {i.key} {prFind.searched!.length ? `in ${prFind.searched!.join(', ')}` : 'yet'}. Bitbucket can't search every repo at once — pick the repo to look in:
                          </span>
                          <RepoPicker value="" onPick={(r) => (rememberRepo(r.name), openPr(i.key))} />
                        </>
                      ) : (
                        prFind.prs!.map((p) => (
                          <a key={`${p.repo}#${p.id}`} className="pr-find-row" href={`#/prs/${p.repo}/${p.id}`}>
                            <span className={`dev-chip tone-${PR_TONE[p.state] ?? 'off'}`}>{p.state.toLowerCase()}</span>
                            <span className="mono">{p.repo} #{p.id}</span>
                            <span className="ellipsis">{p.title}</span>
                          </a>
                        ))
                      )}
                      <button type="button" className="text-action" onClick={() => setPrFind(null)}>
                        close
                      </button>
                    </div>
                  )}
                  <TicketActions row={i} finding={finding} onStart={(k) => start(i, k)} onPr={() => openPr(i.key)} />
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
      {detail && <TicketModal row={detail} onClose={() => setDetail(null)} onStart={(k) => start(detail, k)} onPr={() => openPr(detail.key)} />}
      <p className="footnote">Read through workbench with your own Jira access. Click a ticket for its details; “Work on this” starts a task on it.</p>
    </>
  );
}
