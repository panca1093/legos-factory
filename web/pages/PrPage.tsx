import { useEffect, useState } from 'react';
import type { FixItem, FixQueue } from '../../shared/types.ts';
import { api, ago, useFetch, useNow, type Pr, type PrComment } from '../api.ts';
import { Empty, Markdown } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { PR_TONE, Frame } from '../chrome.tsx';
import { splitDiff, DIFF_LINE_CAP, numberDiff } from '../lib/diff.ts';

const FIX_LABEL: Record<FixItem['status'], [string, string]> = {
  pending: ['queued', 'off'],
  proposing: ['proposing…', 'run'],
  proposed: ['proposal ready', 'watch'],
  fixing: ['fixing…', 'run'],
  done: ['fixed', 'good'],
  skipped: ['skipped', 'off'],
  failed: ['failed', 'bad'],
};
const QUEUE_OPEN: FixQueue['status'][] = ['preparing', 'working', 'waiting'];

// What a comment can do on an open PR: reply as you, or be picked for the factory.
type CommentActions = { repo: string; prId: number; picked: boolean; canPick: boolean; onPick: (v: boolean) => void; onReplied: () => void };

function Comment({ c, now, general, fix, act }: { c: PrComment; now: number; general?: boolean; fix?: FixItem; act?: CommentActions }) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.comment(act!.repo, act!.prId, text.trim(), c.id);
      setText('');
      setReplying(false);
      act!.onReplied();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={general ? 'pr-box pr-comment' : 'pr-comment inline'}>
      <div className="pr-comment-head">
        <span>
          <b>{c.author ?? 'Someone'}</b> · {c.created ? ago(c.created, now) : ''}
        </span>
        {fix && <span className={`dev-chip tone-${FIX_LABEL[fix.status][1]}`}>factory: {FIX_LABEL[fix.status][0]}</span>}
      </div>
      <Markdown text={c.text} />
      {act && (
        <div className="pr-comment-bar">
          <button type="button" className="text-action" onClick={() => setReplying(!replying)}>
            Reply
          </button>
          {act.canPick && (
            <label className="pick">
              <input type="checkbox" checked={act.picked} onChange={(e) => act.onPick(e.target.checked)} /> Ask factory
            </label>
          )}
        </div>
      )}
      {replying && (
        <div className="pr-reply">
          <textarea className="input" rows={3} autoFocus value={text} placeholder={`Reply to ${c.author ?? 'this comment'}…`} onChange={(e) => setText(e.target.value)} />
          {err && <p className="error">{err}</p>}
          <div className="pr-reply-actions">
            <button type="button" className="btn sm ghost" onClick={() => setReplying(false)}>
              Cancel
            </button>
            <button type="button" className="btn sm primary" disabled={busy || !text.trim()} onClick={send}>
              {busy ? 'Posting…' : 'Post reply'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// The factory working through picked comments, one at a time; whatever needs you is opened up.
function FixPanel({ q, onChange }: { q: FixQueue; onChange: (q: FixQueue) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (f: () => Promise<FixQueue>) => {
    setBusy(true);
    setErr(null);
    try {
      onChange(await f());
      setNote('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const open = QUEUE_OPEN.includes(q.status);
  const settled = q.items.filter((i) => i.status === 'done' || i.status === 'skipped').length;
  const current = open ? q.items.find((i) => i.status !== 'done' && i.status !== 'skipped') : undefined;
  const headline =
    q.status === 'preparing' ? `Checking out ${q.branch}…`
    : q.status === 'failed' ? 'Could not start'
    : q.status === 'cancelled' ? 'Stopped'
    : q.status === 'done' ? 'All picked comments handled'
    : `Comment ${settled + 1} of ${q.items.length}`;
  return (
    <section className="pr-box fix-panel">
      <div className="fix-head">
        <div>
          <div className="page-eyebrow">Factory · review fixes</div>
          <b>{headline}</b>
        </div>
        {open && (
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => act(() => api.cancelFixes(q.id))}>
            Stop
          </button>
        )}
      </div>
      {q.error && <p className="error">{q.error}</p>}
      <ol className="fix-items">
        {q.items.map((i) => {
          const [label, tone] = FIX_LABEL[i.status];
          const isCurrent = current?.commentId === i.commentId;
          return (
            <li key={i.commentId} className={isCurrent ? 'current' : ''}>
              <div className="fix-row">
                <span className={`dev-chip tone-${tone}`}>{label}</span>
                <span className="ellipsis grow">
                  <b>{i.author ?? 'Someone'}</b>
                  {i.path && <span className="mono muted"> · {i.path}{i.line ? `:${i.line}` : ''}</span>} — {i.text.split('\n')[0]}
                </span>
                {i.runId && (
                  <a className="text-action" href={`#/runs/${i.runId}`}>
                    run →
                  </a>
                )}
              </div>
              {i.status === 'done' && (
                <p className="fix-note">
                  Pushed <code>{i.commit?.slice(0, 7)}</code>
                  {i.replied ? ' and replied on the comment.' : '.'}
                  {i.error && <span className="error"> {i.error}</span>}
                </p>
              )}
              {isCurrent && i.status === 'proposing' && <p className="fix-note">Reading the code and drafting a proposal. Nothing changes in this step.</p>}
              {isCurrent && i.status === 'fixing' && (
                <p className="fix-note">Applying the fix, then committing and pushing to {q.branch}. Shell commands (tests, commit, push) ask you in Needs you.</p>
              )}
              {isCurrent && i.status === 'proposed' && (
                <div className="fix-proposal">
                  <Markdown text={i.proposal ?? ''} />
                  <textarea
                    className="input"
                    rows={2}
                    value={note}
                    placeholder="Optional: change the proposal or add instructions for the fix"
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <div className="pr-reply-actions">
                    <button type="button" className="btn sm ghost" disabled={busy} onClick={() => act(() => api.fixAction(q.id, i.commentId, 'skip'))}>
                      Skip
                    </button>
                    <button type="button" className="btn sm primary" disabled={busy} onClick={() => act(() => api.fixAction(q.id, i.commentId, 'approve', note))}>
                      Approve &amp; fix
                    </button>
                  </div>
                </div>
              )}
              {isCurrent && i.status === 'failed' && (
                <div className="fix-proposal">
                  <p className="error">{i.error}</p>
                  <div className="pr-reply-actions">
                    <button type="button" className="btn sm ghost" disabled={busy} onClick={() => act(() => api.fixAction(q.id, i.commentId, 'skip'))}>
                      Skip
                    </button>
                    <button type="button" className="btn sm primary" disabled={busy} onClick={() => act(() => api.fixAction(q.id, i.commentId, 'retry'))}>
                      Retry
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {err && <p className="error">{err}</p>}
    </section>
  );
}

function reviewPrompt(pr: Pr) {
  return `Review pull request #${pr.id} in ${pr.repo}: "${pr.title}" (${pr.source} into ${pr.destination}). You are in a checkout of ${pr.source}.
Read the PR, its diff and its existing comments with the workbench Bitbucket tools (bitbucket_get_pr, bitbucket_get_pr_diff, bitbucket_list_pr_comments), and the code around the changes for context.
Do not post, approve or change anything. Answer with a review I can post myself: blocking issues first, then suggestions, then questions, each with file:line and a one-paragraph reason.`;
}

// The latest fix queue for this PR, polled while it runs. refresh() starts polling again after a change.
function useFixQueue(repo: string, id: number) {
  const [queue, setQueue] = useState<FixQueue | null>(null);
  const [kick, setKick] = useState(0);
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const tick = () =>
      api.fixQueue(repo, id).then(
        (r) => {
          if (!alive) return;
          setQueue(r.queue);
          if (r.queue && QUEUE_OPEN.includes(r.queue.status)) t = setTimeout(tick, 2500);
        },
        () => alive && (t = setTimeout(tick, 5000)),
      );
    tick();
    return () => ((alive = false), clearTimeout(t));
  }, [repo, id, kick]);
  return { queue, setQueue, refresh: () => setKick((k) => k + 1) };
}

export function PrPage({ repo, id }: { repo: string; id: number }) {
  const now = useNow(60000);
  const { data, error, reload } = useFetch(() => api.pr(repo, id), [repo, id]);
  const [diff, setDiff] = useState<Map<string, string[]> | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  // the full diff can be large: fetch it on the first file opened
  const show = (path: string) => {
    setOpenFile(openFile === path ? null : path);
    if (!diff && !diffErr) api.prDiff(repo, id).then((r) => (setDiff(splitDiff(r.diff)), setTruncated(r.truncated)), (e) => setDiffErr(e.message));
  };
  const pr = data?.pr;
  const inline = (path: string) => (data?.comments ?? []).filter((c) => c.path === path);
  const general = (data?.comments ?? []).filter((c) => !c.path);

  const { queue, setQueue, refresh } = useFixQueue(repo, id);
  // the factory's replies show up as new comments
  const replied = queue?.items.filter((i) => i.replied).length ?? 0;
  useEffect(() => void (replied && reload()), [replied]);
  const queueOpen = !!queue && QUEUE_OPEN.includes(queue.status);
  const fixFor = (cid: number) => (queue && queue.items.find((i) => i.commentId === cid)) || undefined;

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [askErr, setAskErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const canAct = pr?.state === 'OPEN';
  const actions = (c: PrComment): CommentActions | undefined =>
    canAct
      ? {
          repo,
          prId: id,
          picked: picked.has(c.id),
          canPick: !queueOpen,
          onPick: (v) => setPicked((p) => (v ? new Set(p).add(c.id) : new Set([...p].filter((x) => x !== c.id)))),
          onReplied: reload,
        }
      : undefined;
  const ask = async () => {
    setAsking(true);
    setAskErr(null);
    try {
      // page order: files top to bottom, then general comments
      const order = [...data!.files.flatMap((f) => inline(f.path)), ...general].map((c) => c.id).filter((cid) => picked.has(cid));
      setQueue(await api.startFixes(repo, id, order));
      setPicked(new Set());
      refresh();
    } catch (e) {
      setAskErr((e as Error).message);
    } finally {
      setAsking(false);
    }
  };
  const reviewWithFactory = async () => {
    setAskErr(null);
    try {
      const run = await api.start({ kind: 'task', repo, branch: pr!.source, prompt: reviewPrompt(pr!), permissionMode: 'default' });
      location.hash = `#/runs/${run.id}`;
    } catch (e) {
      setAskErr((e as Error).message);
    }
  };
  return (
    <Frame
      crumb={
        <>
          <span>Workspace / Pull requests / </span>
          {repo} #{id}
        </>
      }
    >
      <div className="scroll">
        <div className="page">
          {!data ? (
            error ? <p className="error">{error}</p> : <Empty>Loading pull request…</Empty>
          ) : (
            <>
              <div className="page-heading">
                <div style={{ minWidth: 0 }}>
                  <div className="page-eyebrow">
                    <span className={`status-pill jira-status tone-${PR_TONE[pr!.state] ?? 'off'}`}>{pr!.state.toLowerCase()}</span>
                    <span className="mono">{repo} #{id}</span>
                  </div>
                  <h1 className="pr-title">{pr!.title}</h1>
                  <p className="lead">
                    {pr!.author ?? 'Someone'} wants to merge <code>{pr!.source}</code> into <code>{pr!.destination}</code>
                    {pr!.updated && ` · updated ${ago(pr!.updated, now)}`}
                  </p>
                </div>
                <div className="pr-actions">
                  {canAct && picked.size > 0 && (
                    <button className="btn sm primary" disabled={asking} onClick={ask} title="Propose and fix the picked comments one at a time; you approve each proposal">
                      <Icon name="spark" size={14} /> Ask factory ({picked.size})
                    </button>
                  )}
                  {canAct && (
                    <button className="btn sm" onClick={reviewWithFactory} title="A task reads the PR and drafts a review for you; it posts nothing">
                      Review with factory
                    </button>
                  )}
                  <button className="btn sm ghost" onClick={reload}>
                    Refresh
                  </button>
                  {pr!.url && (
                    <a className="btn sm" href={pr!.url} target="_blank" rel="noreferrer">
                      Open in Bitbucket
                    </a>
                  )}
                </div>
              </div>
              <div className="pr-reviewers">
                {pr!.reviewers.length === 0 ? (
                  <span className="muted">No reviewers yet</span>
                ) : (
                  pr!.reviewers.map((r) => (
                    <span key={r.name} className={`dev-chip tone-${r.approved ? 'good' : 'off'}`}>
                      {r.approved ? '✓ ' : ''}
                      {r.name}
                    </span>
                  ))
                )}
                {pr!.tasks > 0 && <span className="dev-chip tone-watch">{pr!.tasks} open task{pr!.tasks > 1 ? 's' : ''}</span>}
              </div>
              {askErr && <p className="error">{askErr}</p>}
              {queue && <FixPanel q={queue} onChange={(q) => (setQueue(q), refresh())} />}
              {pr!.description && (
                <section className="pr-box pr-desc">
                  <Markdown text={pr!.description} />
                </section>
              )}
              <h2 className="section-title">
                Files <span className="muted">· {data.files.length}</span>
              </h2>
              <div className="list-card pr-files">
                {data.files.map((f) => {
                  const lines = diff?.get(f.path);
                  const notes = inline(f.path);
                  return (
                    <div key={f.path} className="pr-file">
                      <button className="pr-file-head" onClick={() => show(f.path)} aria-expanded={openFile === f.path}>
                        <span className={`pr-file-status ${f.status}`}>{f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : f.status === 'renamed' ? 'R' : 'M'}</span>
                        <span className="mono grow ellipsis" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                          {f.path}
                        </span>
                        {notes.length > 0 && <span className="dev-chip tone-run">{notes.length} comment{notes.length > 1 ? 's' : ''}</span>}
                        <span className="pr-counts">
                          <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
                        </span>
                      </button>
                      {openFile === f.path && (
                        <div className="pr-file-body">
                          {/* comments whose line isn't in the shown diff (outdated, or before the diff loads) */}
                          {(() => {
                            const shown = new Set(lines ? numberDiff(lines.slice(0, DIFF_LINE_CAP)).map((d) => d.newNo) : []);
                            const loose = notes.filter((c) => c.line === null || !shown.has(c.line));
                            return loose.map((c) => (
                              <div key={c.id}>
                                <small className="muted">{c.line ? `line ${c.line} (not in this diff)` : 'on this file'}</small>
                                <Comment c={c} now={now} fix={fixFor(c.id)} act={actions(c)} />
                              </div>
                            ));
                          })()}
                          {diffErr ? (
                            <p className="error">{diffErr}</p>
                          ) : !diff ? (
                            <Empty>Loading diff…</Empty>
                          ) : !lines ? (
                            <Empty>{truncated ? 'This PR is too big to show every file here — open it in Bitbucket for this one.' : 'No textual diff for this file (binary or too large).'}</Empty>
                          ) : (
                            <div className="pr-diff">
                              {numberDiff(lines.slice(0, DIFF_LINE_CAP)).map((d, k) => (
                                <div key={k}>
                                  <div className={`dl ${d.kind}`}>
                                    <span className="ln">{d.oldNo ?? ''}</span>
                                    <span className="ln">{d.newNo ?? ''}</span>
                                    <code>{d.text || ' '}</code>
                                  </div>
                                  {d.newNo !== null && d.kind !== 'del' && notes.filter((c) => c.line === d.newNo).map((c) => <Comment key={c.id} c={c} now={now} fix={fixFor(c.id)} act={actions(c)} />)}
                                </div>
                              ))}
                              {lines.length > DIFF_LINE_CAP && <div className="dl hunk">… {lines.length - DIFF_LINE_CAP} more lines — open in Bitbucket</div>}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <h2 className="section-title">
                Comments <span className="muted">· {general.length}</span>
              </h2>
              {general.length === 0 ? (
                <Empty>No general comments.</Empty>
              ) : (
                general.map((c) => <Comment key={c.id} c={c} now={now} general fix={fixFor(c.id)} act={actions(c)} />)
              )}
              <p className="footnote">
                Through workbench with your own Bitbucket access. Replies post as you, on the same line as the comment (Bitbucket threads aren't available through
                workbench yet). Ask factory fixes picked comments one at a time on a fresh checkout of {pr!.source}, and only after you approve each proposal.
              </p>
            </>
          )}
        </div>
      </div>
    </Frame>
  );
}
