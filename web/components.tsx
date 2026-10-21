import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ModelOption, PendingDecision, Run, RunKind, ShareLevel, TimelineEvent, Usage } from '../shared/types.ts';
import { api, ago, applyTheme, fmtTokens, projectName, storage, useFetch, useNow, type Conn, type JiraRow, type RepoRow, type Theme } from './api.ts';
import type { LaunchReq } from './chrome.tsx';
import { Icon } from './icons.tsx';
import { visibleEvents } from './lib/thread.ts';

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

function ToolCard({ use, result, pending }: { use: TimelineEvent; result: TimelineEvent | null; pending: 'running' | null }) {
  const status = result ? (result.isError ? 'Error' : 'Completed') : pending === 'running' ? 'Running…' : 'No result';
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
  queued,
  showTools = true,
  title,
  children,
}: {
  events: TimelineEvent[];
  // the agent is mid-turn
  working?: boolean;
  // waiting for a free slot, so nothing is running yet
  queued?: boolean;
  // tool calls clutter a live run; the transcript keeps them
  showTools?: boolean;
  title?: ReactNode;
  children?: ReactNode;
}) {
  const [showSide, setShowSide] = useState(false);
  const sideCount = events.filter((e) => e.sidechain).length;
  const items = toItems(visibleEvents(events, { showTools, showSide }));
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
      {items.length === 0 && !working && !queued && <Empty>No messages yet.</Empty>}
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
            <ToolCard use={it.use} result={it.result} pending={it !== lastTool ? null : working ? 'running' : null} />
          );
        return (
          <div key={it.kind === 'tool' ? it.use.id : it.e.id} className="message" style={continues ? { marginTop: -16 } : undefined}>
            {continues ? <span style={{ width: 33, flex: 'none' }} /> : <span className="mark sm">L</span>}
            <div className="assistant-body">{body}</div>
          </div>
        );
      })}
      {children}
      {working && <Thinking label="thinking" />}
      {queued && <Thinking label="queued" />}
    </>
  );
}

// The agent's turn in progress: a trail of cells whose light sweeps back and forth.
function Thinking({ label }: { label: string }) {
  return (
    <div className="thinking" role="status" aria-live="polite">
      <span className="thinking-cells" aria-hidden="true">
        {Array.from({ length: 10 }, (_, i) => (
          <i key={i} style={{ '--i': i } as CSSProperties} />
        ))}
      </span>
      <span className="thinking-label">{label}</span>
    </div>
  );
}

// ---------- launch dialog ----------

// Search the repos of a Bitbucket workspace (the server's default when none is given). The forge can't
// search, so the whole list loads once (server-side cache) and is filtered here.
export function RepoPicker({ workspace, onPick }: { workspace: string; onPick: (r: RepoRow) => void }) {
  const [list, setList] = useState<{ workspace: string; repos: RepoRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setList(null);
    setErr(null);
    api.repos(workspace || undefined).then(setList, (e) =>
      setErr(e.needWorkspace ? 'Type your Bitbucket workspace first.' : e.status === 409 ? 'Connect workbench in Settings to list repos.' : e.message),
    );
  }, [workspace]);
  const needle = q.trim().toLowerCase();
  const matches = needle ? (list?.repos ?? []).filter((r) => r.name.toLowerCase().includes(needle) || (r.description ?? '').toLowerCase().includes(needle)).slice(0, 8) : [];
  const pick = (r: RepoRow) => (onPick(r), setQ(''), setOpen(false));
  return (
    <div className="field repo-picker">
      <span>Repo</span>
      <input
        className="input mono"
        value={q}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onKeyDown={(e) => e.key === 'Enter' && matches[0] && (e.preventDefault(), pick(matches[0]))}
        placeholder={list ? `Search ${list.repos.length} repos` : 'Search repos'}
      />
      {open && (
        <div className="repo-results" role="listbox">
          {matches.length === 0 && <div className="repo-empty">{err ?? (!list ? 'Loading repos…' : needle ? 'No repo matches.' : `Type to search all ${list.repos.length} repos.`)}</div>}
          {matches.map((r) => (
            <button type="button" key={r.name} role="option" className="repo-result" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
              <b className="mono">{r.name.split('/')[1]}</b>
              <span>{r.description ?? (r.updated ? `updated ${ago(r.updated, Date.now())}` : 'recent')}</span>
            </button>
          ))}
        </div>
      )}
      {err && !open && <small className="error">{err}</small>}
    </div>
  );
}

// ---------- launch dialog ----------

const TICKET_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

