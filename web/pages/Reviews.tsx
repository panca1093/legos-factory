import { useEffect, useState } from 'react';
import { api, ago, storage, useFetch, useNow, type ReviewRequest } from '../api.ts';
import { Empty } from '../components.tsx';
import { Frame } from '../chrome.tsx';

// Open PRs from others that want you: you're a reviewer, or someone @-mentioned you.
export function Reviews() {
  const now = useNow(60000);
  const [refresh, setRefresh] = useState(0);
  const { data, error } = useFetch(() => api.reviews(refresh > 0), [refresh]);
  const [loading, setLoading] = useState(false);
  useEffect(() => setLoading(false), [data, error]);
  const reload = () => (setLoading(true), setRefresh((n) => n + 1));
  // Bitbucket name to match on, when the one guessed from your email is wrong
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(() => storage('lf:bb-name') ?? '');
  const [ws, setWs] = useState(() => storage('lf:bb-ws') ?? '');
  const saveName = () => {
    storage('lf:bb-name', name.trim());
    if (/^[\w.-]+$/.test(ws.trim())) storage('lf:bb-ws', ws.trim());
    setNaming(false);
    reload();
  };
  const noWorkspace = !!data && !data.workspace;
  const rows: ReviewRequest[] = data?.items ?? [];
  const todo = rows.filter((p) => !p.approvedByMe);
  return (
    <Frame crumb={<span>Workspace / Reviews</span>}>
      <div className="scroll">
        <div className="page">
          <div className="page-heading">
            <div>
              <h1>Reviews</h1>
              <p className="lead">Pull requests from others that are waiting on you: you're a reviewer, or someone mentioned you.</p>
            </div>
            <button className="btn sm ghost" disabled={loading} onClick={reload}>
              {loading ? 'Checking…' : 'Refresh'}
            </button>
          </div>
          {error && (
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
          {(naming || /Bitbucket name/.test(error ?? '') || (noWorkspace && rows.length === 0)) && (
            <div className="pr-box name-box">
              <label className="field">
                Bitbucket workspace, where your team's repos live
                <input className="input" value={ws} placeholder="e.g. acme" autoFocus={noWorkspace} onChange={(e) => setWs(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveName()} />
              </label>
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
          {!data ? (
            !error && <Empty>Looking through your repos' open pull requests…</Empty>
          ) : data.searched.length === 0 ? (
            <Empty>No repos to look in yet. Set your Bitbucket workspace above, and its most active repos are checked for review requests.</Empty>
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
              Checked the {data.scanned} most recently updated open PRs in {data.searched.length} repo{data.searched.length === 1 ? '' : 's'}
              {data.workspace ? ` (yours plus ${data.workspace}'s most active)` : ''}, matching you as “{data.me}”{data.matchedById ? ' by Bitbucket account' : ' by name'} (
              <button type="button" className="text-action" onClick={() => setNaming(true)}>
                change
              </button>
              ) · {ago(data.at, now)}.
            </p>
          )}
        </div>
      </div>
    </Frame>
  );
}
