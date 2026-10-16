import { useEffect, useState } from 'react';
import { MY_REPOS_CAP, api, storage, type Connection, type Integration, type MyRepo } from '../api.ts';
import { RepoPicker } from '../components.tsx';
import { Frame } from '../chrome.tsx';

export function SettingsPage() {
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const loadConns = () => api.connections().then((r) => (setConns(r.connections), setConnError(null), r.connections), (e) => (setConnError(e.message), null));
  useEffect(() => {
    loadConns();
  }, []);
  const wb = conns?.find((c) => c.kind === 'workbench' && c.connected);
  return (
    <Frame
      crumb={
        <>
          <span>Workspace / </span>Settings
        </>
      }
    >
      <div className="scroll">
        <div className="page">
          <div className="page-heading">
            <div>
              <h1>Settings</h1>
              <p className="lead">Servers your chats and tasks can reach, and the repos you work on.</p>
            </div>
          </div>
          <Connections list={conns} error={connError} reload={loadConns} />
          {wb && <Integrations key={wb.name} workbenchUrl={new URL(wb.url).origin} />}
          <Repositories />
        </div>
      </div>
    </Frame>
  );
}

// The repos you maintain: new tasks, PR pages, ticket PR lookups and Reviews work only on these.
function Repositories() {
  const [list, setList] = useState<MyRepo[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ws, setWs] = useState(() => storage('lf:bb-ws') ?? '');
  const load = () => api.myRepos().then((r) => setList(r.repos), (e) => setErr(e.message));
  useEffect(() => void load(), []);
  const act = async (f: () => Promise<unknown>) => {
    setErr(null);
    try {
      await f();
    } catch (e: any) {
      setErr(e.message);
    }
    await load();
  };
  const full = (list?.length ?? 0) >= MY_REPOS_CAP;
  return (
    <>
      <div className="sectionbar">
        <h2>
          Repositories <span className="muted">· {list?.length ?? 0} / {MY_REPOS_CAP}</span>
        </h2>
        {!adding && !full && (
          <button className="text-action" onClick={() => setAdding(true)}>
            + Add repository
          </button>
        )}
      </div>
      {adding && (
        <div className="pr-box name-box">
          <label className="field">
            <span>Bitbucket workspace</span>
            <input
              className="input mono"
              defaultValue={ws}
              placeholder="e.g. acme — leave empty for the server's default"
              onBlur={(e) => /^[\w.-]*$/.test(e.target.value.trim()) && (storage('lf:bb-ws', e.target.value.trim()), setWs(e.target.value.trim()))}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </label>
          <RepoPicker workspace={ws} onPick={(r) => (setAdding(false), act(() => api.addMyRepo(r.name)))} />
          <div className="pr-reply-actions">
            <button type="button" className="btn sm ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {list && !list.length && !adding && <div className="empty">No repos yet. Add the repos you work on — new tasks, pull requests and Reviews use only these.</div>}
      {!!list?.length && (
        <div className="section-list">
          {list.map((r) => (
            <div key={r.name} className="row">
              <div className="copy">
                <b className="mono">{r.name}</b>
                <span>{r.mainBranch ? `main branch ${r.mainBranch}` : 'no main branch reported'}</span>
                <label className="project-keys">
                  <span>Jira projects</span>
                  <input
                    className="input sm mono"
                    defaultValue={r.projects.join(', ')}
                    placeholder="e.g. PROJ, OPS — pre-selects this repo for their tickets"
                    onBlur={(e) => {
                      const keys = e.target.value.split(/[\s,]+/).filter(Boolean);
                      if (keys.join() !== r.projects.join()) void act(() => api.repoProjects(r.name, keys));
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                </label>
              </div>
              <div className="actions">
                {removing === r.name ? (
                  <button className="btn sm danger" onClick={() => (setRemoving(null), act(() => api.removeMyRepo(r.name)))}>
                    Confirm remove
                  </button>
                ) : (
                  <button className="btn sm ghost" onClick={() => setRemoving(r.name)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Connections({ list, error, reload }: { list: Connection[] | null; error: string | null; reload: () => Promise<Connection[] | null> }) {
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // after opening an OAuth link, watch for the connection to flip to connected
  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const t = setInterval(async () => {
      const l = await reload();
      if (l?.find((c) => c.name === pending)?.connected || Date.now() - started > 5 * 60_000) {
        clearInterval(t);
        setPending(null);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [pending]);

  const act = async (f: () => Promise<unknown>) => {
    setErr(null);
    try {
      await f();
    } catch (e: any) {
      setErr(e.message);
    }
    await reload();
  };
  const connect = (name: string) =>
    act(async () => {
      const { url } = await api.connectConnection(name);
      window.open(url, '_blank', 'noopener');
      setPending(name);
    });

  return (
    <>
      <div className="sectionbar" style={{ marginTop: 0 }}>
        <h2>Connections</h2>
        {!adding && (
          <button className="text-action" onClick={() => setAdding(true)}>
            + Add connection
          </button>
        )}
      </div>
      {adding && (
        <AddConnection
          onCancel={() => setAdding(false)}
          onAdded={async (c) => {
            setAdding(false);
            await reload();
            if (c.auth === 'oauth') await connect(c.name);
          }}
        />
      )}
      {(err || error) && <p className="error">{err ?? error}</p>}
      {list && !list.length && !adding && <div className="empty">No connections yet. Add workbench or any MCP server — every chat and task can then use it.</div>}
      {!!list?.length && (
        <div className="section-list">
          {list.map((c) => (
            <div key={c.name} className="row">
              <span className="marker soft">{c.name.charAt(0).toUpperCase()}</span>
              <div className="copy">
                <b>
                  {c.name} <span className="badge">{c.kind === 'workbench' ? 'Workbench' : 'MCP'}</span>
                </b>
                <span>
                  {c.url} · {c.auth === 'oauth' ? 'OAuth' : `Header ${c.headerNames.join(', ')}`}
                  {c.user?.email && ` · ${c.user.email}`}
                </span>
              </div>
              <div className="actions">
                {c.connected ? (
                  <span className="status-pill tone-good">Connected</span>
                ) : pending === c.name ? (
                  <span className="status-pill tone-watch">Finish in browser…</span>
                ) : (
                  <span className="status-pill tone-off">Not connected</span>
                )}
                {c.auth === 'oauth' &&
                  (c.connected ? (
                    <button className="btn sm" onClick={() => act(() => api.disconnectConnection(c.name))}>
                      Disconnect
                    </button>
                  ) : (
                    <button className="btn sm" onClick={() => connect(c.name)}>
                      Connect
                    </button>
                  ))}
                {removing === c.name ? (
                  <button className="btn sm danger" onClick={() => (setRemoving(null), act(() => api.removeConnection(c.name)))}>
                    Confirm remove
                  </button>
                ) : (
                  <button className="btn sm ghost" onClick={() => setRemoving(c.name)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="footnote">
        Connected servers join every new chat and task as MCP tools (<code>mcp__&lt;name&gt;__…</code>). Credentials stay on this machine and are attached by
        legos-factory, never handed to the agent.
      </p>
    </>
  );
}

function AddConnection({ onCancel, onAdded }: { onCancel: () => void; onAdded: (c: Connection) => void }) {
  const [kind, setKind] = useState<'workbench' | 'mcp'>('workbench');
  const [name, setName] = useState('workbench');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<'oauth' | 'header'>('oauth');
  const [header, setHeader] = useState('Authorization');
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pickKind = (k: 'workbench' | 'mcp') => {
    setKind(k);
    if (k === 'workbench') setAuth('oauth');
    if (!name || name === 'workbench') setName(k === 'workbench' ? 'workbench' : '');
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onAdded(await api.addConnection({ name: name.trim(), kind, url: url.trim(), auth, ...(auth === 'header' && { headers: { [header.trim()]: value } }) }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="add-conn" onSubmit={submit}>
      <div className="segmented" role="tablist" aria-label="Connection type">
        {(
          [
            ['workbench', 'Workbench'],
            ['mcp', 'MCP server'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => pickKind(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="field-row">
        <label className="field">
          Name
          <input className="input" value={name} placeholder="e.g. tools" onChange={(e) => setName(e.target.value.toLowerCase())} />
        </label>
        <label className="field">
          {kind === 'workbench' ? 'Workbench URL' : 'MCP endpoint URL'}
          <input className="input" value={url} placeholder={kind === 'workbench' ? 'https://workbench.example.com' : 'https://example.com/mcp'} onChange={(e) => setUrl(e.target.value)} />
        </label>
      </div>
      {kind === 'mcp' && (
        <label className="field">
          Authentication
          <select className="input" value={auth} onChange={(e) => setAuth(e.target.value as 'oauth' | 'header')}>
            <option value="oauth">OAuth — sign in through the browser</option>
            <option value="header">Static header — API key or token</option>
          </select>
        </label>
      )}
      {auth === 'header' && (
        <div className="field-row">
          <label className="field">
            Header
            <input className="input" value={header} onChange={(e) => setHeader(e.target.value)} />
          </label>
          <label className="field">
            Value
            <input className="input" type="password" autoComplete="off" value={value} placeholder="Bearer …" onChange={(e) => setValue(e.target.value)} />
          </label>
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <div className="add-conn-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !name.trim() || !url.trim() || (auth === 'header' && (!header.trim() || !value))}>
          {busy ? 'Adding…' : auth === 'oauth' ? 'Add and connect' : 'Add'}
        </button>
      </div>
    </form>
  );
}

// workbench integration ids -> names as workbench shows them
const APP_NAMES: Record<string, string> = {
  'atlassian-jira': 'Jira',
  'atlassian-confluence': 'Confluence',
  'atlassian-bitbucket': 'Bitbucket',
  'google-gmail': 'Gmail',
  'google-drive': 'Google Drive',
  'google-sheets': 'Google Sheets',
  'google-calendar': 'Google Calendar',
  'google-gemini': 'Google Gemini',
  'google-docs': 'Google Docs',
  'google-slides': 'Google Slides',
  github: 'GitHub',
  gitlab: 'GitLab',
  newrelic: 'New Relic',
  'httpbin-cookie': 'HTTPBin (cookie demo)',
  clevertap: 'CleverTap',
  kafkahq: 'KafkaHQ (AKHQ)',
  testrail: 'TestRail',
};
const appName = (id: string) => APP_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

function Integrations({ workbenchUrl }: { workbenchUrl: string | null }) {
  const [list, setList] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'all' | 'connected' | 'available'>('all');
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [open, setOpen] = useState(() => storage('lf:wb-apps') !== 'hidden');
  const toggle = () => (storage('lf:wb-apps', open ? 'hidden' : 'shown'), setOpen(!open));

  const load = () => api.integrations().then((r) => (setList(r.integrations), setError(null)), (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  // after opening a connect link, watch for the integration to flip to connected
  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const t = setInterval(async () => {
      const r = await api.integrations().catch(() => null);
      if (r) setList(r.integrations);
      if (r?.integrations.find((i) => i.name === pending)?.connected || Date.now() - started > 3 * 60_000) {
        clearInterval(t);
        setPending(null);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [pending]);

  const connect = async (name: string) => {
    setError(null);
    try {
      const { url } = await api.connect(name);
      if (!url) throw new Error('workbench did not return a link');
      window.open(url, '_blank', 'noopener');
      setPending(name);
    } catch (e: any) {
      setError(`Could not start connecting ${appName(name)}: ${e.message}`);
    }
  };

  const all = list ?? [];
  const connected = all.filter((i) => i.connected);
  const shown = all
    .filter((i) => (tab === 'all' ? true : tab === 'connected' ? i.connected : !i.connected))
    .filter((i) => !q || `${i.name} ${appName(i.name)}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="sectionbar">
        <h2>Workbench apps</h2>
        <div className="sectionbar-actions">
          {workbenchUrl && (
            <a className="text-action" href={workbenchUrl} target="_blank" rel="noreferrer">
              Open workbench →
            </a>
          )}
          <button className="text-action" aria-expanded={open} onClick={toggle}>
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {!open && list && (
        <p className="footnote">
          {connected.length} of {all.length} apps connected.
        </p>
      )}
      {open && (
        <>
          <div className="tool-bar">
            <div className="segmented" role="tablist">
              {(
                [
                  ['all', 'All', all.length],
                  ['connected', 'Connected', connected.length],
                  ['available', 'Available', all.length - connected.length],
                ] as const
              ).map(([k, label, n]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                  {label} <span className="tab-count">{n}</span>
                </button>
              ))}
            </div>
            <input className="input" placeholder="Search apps" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {error && <p className="error">{error}</p>}
          {!list && !error ? (
            <div className="empty">Asking workbench…</div>
          ) : (
            <div className="app-grid">
              {shown.map((i) => (
                <div key={i.name} className="app-card">
                  <span className={`app-icon ${i.connected ? 'on' : ''}`}>{appName(i.name).charAt(0)}</span>
                  <div className="copy">
                    <b>{appName(i.name)}</b>
                    <span>v{i.version ?? '?'}</span>
                  </div>
                  {i.connected ? (
                    <span className="status-pill tone-good">Connected</span>
                  ) : pending === i.name ? (
                    <span className="status-pill tone-watch">Finish in workbench…</span>
                  ) : (
                    <button className="btn sm" onClick={() => connect(i.name)}>
                      Connect
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="footnote">Connected apps are available to every chat and task as workbench tools, using your own access.</p>
        </>
      )}
    </>
  );
}