// A choice in the dialog: what it is, and what it means.
function IntentCard({ on, title, hint, onClick }: { on: boolean; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      style={{
        flex: '1 1 150px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
        textAlign: 'left',
        padding: '12px 14px',
        borderRadius: 12,
        border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
        background: on ? 'var(--soft)' : 'var(--paper)',
        boxShadow: on ? '0 0 0 3px rgba(98, 89, 219, 0.13)' : undefined,
        color: 'var(--ink)',
        font: 'inherit',
        cursor: 'pointer',
      }}
    >
      <b style={{ fontSize: 14 }}>{title}</b>
      <span className="muted" style={{ fontSize: 11.5 }}>{hint}</span>
    </button>
  );
}

// One repo of the list: picked or not, and where it comes from.
function RepoRow({ name, on, source, onToggle }: { name: string; on: boolean; source: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={onToggle}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minHeight: 46,
        width: '100%',
        padding: '0 14px',
        borderRadius: 10,
        border: `1px solid ${on ? 'var(--run-edge)' : 'var(--line)'}`,
        background: on ? 'var(--run-tint)' : 'var(--paper)',
        color: 'var(--ink)',
        fontFamily: 'var(--mono)',
        fontSize: 13,
        fontWeight: 500,
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          flex: 'none',
          borderRadius: 5,
          display: 'grid',
          placeItems: 'center',
          border: `1.5px solid ${on ? 'var(--accent)' : '#a6adbd'}`,
          background: on ? 'var(--accent)' : 'var(--paper)',
          color: '#fff',
        }}
      >
        {on && <Icon name="check" size={12} />}
      </span>
      {name}
      <span className="muted" style={{ marginLeft: 'auto', fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 600 }}>{source}</span>
    </button>
  );
}

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
  defaults?: LaunchReq['defaults'];
  onClose: () => void;
}) {
  const [intent, setIntent] = useState<'chat' | 'task'>(kind);
  const [prompt, setPrompt] = useState(defaults?.prompt ?? '');
  const [ticket, setTicket] = useState<{ key: string; summary: string } | null>(null);
  const [start, setStart] = useState<'spec' | 'brainstorm'>('spec');
  const [picked, setPicked] = useState<string[]>([]);
  const [folder, setFolder] = useState('');
  const [folderPicked, setFolderPicked] = useState(false);
  const [model, setModel] = useState(defaults?.model ?? storage('lf:model') ?? 'default');
  const [branch, setBranch] = useState(defaults?.branch ?? '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<JiraRow[] | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { data: mine, error: mineErr } = useFetch(api.myRepos, []);
  const models = useModels();
  const repos = useMemo(() => mine?.repos ?? [], [mine]);
  const project = ticket?.key.split('-')[0] ?? '';
  // the repos the ticket's project is mapped to
  const mapped = useMemo(
    () => (project ? repos.filter((r) => r.projects.some((p) => p.toUpperCase() === project.toUpperCase())).map((r) => r.name) : []),
    [repos, project],
  );

  // the ticket the caller opened the dialog with
  useEffect(() => {
    const key = defaults?.ticket;
    if (!key) return;
    let alive = true;
    api.jiraIssue(key).then(
      (issue) => alive && setTicket({ key: issue.key, summary: issue.summary }),
      (e) => alive && (setTicket({ key, summary: '' }), setErr(e.message)),
    );
    return () => {
      alive = false;
    };
  }, [defaults?.ticket]);

  // a ticket brings its mapped repos; without one the first repo is the one that runs
  useEffect(() => {
    if (!mine) return;
    const named = defaults?.repo && mine.repos.some((r) => r.name === defaults.repo) ? [defaults.repo] : [];
    setPicked(ticket ? [...new Set([...mapped, ...named])] : named.length ? named : mine.repos.slice(0, 1).map((r) => r.name));
  }, [mine, ticket?.key]);

  const search = async (q: string) => {
    const key = q.trim().toUpperCase();
    setSearchErr(null);
    try {
      if (TICKET_KEY_RE.test(key)) {
        const issue = await api.jiraIssue(key);
        setResults([issue]);
      } else {
        const found = await api.jiraSearch(`text ~ "${q.trim().replace(/"/g, '')}" ORDER BY updated DESC`);
        setResults(found.issues);
      }
    } catch (e: any) {
      setResults([]);
      setSearchErr(e.message);
    }
  };

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => void search(q), 300);
    return () => clearTimeout(t);
  }, [query]);

  const typedKey = TICKET_KEY_RE.test(query.trim().toUpperCase()) ? query.trim().toUpperCase() : null;

  const attach = (issue: JiraRow) => {
    setTicket({ key: issue.key, summary: issue.summary });
    setQuery('');
    setResults(null);
  };

  const attachTyped = async () => {
    if (!typedKey || busy) return;
    setBusy(true);
    setSearchErr(null);
    try {
      const issue = await api.jiraIssue(typedKey);
      attach(issue);
    } catch (e: any) {
      setSearchErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (name: string) =>
    setPicked((p) => {
      if (ticket) return p.includes(name) ? p.filter((x) => x !== name) : [...p, name];
      return p[0] === name ? [] : [name];
    });

  // the folder a chat runs in: a repo of mine, or nothing
  const chatFolder = resume ? `dir:${resume.cwd}` : folderPicked ? folder : repos[0] ? `repo:${repos[0].name}` : '';
  const chatWhere = chatFolder.startsWith('repo:') ? { repo: chatFolder.slice(5) } : chatFolder.startsWith('dir:') ? { cwd: chatFolder.slice(4) } : {};

  const modelOptions = models.filter((m) => m.value !== 'default');
  const modelValues = model === 'default' || modelOptions.some((m) => m.value === model) ? modelOptions : [...modelOptions, { value: model, displayName: model, description: '' }];
  const mainBranch = repos.find((r) => r.name === picked[0])?.mainBranch ?? null;

  const n = picked.length;
  const names = picked.join(', ');
  const summary = !ticket
    ? n
      ? `One task in ${names}, in auto mode`
      : 'Pick a repo'
    : start === 'brainstorm'
      ? `A brainstorm chat on ${ticket.key}, then a spec for ${n || 'no'} repo${n === 1 ? '' : 's'}`
      : `Spec PR for ${names || 'no repo'}, then build and agent review on their own`;
  const fine = !ticket
    ? 'Runs to the end on its own. A command outside the allowlist pauses it and comes to Home.'
    : start === 'brainstorm'
      ? 'Spec, build and agent review then run on their own. You are asked at spec review, at PR review if rules route it, and to merge.'
      : 'You are asked at spec review, at PR review if rules route it, and to merge. Jira follows each step.';
  const cta = intent === 'chat' ? 'Start chat' : !ticket ? (n ? 'Start task' : 'Pick a repo') : start === 'brainstorm' ? 'Start brainstorm' : n ? `Start · ${n} repo${n === 1 ? '' : 's'}` : 'Pick a repo';

  const ready = intent === 'chat' ? !!prompt.trim() : ticket ? n > 0 : n === 1 && !!prompt.trim();
  const ticketText = ticket ? (ticket.summary ? `${ticket.key}: ${ticket.summary}` : ticket.key) : '';

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const runs: Run[] = [];
      if (intent === 'chat') {
        runs.push(await api.start({ kind: 'chat', prompt, permissionMode: 'default', resume: resume?.sessionId, ...chatWhere }));
      } else if (!ticket) {
        runs.push(await api.start({ kind: 'task', repo: picked[0], prompt, permissionMode: 'default', branch: branch.trim() || undefined, model }));
      } else {
        // the run needs a work item that carries its repo, or the server refuses it
        await api.setWorkItemRepos(ticket.key, picked);
        if (start === 'brainstorm') {
          runs.push(await api.start({ kind: 'chat', stage: 'design', persona: 'foreman', ticket: ticket.key, repo: picked[0], prompt: `Discuss ${ticketText}`, permissionMode: 'default' }));
        } else {
          for (const repo of picked) {
            runs.push(await api.start({ kind: 'task', stage: 'design', persona: 'foreman', ticket: ticket.key, repo, prompt: `Implement ${ticketText}`, permissionMode: 'default', branch: branch.trim() || undefined, model }));
          }
        }
      }
      storage('lf:model', model);
      onClose();
      go(runs.length === 1 ? `#/runs/${runs[0].id}` : '#/work');
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  // ⌘↵ starts from anywhere in the dialog.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submitRef.current();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        style={{ width: 'min(640px, 100%)', maxHeight: 'calc(100dvh - 32px)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 id="launch-title">Start something</h2>
          <button className="icon" aria-label="Close" onClick={onClose} style={{ marginLeft: 'auto' }}>
            <Icon name="close" size={16} />
          </button>
        </div>

        {resume?.recentlyActive && <p className="warn">This session was active in the last few minutes. If it's still open in a terminal, continuing here forks the conversation.</p>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, overflow: 'auto' }}>
          <div role="radiogroup" aria-label="What do you want to do" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <IntentCard on={intent === 'chat'} title="Chat" hint="Think it through together" onClick={() => setIntent('chat')} />
            <IntentCard on={intent === 'task'} title="Task" hint="Runs on its own to the end" onClick={() => setIntent('task')} />
          </div>

          {intent === 'chat' ? (
            <>
              <label className="field">
                <span>Start the conversation</span>
                <textarea
                  className="input"
                  rows={5}
                  autoFocus
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Ask anything, or paste a ticket key to brief on it"
                />
              </label>
              <label className="field">
                <span>Folder</span>
                <select
                  className="input mono"
                  value={chatFolder}
                  disabled={!!resume}
                  onChange={(e) => {
                    setFolder(e.target.value);
                    setFolderPicked(true);
                  }}
                >
                  <option value="">No folder, just talk</option>
                  {repos.map((r) => (
                    <option key={r.name} value={`repo:${r.name}`}>
                      {r.name}
                    </option>
                  ))}
                  {resume && <option value={`dir:${resume.cwd}`}>{resume.cwd}</option>}
                </select>
              </label>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>Ticket</span>
                  <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>optional · attaching one makes it tracked work</span>
                </div>
                {ticket ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: '1px solid var(--run-edge)', borderRadius: 12, background: 'var(--run-tint)' }}>
                    <span className="ticket-chip">{ticket.key}</span>
                    <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{ticket.summary}</span>
                    <button type="button" className="text-action" onClick={() => setTicket(null)}>
                      Remove
                    </button>
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        className="input"
                        type="search"
                        autoFocus
                        placeholder="Search Jira by key or title"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && void search(query)}
                      />
                      <button className="btn" disabled={!typedKey || busy} onClick={attachTyped}>
                        Attach {typedKey ?? 'ticket'}
                      </button>
                    </div>
                    {searchErr && <p className="error">{searchErr}</p>}
                    {results && results.length > 0 && (
                      <div className="list-card">
                        {results.map((r) => (
                          <div className="list-item" key={r.key}>
                            <TicketChip ticket={r.key} />
                            <div className="copy">
                              <b>{r.summary}</b>
                            </div>
                            <button className="btn sm" onClick={() => attach(r)}>
                              Attach {r.key}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <label className="field">
                      <span>What should it do?</span>
                      <textarea
                        className="input"
                        rows={4}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="e.g. Upgrade the lint rules and fix what breaks"
                      />
                    </label>
                  </>
                )}
              </div>

              {ticket && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>Start with</span>
                  <div role="radiogroup" aria-label="Start with" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <IntentCard on={start === 'spec'} title="Spec" hint="Agent writes the spec PR; you review it" onClick={() => setStart('spec')} />
                    <IntentCard on={start === 'brainstorm'} title="Brainstorm first" hint="Talk it through, then the spec" onClick={() => setStart('brainstorm')} />
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>Repos</span>
                  <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>{ticket ? 'one pipeline each, in parallel' : 'where the task runs'}</span>
                </div>
                {mineErr && <p className="error">{mineErr}</p>}
                {!mine && !mineErr && <p className="muted">Loading repos…</p>}
                {mine && !repos.length && (
                  <div className="empty">
                    No repos yet — add them in{' '}
                    <a href="#/settings" onClick={onClose}>
                      Settings
                    </a>
                  </div>
                )}
                {repos.map((r) => (
                  <RepoRow
                    key={r.name}
                    name={r.name}
                    on={picked.includes(r.name)}
                    source={mapped.includes(r.name) ? `from ${project} → repo mapping` : 'in My repos'}
                    onToggle={() => toggle(r.name)}
                  />
                ))}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '14px 16px', borderRadius: 12, background: 'var(--field)' }}>
                <b style={{ fontSize: 13.5 }}>{summary}</b>
                <span className="muted" style={{ fontSize: 12 }}>{fine}</span>
              </div>

              <details className="more-options">
                <summary>More options · model, base branch</summary>
                <div className="field-row">
                  <label className="field">
                    <span>Model</span>
                    <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                      <option value="default">Account default</option>
                      {modelValues.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Base branch</span>
                    <input className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={mainBranch ?? 'main'} />
                  </label>
                </div>
              </details>
            </>
          )}
        </div>

        {err && <p className="error">{err}</p>}
        <footer style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <span className="muted" style={{ fontSize: 12 }}>⌘↵ to start</span>
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !ready} onClick={submit}>
            {busy ? 'Starting…' : cta}
          </button>
        </footer>
      </div>
    </div>
  );
}
