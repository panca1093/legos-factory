import { useState } from 'react';
import type { Run, RunKind } from '../../shared/types.ts';
import { api, ago, projectName, useFetch, useNow } from '../api.ts';
import { ApprovalCard, Empty, ModelSelect, ShareBadge, TicketChip, StatusPill, Thread, runTone } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { ALIVE, type Live, type ResumeReq, type LaunchReq, useReview, useStickyScroll, Frame } from '../chrome.tsx';

export function RunView({
  id,
  live,
  onContinue,
  onNew,
}: {
  id: string;
  live: Live;
  onContinue: (r: ResumeReq) => void;
  onNew: (k: RunKind, defaults?: LaunchReq['defaults']) => void;
}) {
  const now = useNow(5000);
  const review = useReview();
  const fetched = useFetch(() => api.run(id), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Prefer live state; fall back to fetched (e.g. after a hard refresh before the snapshot lands).
  const run = live.runs.get(id) ?? fetched.data;
  const pending = [...live.decisions.values()].filter((d) => d.runId === id);
  const scroll = useStickyScroll(`${run?.events.length}:${pending.length}:${run?.status}`);

  if (!run) {
    return (
      <Frame
        crumb={
          <>
            <span>Runs / </span>Unknown
          </>
        }
      >
        <div className="page">
          {fetched.error ? (
            <Empty>This run isn't known to the server — runs live in memory and are cleared on restart. Its transcript is still under Sessions.</Empty>
          ) : (
            <Empty>Loading run…</Empty>
          )}
        </div>
      </Frame>
    );
  }
  const alive = ALIVE.includes(run.status);
  const working = alive && run.status !== 'idle';
  const paused = live.conn !== 'connected';
  const toolCalls = run.events.filter((e) => e.kind === 'tool_use').length;
  const toolErrors = run.events.filter((e) => e.kind === 'tool_result' && e.isError).length;

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  const cont = () => run.sessionId && onContinue({ sessionId: run.sessionId, cwd: run.cwd, recentlyActive: false });
  const isTask = run.kind === 'task';
  const runAgain = () => onNew('task', { cwd: run.cwd, prompt: run.prompt });
  const modeLabel = run.permissionMode === 'default' ? 'Ask before tools' : run.permissionMode === 'acceptEdits' ? 'Auto-accept edits' : 'Plan only';

  const inspector = (
    <>
      <div className="inspect-head">
        <h3>Context</h3>
        <StatusPill run={run} />
      </div>
      <section>
        <div className="section-title">Current session</div>
        <div className="inspect-item">
          Runtime <b>Claude Code</b>
        </div>
        <div className="inspect-item">
          Mode <b>{isTask ? 'Task' : run.fromTask ? 'Chat · from task' : 'Chat'}</b>
        </div>
        <div className="inspect-item">
          Ticket <b>{run.ticket ? <TicketChip ticket={run.ticket} /> : 'None'}</b>
        </div>
        <div className="inspect-item">
          Team sharing <ShareBadge share={run.share} />
        </div>
        <div className="inspect-item">
          Model <b>{run.model ?? run.requestedModel}</b>
        </div>
        <div className="inspect-item">
          Turns <b>{run.turns}</b>
        </div>
        <div className="inspect-item">
          {alive ? 'Last event' : 'Ended'}{' '}
          <b>
            {ago(alive ? run.lastEventAt : run.endedAt, now)}
            {run.endedBy === 'idle_timeout' ? ' · idle' : ''}
          </b>
        </div>
        <div className="inspect-item" title="Claude Code's API-equivalent estimate. Not an invoice; subscription usage may be included in your plan.">
          Cost <b>{run.estimatedCostUsd === null ? 'Unknown yet' : `~$${run.estimatedCostUsd.toFixed(2)} est.`}</b>
        </div>
        <div className="inspect-item">
          Permissions <b>{modeLabel}</b>
        </div>
      </section>
      <section>
        <div className="section-title">Working directory</div>
        <p className="inspect-path">{run.cwd}</p>
      </section>
      <section>
        <div className="section-title">In this thread</div>
        <div className="inspect-item">
          Tool calls <b>{toolCalls}</b>
        </div>
        <div className="inspect-item">
          Tool errors <b className={toolErrors ? 'error' : ''}>{toolErrors}</b>
        </div>
        <div className="inspect-item">
          Waiting on you <b>{pending.length}</b>
        </div>
      </section>
      <section>
        <div className="section-title">Quick actions</div>
        {isTask ? (
          alive ? (
            <button className="inspect-action danger" disabled={!!busy || paused} onClick={() => act('end', () => api.end(id))}>
              <Icon name="close" size={14} /> Cancel task
            </button>
          ) : (
            <>
              <button className="inspect-action" disabled={!run.sessionId} onClick={cont}>
                <Icon name="chat" size={14} /> Discuss in chat
              </button>
              <button className="inspect-action" onClick={runAgain}>
                <Icon name="spark" size={14} /> Run again
              </button>
            </>
          )
        ) : alive ? (
          <>
            <button className="inspect-action" disabled={!working || !!busy || paused} onClick={() => act('interrupt', () => api.interrupt(id))}>
              <Icon name="stop" size={14} /> Stop current turn
            </button>
            <button className="inspect-action danger" disabled={!!busy || paused} onClick={() => act('end', () => api.end(id))}>
              <Icon name="close" size={14} /> End session
            </button>
          </>
        ) : (
          <button className="inspect-action" disabled={!run.sessionId} onClick={cont}>
            <Icon name="chat" size={14} /> Continue session
          </button>
        )}
        {run.sessionId && (
          <a className="inspect-action" href={`#/sessions/${run.sessionId}`}>
            <Icon name="clock" size={14} /> Full transcript
          </a>
        )}
      </section>
    </>
  );

  return (
    <Frame
      crumb={
        <>
          <span>{isTask || run.fromTask ? 'Tasks / ' : 'Chats / '}</span>
          {run.prompt.split('\n')[0]}
        </>
      }
      inspector={inspector}
    >
      <div className="chat">
        <div className="thread" ref={scroll.ref} onScroll={scroll.onScroll}>
          <Thread
            events={run.events}
            // a queued run hasn't started: the queue notice stands in for the working cursor
            working={working && pending.length === 0 && run.status !== 'queued'}
            queued={run.status === 'queued'}
            showTools={false}
            title={
              <>
                {projectName(run.cwd)} · started {new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {run.resumedFrom ? ' · continued session' : ''}
              </>
            }
          >
            {pending.map((d) => (
              <div key={d.id} className="message">
                <span className="mark sm">L</span>
                <div className="assistant-body">
                  <ApprovalCard d={d} conn={live.conn} onReview={review} />
                </div>
              </div>
            ))}
            {run.error && !isTask && <p className="sys-line error">Last turn failed: {run.error}</p>}
          </Thread>
        </div>
        {isTask ? (
          <TaskBar run={run} busy={!!busy} paused={paused} err={err} onCancel={() => act('end', () => api.end(id))} onDiscuss={cont} onRunAgain={runAgain} />
        ) : alive ? (
          <Composer
            key={id}
            initialModel={run.requestedModel}
            working={working}
            paused={paused}
            busy={busy}
            err={err}
            onSend={(text) => act('send', () => api.send(id, text))}
            onInterrupt={() => act('interrupt', () => api.interrupt(id))}
            onModel={(m) => act('model', () => api.setModel(id, m))}
            onResumeTask={run.fromTask ? (text) => act('resume', () => api.resumeTask(id, text)) : undefined}
          />
        ) : (
          <div className="ended-bar">
            <Icon name="clock" size={16} />
            <span className="grow">
              {run.status === 'failed' ? 'This run failed.' : run.endedBy === 'idle_timeout' ? 'Session closed after 30 min idle.' : 'Session ended.'} Continue it to pick up where it left off.
            </span>
            <button className="btn sm primary" disabled={!run.sessionId} onClick={cont}>
              Continue session
            </button>
          </div>
        )}
      </div>
    </Frame>
  );
}

function Composer({
  initialModel,
  working,
  paused,
  busy,
  err,
  onSend,
  onInterrupt,
  onModel,
  onResumeTask,
}: {
  onResumeTask?: (text: string) => Promise<void>;
  initialModel: string;
  working: boolean;
  paused: boolean;
  busy: string | null;
  err: string | null;
  onSend: (text: string) => Promise<void>;
  onInterrupt: () => void;
  onModel: (m: string) => void;
}) {
  const [text, setText] = useState('');
  const [model, setModel] = useState(initialModel);
  const send = async () => {
    if (!text.trim() || paused) return;
    const t = text;
    setText('');
    await onSend(t);
  };
  return (
    <div className="composer-wrap">
      {onResumeTask && (
        <div className="resume-bar">
          <Icon name="spark" size={15} />
          <span className="grow">This chat started as a task. Done discussing? Hand it back and it runs to completion.</span>
          <button
            className="btn sm primary"
            disabled={working || paused || !!busy}
            title={working ? 'Wait for Claude to finish this turn' : 'Optional: type an instruction first, it goes along'}
            onClick={async () => {
              const t = text;
              setText('');
              await onResumeTask(t);
            }}
          >
            Continue task{text.trim() ? ' with this note' : ''}
          </button>
        </div>
      )}
      <div className="composer">
        <textarea
          aria-label="Message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && send()}
          placeholder={working ? 'Claude is working — a message now is queued for after this step' : 'Reply to Claude…'}
        />
        <div className="composer-bottom">
          <ModelSelect
            chip
            value={model}
            disabled={paused}
            onChange={(m) => {
              setModel(m);
              onModel(m);
            }}
          />
          <span className="composer-hint">{err ? <span className="error">{err}</span> : paused ? 'Reconnecting… sending paused' : 'Model change applies next turn'}</span>
          {working && (
            <button className="stop" style={{ marginLeft: 'auto' }} aria-label="Stop current turn" title="Stop current turn" disabled={!!busy || paused} onClick={onInterrupt}>
              <Icon name="stop" size={15} />
            </button>
          )}
          <button className="send" style={working ? { marginLeft: 0 } : undefined} aria-label="Send" title="Send (⌘↵)" disabled={!text.trim() || paused || busy === 'send'} onClick={send}>
            <Icon name="send" size={16} />
          </button>
        </div>
      </div>
      <p className="composer-meta">Interactive Claude Code session · ⌘↵ to send · closes after 30 min idle</p>
    </div>
  );
}

function TaskBar({
  run,
  busy,
  paused,
  err,
  onCancel,
  onDiscuss,
  onRunAgain,
}: {
  run: Run;
  busy: boolean;
  paused: boolean;
  err: string | null;
  onCancel: () => void;
  onDiscuss: () => void;
  onRunAgain: () => void;
}) {
  const now = useNow(5000);
  const tone = runTone(run);
  if (ALIVE.includes(run.status)) {
    return (
      <div className="ended-bar">
        <span className="pulse" />
        <span className="grow">
          {run.status === 'awaiting_decision'
            ? 'Task is waiting for your approval above.'
            : run.status === 'queued'
              ? 'Queued: too many runs are live right now; it starts on its own when one ends.'
              : `Claude is working on this task · last event ${ago(run.lastEventAt, now)}.`} The result will appear here.
          {err && <span className="error"> {err}</span>}
        </span>
        <button className="btn sm danger" disabled={busy || paused} onClick={onCancel}>
          Cancel task
        </button>
      </div>
    );
  }
  const seconds = run.endedAt ? Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000) : null;
  const took = seconds === null ? '' : seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
  return (
    <div className={`task-result tone-box-${tone}`}>
      <div className="callout">
        <span className="ic">
          <Icon name={tone === 'good' ? 'check' : 'close'} size={15} />
        </span>
        <div>
          <b>{run.status === 'failed' ? 'Task failed' : run.endedBy === 'user' ? 'Task cancelled' : 'Task done'}</b>
          <span>
            {took && `Took ${took}`}
            {run.estimatedCostUsd !== null && ` · ~$${run.estimatedCostUsd.toFixed(2)} est.`}
            {run.status === 'failed' && run.error && ` · ${run.error.split('\n')[0]}`}
          </span>
        </div>
        <div className="task-actions">
          <button className="btn sm" onClick={onRunAgain}>
            Run again
          </button>
          <button className="btn sm primary" disabled={!run.sessionId} onClick={onDiscuss}>
            Discuss in chat
          </button>
        </div>
      </div>
    </div>
  );
}
