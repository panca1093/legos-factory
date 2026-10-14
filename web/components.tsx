import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ModelOption, PendingDecision, PermissionMode, Run, RunKind, ShareLevel, TimelineEvent, Usage } from '../shared/types.ts';
import { api, ago, applyTheme, fmtTokens, projectName, storage, useFetch, useNow, type Conn, type RepoRow, type Theme, recentRepos, rememberRepo } from './api.ts';
import { Icon } from './icons.tsx';

export const go = (hash: string) => {
  location.hash = hash;
};

export type Tone = 'good' | 'watch' | 'alert' | 'run' | 'off';

type RunLike = Pick<Run, 'kind' | 'status' | 'endedBy'>;

const LABEL: Record<Run['status'], string> = {
  queued: 'Queued',
  starting: 'Starting',
  running: 'Working',
  awaiting_decision: 'Needs you',
  idle: 'Your turn',
  completed: 'Ended',
  failed: 'Failed',
};

export function runLabel(r: RunLike): string {
  if (r.kind === 'task' && r.status === 'completed') return r.endedBy === 'user' ? 'Cancelled' : 'Done';
  return LABEL[r.status];
}

const TONE: Record<Run['status'], Tone> = { queued: 'off', starting: 'run', running: 'run', awaiting_decision: 'watch', idle: 'good', completed: 'off', failed: 'alert' };
export function runTone(r: RunLike): Tone {
  if (r.kind === 'task' && r.status === 'completed' && r.endedBy !== 'user') return 'good';
  return TONE[r.status];
}

export function StatusPill({ run }: { run: RunLike }) {
  return <span className={`status-pill tone-${runTone(run)}`}>{runLabel(run)}</span>;
}

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => (storage('lf:theme') as Theme | null) ?? 'system');
  const pick = (t: Theme) => {
    setTheme(t);
    storage('lf:theme', t);
    applyTheme(t);
  };
  return (
    <div className="segmented theme-switch" role="radiogroup" aria-label="Theme">
      {(['system', 'light', 'dark'] as const).map((t) => (
        <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'active' : ''} onClick={() => pick(t)}>
          {t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </div>
  );
}

export function TicketChip({ ticket }: { ticket: string | null }) {
  return ticket ? <span className="ticket-chip">{ticket}</span> : null;
}

export const SHARE_LABEL: Record<ShareLevel, string> = { private: 'Private', status: 'Status shared', full: 'Fully shared' };
const SHARE_HINT: Record<ShareLevel, string> = {
  private: 'Team hub sees nothing of this',
  status: 'Team hub sees title, ticket and status only',
  full: 'Team hub sees status and the full timeline',
};

export function ShareBadge({ share }: { share: ShareLevel }) {
  return (
    <span className={`share-badge share-${share}`} title={SHARE_HINT[share]}>
      {SHARE_LABEL[share]}
    </span>
  );
}

export function ConnChip({ conn }: { conn: Conn }) {
  const label = { connecting: 'Connecting…', connected: 'Live', reconnecting: 'Reconnecting · actions paused' }[conn];
  return (
    <span className={`chip ${conn === 'connected' ? 'live' : 'wait'}`} role="status">
      <span className="dot" />
      {label}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

const FALLBACK_MODELS: ModelOption[] = [{ value: 'default', displayName: 'Default', description: 'Your Claude Code default' }];

export function useModels(): ModelOption[] {
  const { data } = useFetch(api.models, []);
  return data?.length ? data : FALLBACK_MODELS;
}

export function ModelSelect({ value, onChange, disabled, chip }: { value: string; onChange: (v: string) => void; disabled?: boolean; chip?: boolean }) {
  const models = useModels();
  const options = models.some((m) => m.value === value) ? models : [...models, { value, displayName: value, description: '' }];
  return (
    <select className={chip ? 'model-chip' : 'input'} aria-label="Model" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((m) => (
        <option key={m.value} value={m.value} title={m.description}>
          {m.displayName}
          {!chip && m.description ? ` — ${m.description}` : ''}
        </option>
      ))}
    </select>
  );
}

export const totalTokens = (u: Usage | null) => (u ? u.input + u.cacheWrite + u.cacheRead + u.output : null);

export function UsageRows({ usage, subagents }: { usage: Usage | null; subagents?: number }) {
  if (!usage) return <p className="empty-note">Unknown — no usage recorded in this transcript.</p>;
  const rows: [string, number][] = [
    ['Uncached input', usage.input],
    ['Cache write', usage.cacheWrite],
    ['Cache read', usage.cacheRead],
    ['Output', usage.output],
  ];
  return (
    <>
      <div className="inspect-item">
        Total <b>{fmtTokens(totalTokens(usage)!)} tokens</b>
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className="inspect-item">
          {k} <b>{fmtTokens(v)}</b>
        </div>
      ))}
      {subagents ? <p className="empty-note">Includes {subagents} subagent transcript{subagents > 1 ? 's' : ''}.</p> : null}
    </>
  );
}

