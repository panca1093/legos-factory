import { useState } from 'react';
import type { Run, RunKind } from '../../shared/types.ts';
import { api, ago, projectName, storage, useFetch, useNow } from '../api.ts';
import { TicketChip, StatusPill, runTone } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { ALIVE, type Live, type LaunchReq, useReview, Frame } from '../chrome.tsx';
import { JiraIssues } from './Jira.tsx';

export function Tasks({ live, onNew }: { live: Live; onNew: (k: RunKind, defaults?: LaunchReq['defaults']) => void }) {
  const now = useNow(10000);
  const conns = useFetch(api.connections, []);
  const hasWorkbench = !!conns.data?.connections.some((c) => c.kind === 'workbench' && c.connected);
  const [picked, setSource] = useState<'tasks' | 'jira'>(() => (storage('lf:tasks-tab') === 'jira' ? 'jira' : 'tasks'));
  const source = hasWorkbench ? picked : 'tasks';
  const pickSource = (v: 'tasks' | 'jira') => (setSource(v), storage('lf:tasks-tab', v));
  const review = useReview();
  const [filter, setFilter] = useState<'all' | 'active' | 'needs' | 'done' | 'failed'>('all');
  // discussed tasks stay listed while they're chats
  const tasks = [...live.runs.values()].filter((r) => r.kind === 'task' || r.fromTask).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const match = (r: Run) =>
    filter === 'all' ||
    (filter === 'active' && ALIVE.includes(r.status)) ||
    (filter === 'needs' && r.status === 'awaiting_decision') ||
    (filter === 'done' && r.status === 'completed') ||
    (filter === 'failed' && r.status === 'failed');
  const shown = tasks.filter(match);
  const pendingOf = (runId: string) => [...live.decisions.values()].find((d) => d.runId === runId);
  return (
    <Frame
      crumb={
        <>
          <span>Workspace / </span>Tasks
        </>
      }
    >
      <div className="scroll">
        <div className="page">
          <div className="page-heading" style={{ alignItems: 'center' }}>
            <div>
              <h1>Tasks</h1>
              <p className="lead">Jobs you handed off. Each runs to completion on its own and reports back.</p>
              {hasWorkbench && (
                <div className="segmented source-tabs" role="tablist" aria-label="Task source">
                  <button role="tab" aria-selected={source === 'tasks'} className={source === 'tasks' ? 'active' : ''} onClick={() => pickSource('tasks')}>
                    Your tasks <span className="tab-count">{tasks.length}</span>
                  </button>
                  <button role="tab" aria-selected={source === 'jira'} className={source === 'jira' ? 'active' : ''} onClick={() => pickSource('jira')}>
                    From Jira
                  </button>
                </div>
              )}
            </div>
            <button className="btn primary" onClick={() => onNew('task')}>
              <Icon name="plus" size={15} /> New task
            </button>
          </div>
          {source === 'jira' ? (
            <JiraIssues live={live} onNew={onNew} />
          ) : (
          <>
          <div className="tool-bar">
            <div className="segmented" role="tablist">
              {(
                [
                  ['all', 'All'],
                  ['active', 'Running'],
                  ['needs', 'Needs you'],
                  ['done', 'Done'],
                  ['failed', 'Failed'],
                ] as const
              ).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {tasks.length === 0 ? (
            <div className="empty">
              <p style={{ marginBottom: 12 }}>No tasks yet. Hand off a job — a fix, a review, a refactor — and come back for the result.</p>
              <button className="btn primary" onClick={() => onNew('task')}>
                <Icon name="spark" size={15} /> New task
              </button>
            </div>
          ) : shown.length === 0 ? (
            <div className="empty">No tasks match.</div>
          ) : (
            <div className="list-card">
              {shown.map((r) => {
                const tone = runTone(r);
                return (
                  <a key={r.id} className="list-item" href={`#/runs/${r.id}`}>
                    <span className={`glyph tone-${tone}`}>
                      <Icon name={tone === 'good' ? 'check' : tone === 'alert' ? 'close' : 'spark'} size={16} />
                    </span>
                    <div className="copy">
                      <b>{r.prompt.split('\n')[0]}</b>
                      <span>
                        {r.ticket && <TicketChip ticket={r.ticket} />} {projectName(r.cwd)} · {r.model ?? r.requestedModel} · started {ago(r.startedAt, now)}
                        {r.status === 'failed' && r.error && <span className="error"> · {r.error.split('\n')[0]}</span>}
                      </span>
                    </div>
                    <div className="side">
                      {pendingOf(r.id) ? (
                        <button
                          className="btn sm primary"
                          onClick={(e) => {
                            e.preventDefault();
                            review(pendingOf(r.id)!.id);
                          }}
                        >
                          Review
                        </button>
                      ) : (
                        <StatusPill run={r} />
                      )}
                      <div style={{ marginTop: 4 }}>{r.estimatedCostUsd === null ? '' : `~$${r.estimatedCostUsd.toFixed(2)} est.`}</div>
                    </div>
                  </a>
                );
              })}
            </div>
          )}
          <p className="footnote">Tasks live in memory while the server runs; their transcripts stay under Sessions.</p>
          </>
          )}
        </div>
      </div>
    </Frame>
  );
}