function inputPreview(d: PendingDecision): string {
  const i = d.input as Record<string, any>;
  for (const k of ['command', 'file_path', 'url', 'pattern']) if (typeof i[k] === 'string') return i[k];
  return JSON.stringify(i, null, 2);
}

type Question = { question: string; options: { label: string; description?: string }[] };
const questionsOf = (d: PendingDecision): Question[] | null =>
  d.toolName === 'AskUserQuestion' && Array.isArray((d.input as any).questions) ? (d.input as any).questions : null;

function useDecide(d: PendingDecision) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answer = async (a: Parameters<typeof api.decide>[1]) => {
    setBusy(true);
    setErr(null);
    try {
      await api.decide(d.id, a);
    } catch (e: any) {
      setErr(e.status === 410 ? 'Already closed — answered elsewhere, expired, or the run ended.' : e.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, answer };
}

// Full approval card, used inline in the chat thread.
export function ApprovalCard({ d, conn, onReview }: { d: PendingDecision; conn: Conn; onReview?: (id: string) => void }) {
  const now = useNow();
  const { busy, err, answer } = useDecide(d);
  const [note, setNote] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = questionsOf(d);
  const paused = conn !== 'connected';

  return (
    <div className="approval">
      <h4>
        {questions ? 'Claude has a question' : `Allow ${d.toolName}?`}
        <span className="status-pill tone-watch">Needs you · {ago(d.createdAt, now)}</span>
      </h4>
      <p>{d.title ?? d.reason ?? (questions ? 'Pick an answer to continue.' : 'Claude is waiting for your permission to run this tool.')}</p>
      {questions ? (
        questions.map((q) => (
          <fieldset key={q.question} className="question">
            <legend>{q.question}</legend>
            {q.options.map((o) => (
              <label key={o.label} className={answers[q.question] === o.label ? 'choice on' : 'choice'}>
                <input type="radio" name={`${d.id}:${q.question}`} checked={answers[q.question] === o.label} onChange={() => setAnswers({ ...answers, [q.question]: o.label })} />
                <span>
                  <b>{o.label}</b>
                  {o.description && <small>{o.description}</small>}
                </span>
              </label>
            ))}
          </fieldset>
        ))
      ) : (
        <pre>{inputPreview(d)}</pre>
      )}
      {err && <p className="error">{err}</p>}
      <div className="approval-actions">
        {!questions && <input className="input" placeholder="Optional note when denying" value={note} onChange={(e) => setNote(e.target.value)} />}
        {onReview && (
          <button className="btn sm ghost" onClick={() => onReview(d.id)}>
            <Icon name="chat" size={14} /> Discuss
          </button>
        )}
        <button className="btn sm" disabled={busy || paused} onClick={() => answer({ behavior: 'deny', message: note || undefined })}>
          {questions ? 'Skip' : 'Deny'}
        </button>
        <button
          className="btn sm primary"
          disabled={busy || paused || (questions !== null && questions.some((q) => !answers[q.question]))}
          onClick={() => answer(questions ? { behavior: 'allow', answers } : { behavior: 'allow' })}
        >
          <Icon name="check" size={14} />
          {questions ? 'Send answer' : 'Allow'}
        </button>
      </div>
    </div>
  );
}

// What the tool will do, shaped per tool so a decision can be made at a glance.
function RequestBody({ d }: { d: PendingDecision }) {
  const i = d.input as Record<string, any>;
  const clip = (t: string, n = 60) => {
    const lines = String(t).split('\n');
    return lines.length > n ? lines.slice(0, n).join('\n') + `\n… ${lines.length - n} more lines` : String(t);
  };
  if (d.toolName === 'Edit' && typeof i.old_string === 'string') {
    return (
      <>
        <div className="req-path mono">{i.file_path}</div>
        <pre className="diff">
          {clip(i.old_string, 30).split('\n').map((l, n) => (
            <span key={`o${n}`} className="del">- {l}{'\n'}</span>
          ))}
          {clip(i.new_string, 30).split('\n').map((l, n) => (
            <span key={`n${n}`} className="add">+ {l}{'\n'}</span>
          ))}
        </pre>
      </>
    );
  }
  if (d.toolName === 'Write' && typeof i.content === 'string') {
    return (
      <>
        <div className="req-path mono">{i.file_path}</div>
        <pre>{clip(i.content)}</pre>
      </>
    );
  }
  if (d.toolName === 'Bash' && typeof i.command === 'string') {
    return (
      <>
        {i.description && <p className="req-desc">{i.description}</p>}
        <pre>{i.command}</pre>
      </>
    );
  }
  return <pre>{inputPreview(d)}</pre>;
}

// Popup to review a pending request with its context; Discuss turns a task into a chat on the spot.
export function ReviewModal({ d, run, conn, onClose }: { d: PendingDecision; run?: Run; conn: Conn; onClose: () => void }) {
  const now = useNow();
  const { busy, err, answer } = useDecide(d);
  const [question, setQuestion] = useState('');
  const [discussing, setDiscussing] = useState(false);
  const [discussErr, setDiscussErr] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = questionsOf(d);
  const paused = conn !== 'connected';
  const lead = (run?.events ?? []).filter((e) => !e.sidechain && e.kind !== 'thinking' && e.kind !== 'tool_result').slice(-5);

  const decide = async (a: Parameters<typeof api.decide>[1]) => {
    await answer(a);
    onClose();
  };
  const discuss = async () => {
    if (!question.trim()) return;
    setDiscussing(true);
    setDiscussErr(null);
    try {
      const { runId } = await api.discuss(d.id, question.trim());
      onClose();
      go(`#/runs/${runId}`);
    } catch (e: any) {
      setDiscussErr(e.status === 410 ? 'This request already closed.' : e.message);
      setDiscussing(false);
    }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog review" role="dialog" aria-modal="true" aria-labelledby="review-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="review-head">
          <div style={{ minWidth: 0 }}>
            <div className="kicker">
              {run?.kind === 'task' ? 'Task' : 'Chat'} · {projectName(d.cwd)} · {ago(d.createdAt, now)}
            </div>
            <h2 id="review-title">{questions ? 'Claude has a question' : `Allow ${d.toolName}?`}</h2>
            {run && <p className="review-prompt">{run.prompt.split('\n')[0]}</p>}
          </div>
          <button className="icon" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>

        {(d.title || d.reason) && <p className="review-why">{d.title ?? d.reason}</p>}

        <div className="review-body">
          {questions ? (
            questions.map((q) => (
              <fieldset key={q.question} className="question">
                <legend>{q.question}</legend>
                {q.options.map((o) => (
                  <label key={o.label} className={answers[q.question] === o.label ? 'choice on' : 'choice'}>
                    <input type="radio" name={`m:${d.id}:${q.question}`} checked={answers[q.question] === o.label} onChange={() => setAnswers({ ...answers, [q.question]: o.label })} />
                    <span>
                      <b>{o.label}</b>
                      {o.description && <small>{o.description}</small>}
                    </span>
                  </label>
                ))}
              </fieldset>
            ))
          ) : (
            <RequestBody d={d} />
          )}
        </div>

        {lead.length > 0 && (
          <details className="review-lead">
            <summary>What led to this · last {lead.length} steps</summary>
            <ol>
              {lead.map((e) => (
                <li key={e.id}>
                  <span className="who">{e.kind === 'tool_use' ? e.tool : e.kind === 'user' ? 'You' : 'Claude'}</span>
                  <span className="what">{e.text.split('\n')[0]}</span>
                </li>
              ))}
            </ol>
          </details>
        )}

        <div className="review-discuss">
          <label htmlFor="review-q">Not sure? Ask Claude first</label>
          <div className="row-input">
            <input
              id="review-q"
              className="input"
              placeholder="e.g. Why do you need to delete this folder?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && discuss()}
            />
            <button className="btn" disabled={!question.trim() || discussing || paused} onClick={discuss}>
              <Icon name="chat" size={14} /> Discuss
            </button>
          </div>
          <small>{run?.kind === 'task' ? 'The task pauses this step and continues as a chat, with full context.' : 'Claude holds this step and answers your question.'}</small>
          {discussErr && <p className="error">{discussErr}</p>}
        </div>

        {err && <p className="error">{err}</p>}
        <footer>
          <a className="text-action" href={`#/runs/${d.runId}`} onClick={onClose}>
            Open {run?.kind === 'task' ? 'task' : 'chat'} →
          </a>
          <span className="grow" />
          <button className="btn" disabled={busy || paused} onClick={() => decide({ behavior: 'deny' })}>
            {questions ? 'Skip' : 'Deny'}
          </button>
          <button
            className="btn primary"
            disabled={busy || paused || (questions !== null && questions.some((q) => !answers[q.question]))}
            onClick={() => decide(questions ? { behavior: 'allow', answers } : { behavior: 'allow' })}
          >
            <Icon name="check" size={14} /> {questions ? 'Send answer' : 'Allow'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// Compact row for the Overview "Needs you" list.
export function DecisionRow({ d, conn, onReview }: { d: PendingDecision; conn: Conn; onReview: (id: string) => void }) {
  const now = useNow();
  const { busy, err, answer } = useDecide(d);
  const questions = questionsOf(d);
  const paused = conn !== 'connected';
  return (
    <div className="row">
      <span className="marker">!</span>
      <div className="copy clickable" role="button" tabIndex={0} onClick={() => onReview(d.id)} onKeyDown={(e) => e.key === 'Enter' && onReview(d.id)}>
        <b>{questions ? `Question: ${questions[0]?.question ?? ''}` : `${d.toolName} · ${inputPreview(d).split('\n')[0]}`}</b>
        <span className={err ? 'error' : ''}>{err ?? `${projectName(d.cwd)} · ${ago(d.createdAt, now)}`}</span>
      </div>
      <div className="actions">
        {questions ? (
          <button className="btn sm primary" onClick={() => onReview(d.id)}>
            Answer
          </button>
        ) : (
          <>
            <button className="btn sm" disabled={busy || paused} onClick={() => answer({ behavior: 'deny' })}>
              Deny
            </button>
            <button className="btn sm primary" disabled={busy || paused} onClick={() => answer({ behavior: 'allow' })}>
              Allow
            </button>
          </>
        )}
        <button className="btn sm" onClick={() => onReview(d.id)}>
          Review
        </button>
      </div>
    </div>
  );
}

// ---------- chat thread ----------

// Transcripts are untrusted (tool output, web content); sanitize after markdown rendering.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

type Item =
  | { kind: 'user'; e: TimelineEvent }
  | { kind: 'assistant'; e: TimelineEvent }
  | { kind: 'system'; e: TimelineEvent }
  | { kind: 'tool'; use: TimelineEvent; result: TimelineEvent | null };

// Pairs each tool_use with the next unmatched tool_result (FIFO), which matches how parallel calls report back.
function toItems(events: TimelineEvent[]): Item[] {
  const items: Item[] = [];
  const open: Extract<Item, { kind: 'tool' }>[] = [];
  for (const e of events) {
    if (e.kind === 'tool_use') {
      const it = { kind: 'tool' as const, use: e, result: null };
      items.push(it);
      open.push(it);
    } else if (e.kind === 'tool_result') {
      const it = open.shift();
      if (it) it.result = e;
      else items.push({ kind: 'system', e: { ...e, text: `Tool result: ${e.text.slice(0, 200)}` } });
    } else {
      items.push({ kind: e.kind, e } as Item);
    }
  }
  return items;
}

function ToolCard({ use, result, pending }: { use: TimelineEvent; result: TimelineEvent | null; pending: 'running' | 'waiting' | null }) {
  const status = result ? (result.isError ? 'Error' : 'Completed') : pending === 'waiting' ? 'Waiting for you' : pending === 'running' ? 'Running…' : 'No result';
  return (
    <details className="tool-card">
      <summary>
        <span className="tglyph">
          <Icon name="terminal" size={14} />
        </span>
        {use.sidechain && <span className="side-tag">subagent</span>}
        <b>{use.tool}</b>
        <code>{use.text}</code>
        <span className={`tstatus ${result?.isError ? 'err' : !result ? 'wait' : ''}`}>{status}</span>
      </summary>
      <div className="tool-detail">
        <pre>{use.text}</pre>
        {result && <pre className={result.isError ? 'error' : ''}>{result.text || '(empty result)'}</pre>}
      </div>
    </details>
  );
}

export function Thread({
  events,
  working,
  waiting,
  title,
  children,
}: {
  events: TimelineEvent[];
  working?: boolean;
  // a permission request is open, so the latest tool call is blocked on the user
  waiting?: boolean;
  title?: ReactNode;
  children?: ReactNode;
}) {
  const [showSide, setShowSide] = useState(false);
  const sideCount = events.filter((e) => e.sidechain).length;
  // thinking is noise in a chat view; it stays in the raw transcript
  const items = toItems(events.filter((e) => e.kind !== 'thinking' && (showSide || !e.sidechain)));
  const lastTool = [...items].reverse().find((i) => i.kind === 'tool');

  return (
    <>
      <div className="thread-top">
        {title}
        {sideCount > 0 && (
          <button className="text-action" onClick={() => setShowSide(!showSide)}>
            {showSide ? 'Hide' : 'Show'} {sideCount} subagent events
          </button>
        )}
      </div>
      {items.length === 0 && !working && <Empty>No messages yet.</Empty>}
      {items.map((it, i) => {
        if (it.kind === 'user')
          return (
            <div key={it.e.id} className="message user">
              <div className="bubble">{it.e.text}</div>
            </div>
          );
        if (it.kind === 'system')
          return (
            <p key={it.e.id} className={`sys-line ${it.e.isError ? 'error' : ''}`}>
              {it.e.text}
            </p>
          );
        // assistant text, thinking and tool cards group under the assistant mark
        const prev = items[i - 1];
        const continues = prev && prev.kind !== 'user' && prev.kind !== 'system';
        const body =
          it.kind === 'assistant' ? (
            <>
              {it.e.sidechain && <span className="side-tag">subagent</span>}
              <Markdown text={it.e.text} />
            </>
          ) : (
            <ToolCard use={it.use} result={it.result} pending={it !== lastTool ? null : waiting ? 'waiting' : working ? 'running' : null} />
          );
        return (
          <div key={it.kind === 'tool' ? it.use.id : it.e.id} className="message" style={continues ? { marginTop: -16 } : undefined}>
            {continues ? <span style={{ width: 33, flex: 'none' }} /> : <span className="mark sm">L</span>}
            <div className="assistant-body">{body}</div>
          </div>
        );
      })}
      {children}
      {working && (
        <div className="working">
          <span className="pulse" /> Claude is working…
        </div>
      )}
    </>
  );
}

// ---------- launch dialog ----------

// Search the repos of the Bitbucket workspace. The forge can't search, so the whole list loads once
// (server-side cache, warmed in the background) and is filtered here.
export function RepoPicker({ value, onPick }: { value: string; onPick: (r: Pick<RepoRow, 'name' | 'mainBranch'>) => void }) {
  // only used when the server has no default workspace configured
  const [ws, setWs] = useState(() => storage('lf:bb-ws') ?? '');
  const [askWs, setAskWs] = useState(false);
  const [wsDraft, setWsDraft] = useState('');
  const [list, setList] = useState<{ workspace: string; repos: RepoRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setList(null);
    setErr(null);
    api.repos(ws || undefined).then(
      (r) => (setList(r), setAskWs(false)),
      (e) => (e.needWorkspace ? setAskWs(true) : setErr(e.status === 409 ? 'Connect workbench in Settings to list repos.' : e.message)),
    );
  }, [ws]);
  const recent = recentRepos();
  const needle = q.trim().toLowerCase();
  const matches = needle
    ? (list?.repos ?? []).filter((r) => r.name.toLowerCase().includes(needle) || (r.description ?? '').toLowerCase().includes(needle)).slice(0, 8)
    : recent.map((name) => list?.repos.find((r) => r.name === name) ?? { name, mainBranch: null, updated: null, description: null });
  const pick = (r: Pick<RepoRow, 'name' | 'mainBranch'>) => (onPick(r), setQ(''), setOpen(false));
  if (askWs)
    return (
      <div className="field repo-picker">
        <span>Bitbucket workspace</span>
        <form className="repo-ws" onSubmit={(e) => (e.preventDefault(), /^[\w.-]+$/.test(wsDraft) && (storage('lf:bb-ws', wsDraft), setWs(wsDraft)))}>
          <input className="input mono" value={wsDraft} onChange={(e) => setWsDraft(e.target.value.trim())} placeholder="e.g. acme — set LEGOS_BITBUCKET_WORKSPACE to skip this" />
        </form>
      </div>
    );
  return (
    <div className="field repo-picker">
      <span>Repo</span>
      <input
        className="input mono"
        value={open ? q : value.split('/')[1] ?? value}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onKeyDown={(e) => e.key === 'Enter' && matches[0] && (e.preventDefault(), pick(matches[0]))}
        placeholder={list ? `Search ${list.repos.length} repos` : 'Search repos'}
      />
      {open && (
        <div className="repo-results" role="listbox">
          {matches.length === 0 && <div className="repo-empty">{err ?? (!list ? 'Loading repos…' : needle ? 'No repo matches.' : 'Type to search.')}</div>}
          {matches.map((r) => (
            <button type="button" key={r.name} role="option" aria-selected={r.name === value} className="repo-result" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
              <b className="mono">{r.name.split('/')[1]}</b>
              <span>{r.description ?? (r.updated ? `updated ${ago(r.updated, Date.now())}` : 'recent')}</span>
            </button>
          ))}
          {!needle && list && <div className="repo-empty">Type to search all {list.repos.length} repos.</div>}
        </div>
      )}
      {err && !open && <small className="error">{err}</small>}
    </div>
  );
}

const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask me first (Needs you)' },
  { value: 'acceptEdits', label: 'Auto-accept file edits' },
  { value: 'plan', label: 'Plan only (no changes)' },
];

export function LaunchDialog({
  kind,
  projects,
  resume,
  defaults,
  onClose,
}: {
  kind: RunKind;
  projects: string[];
  resume?: { sessionId: string; cwd: string; recentlyActive: boolean };
  defaults?: { cwd?: string; prompt?: string; ticket?: string };
  onClose: () => void;
}) {
  const [cwd, setCwd] = useState(resume?.cwd ?? defaults?.cwd ?? storage('lf:cwd') ?? '');
  // a fresh clone of a repo (default) or an existing folder on this machine
  const [source, setSource] = useState<'repo' | 'folder'>(() => (resume || defaults?.cwd || storage('lf:source') === 'folder' ? 'folder' : 'repo'));
  const [repo, setRepo] = useState(recentRepos()[0] ?? '');
  const [branch, setBranch] = useState('');
  const [mainBranch, setMainBranch] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(defaults?.prompt ?? '');
  const [mode, setMode] = useState<PermissionMode>('default');
  const [model, setModel] = useState(storage('lf:model') ?? 'default');
  // from a ticket card; otherwise the server finds it in the prompt or branch
  const ticket = defaults?.ticket;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);


  const ready = !!prompt.trim() && (source === 'repo' ? /^[\w.-]+\/[\w.-]+$/.test(repo.trim()) : !!cwd);
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const where = source === 'repo' ? { repo: repo.trim(), branch: branch.trim() || undefined } : { cwd };
      const run = await api.start({ kind, ...where, prompt, permissionMode: mode, resume: resume?.sessionId, model, ticket });
      if (source === 'repo') rememberRepo(repo.trim());
      else storage('lf:cwd', cwd);
      storage('lf:source', source);
      storage('lf:model', model);
      onClose();
      go(`#/runs/${run.id}`);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="launch-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div>
          <h2 id="launch-title">{resume ? 'Continue in chat' : kind === 'task' ? 'New task' : 'New chat'}</h2>
          <p>
            {kind === 'task'
              ? 'Hand off a job: Claude works on it until done, then reports back. No follow-ups — use “Discuss in chat” afterwards.'
              : 'Interactive Claude Code session to discuss and work together. Closes after 30 min idle.'}{' '}
            Uses your settings, MCP servers and skills.
          </p>
        </div>
        {resume?.recentlyActive && <p className="warn">This session was active in the last few minutes. If it's still open in a terminal, continuing here forks the conversation.</p>}
        {!resume && (
          <div className="segmented" role="tablist" aria-label="Where to work">
            <button role="tab" aria-selected={source === 'repo'} className={source === 'repo' ? 'active' : ''} onClick={() => setSource('repo')}>
              Repo
            </button>
            <button role="tab" aria-selected={source === 'folder'} className={source === 'folder' ? 'active' : ''} onClick={() => setSource('folder')}>
              Local folder
            </button>
          </div>
        )}
        {source === 'repo' ? (
          <>
            <RepoPicker value={repo} onPick={(r) => (setRepo(r.name), setMainBranch(r.mainBranch))} />
            <details className="more-options">
              <summary>More options</summary>
              <label className="field">
                <span>Branch</span>
                <input className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={`${mainBranch ?? 'main branch'} (default) — the run starts from the latest commit here`} />
              </label>
            </details>
          </>
        ) : (
          <label className="field">
            <span>Working directory</span>
            <input className="input mono" list="lf-projects" value={cwd} disabled={!!resume} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/you/project" />
            <datalist id="lf-projects">
              {projects.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </label>
        )}
        <label className="field">
          <span>{kind === 'task' ? 'Task' : 'Message'}</span>
          <textarea
            className="input"
            rows={5}
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit()}
            placeholder={kind === 'task' ? 'Describe the job and what “done” looks like' : 'What do you want to discuss?'}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Model</span>
            <ModelSelect value={model} onChange={setModel} />
          </label>
          <label className="field">
            <span>Permissions</span>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {err && <p className="error">{err}</p>}
        <footer>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !ready} onClick={submit}>
            {busy ? (source === 'repo' ? 'Fetching repo…' : 'Starting…') : kind === 'task' ? 'Start task ⌘↵' : 'Start chat ⌘↵'}
          </button>
        </footer>
      </div>
    </div>
  );
}
