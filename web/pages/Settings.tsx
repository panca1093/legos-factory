import { useContext, useEffect, useState, type KeyboardEvent } from 'react';
import type { AutomationSettings, Persona, RoutingRule } from '../../shared/types.ts';
import { MY_REPOS_CAP, ago, api, projectName, storage, useFetch, useLive, useNow, type Connection, type Integration, type MyRepo } from '../api.ts';
import { RepoPicker } from '../components.tsx';
import { Chrome, Frame } from '../chrome.tsx';

import './Settings.css';

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
          <Automation />
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
        ).map(([k, label], i) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} tabIndex={kind === k ? 0 : -1} className={kind === k ? 'active' : ''} onKeyDown={onTabKey(i)} onClick={() => pickKind(k)}>
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
              ).map(([k, label, n], i) => (
                <button key={k} role="tab" aria-selected={tab === k} tabIndex={tab === k ? 0 : -1} className={tab === k ? 'active' : ''} onKeyDown={onTabKey(i)} onClick={() => setTab(k)}>
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

const PERSONAS: { key: Persona; label: string; initial: string; color: string; hint: string }[] = [
  { key: 'foreman', label: 'Foreman', initial: 'F', color: '#8f6ad8', hint: 'Brainstorm and spec, including the plan and its task graph' },
  { key: 'builder', label: 'Builder', initial: 'B', color: '#5148c7', hint: 'Builds the plan’s tasks, merges their branches per repo and runs the full suite. Every Builder run uses this model.' },
  { key: 'inspector', label: 'Inspector', initial: 'I', color: '#2c7a8c', hint: 'Read-only review against the plan, task by task' },
  { key: 'cataloger', label: 'Cataloger', initial: 'C', color: '#6b7385', hint: 'After merge: docs, changelog, what this ticket taught us' },
];

const RULE_KINDS: { key: RoutingRule['kind']; label: string; hint: string; placeholder: string }[] = [
  { key: 'paths', label: 'Changed paths', hint: 'repo-relative globs, * inside one segment, ** any depth', placeholder: 'db/migrations/**, auth/**' },
  { key: 'lines', label: 'Changed lines', hint: 'one number: the PR goes to a person when it changes more lines than that', placeholder: '400' },
  { key: 'jira', label: 'Jira type or label', hint: 'type:<name> or label:<name>, comma-separated', placeholder: 'type:Security, label:security' },
  { key: 'repo', label: 'Repo', hint: 'workspace/slug, * allowed in the slug', placeholder: 'acme/api, acme/payments-*' },
];

const MODEL_ALIASES: [string, string][] = [
  ['default', 'Account default'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];

// The server remembers a command by its first two words, so an allowed prefix matches the same way.
const commandPrefix = (command: string) => command.trim().split(/\s+/).slice(0, 2).join(' ');

function Automation() {
  const { me } = useContext(Chrome);
  const owner = me.isOwner === true;
  const live = useLive();
  const now = useNow(30000);
  const { data: modelList } = useFetch(() => api.models(), []);
  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [storeErrors, setStoreErrors] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newKind, setNewKind] = useState<RoutingRule['kind']>('paths');
  const [newValue, setNewValue] = useState('');
  const [newCmd, setNewCmd] = useState('');

  useEffect(() => {
    api.automation().then(
      (a) => {
        const { automationErrors, ...rest } = a as AutomationSettings & { automationErrors?: string[] };
        setSettings(rest);
        setStoreErrors(Array.isArray(automationErrors) ? automationErrors : []);
        setLoadError(null);
      },
      (e: any) => setLoadError(e.message),
    );
  }, []);

  const patch = (p: Partial<AutomationSettings>) => setSettings((s) => (s ? { ...s, ...p } : s));
  const setModel = (persona: Persona, model: string) => setSettings((s) => (s ? { ...s, models: { ...s.models, [persona]: model } } : s));
  const toggleRule = (id: string) => setSettings((s) => (s ? { ...s, routing: s.routing.map((r) => (r.id === id ? { ...r, on: !r.on } : r)) } : s));
  const setRuleValue = (id: string, value: string) => setSettings((s) => (s ? { ...s, routing: s.routing.map((r) => (r.id === id ? { ...r, value } : r)) } : s));
  const removeRule = (id: string) => setSettings((s) => (s ? { ...s, routing: s.routing.filter((r) => r.id !== id) } : s));
  const addRule = () => {
    const value = newValue.trim();
    if (!value) return;
    setSettings((s) => (s ? { ...s, routing: [...s.routing, { id: `r${s.routing.length + 1}-${Date.now().toString(36)}`, kind: newKind, value, on: true }] } : s));
    setNewValue('');
  };
  const addAllow = (command: string) => {
    const value = command.trim();
    if (!value) return;
    setSettings((s) => (s ? { ...s, allowlist: s.allowlist.includes(value) ? s.allowlist : [...s.allowlist, value] } : s));
  };
  const removeAllow = (command: string) => setSettings((s) => (s ? { ...s, allowlist: s.allowlist.filter((c) => c !== command) } : s));

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      setSettings(await api.saveAutomation(settings));
      setSaved(true);
    } catch (e: any) {
      setSaveError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const modelOptions = (persona: Persona) => {
    const seen = new Set<string>();
    const out: { value: string; label: string }[] = [];
    const add = (value: string, label: string) => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      out.push({ value, label });
    };
    add('default', 'Account default');
    for (const m of modelList ?? []) add(m.value, m.displayName);
    for (const [value, label] of MODEL_ALIASES) add(value, label);
    if (persona === 'cataloger') add('off', 'Off');
    add(settings?.models[persona] ?? '', settings?.models[persona] ?? '');
    return out;
  };

  // Paused runs ask for a command in the live stream; only Bash carries a command to allow.
  const asks = [...live.decisions.values()]
    .filter((d) => d.toolName === 'Bash' && typeof d.input.command === 'string')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (loadError) {
    return (
      <section className="auto-wrap">
        <div className="auto-head">
          <h2>Automation</h2>
        </div>
        <p className="error">Could not read the automation settings: {loadError}</p>
      </section>
    );
  }
  if (!settings) {
    return (
      <section className="auto-wrap">
        <div className="auto-head">
          <h2>Automation</h2>
        </div>
        <div className="empty">Reading the automation settings…</div>
      </section>
    );
  }

  const inspectorError = saveError && /inspector/i.test(saveError) ? saveError : null;
  const otherError = saveError && !/inspector/i.test(saveError) ? saveError : null;

  return (
    <section className="auto-wrap">
      <div className="auto-head">
        <h2>Automation</h2>
        <p>Runs go on their own. These settings decide where they stop for a person. Owners can change them; members see them.</p>
      </div>

      {storeErrors.length > 0 && (
        <div className="auto-note">
          {storeErrors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}

      <div className="auto-card">
        <div className="auto-card-head">
          <h3>Gates</h3>
        </div>
        <div className="auto-line first">
          <div className="auto-copy">
            <b>Brainstorm</b>
            <span>Offer a brainstorm chat before the spec</span>
          </div>
          <select
            className="input auto-select"
            aria-label="Brainstorm"
            value={settings.brainstorm}
            disabled={!owner}
            onChange={(e) => patch({ brainstorm: e.target.value as AutomationSettings['brainstorm'] })}
          >
            <option value="optional">Optional, I choose per ticket</option>
            <option value="always">Always first</option>
          </select>
        </div>
        <div className="auto-line">
          <div className="auto-copy">
            <b>Spec review</b>
            <span>A person approves every spec PR before build starts</span>
          </div>
          <span className="auto-lock">Always on</span>
        </div>
        <div className="auto-line">
          <div className="auto-copy">
            <b>Agent review attempts</b>
            <span>Build runs again on requested changes; after this many, a person decides</span>
          </div>
          <input
            className="input auto-num"
            type="number"
            min={1}
            max={5}
            aria-label="Agent review attempts"
            value={settings.reviewAttempts}
            disabled={!owner}
            onChange={(e) => patch({ reviewAttempts: Number(e.target.value) })}
          />
        </div>
        <div className="auto-line">
          <div className="auto-copy">
            <b>Merge</b>
            <span>PRs that need no review wait as Ready to merge; a member merges in one click. The factory never merges.</span>
          </div>
          <span className="auto-lock">Always a person</span>
        </div>
      </div>

      <div className="auto-card">
        <div className="auto-card-head">
          <h3>Personas</h3>
          <span className="meta">defaults; a task can override the model in More options</span>
        </div>
        {PERSONAS.map((p) => (
          <div key={p.key}>
            <div className="auto-line">
              <span className="auto-avatar" style={{ background: p.color }}>
                {p.initial}
              </span>
              <div className="auto-copy">
                <b>{p.label}</b>
                <span>{p.hint}</span>
                {p.key === 'inspector' && inspectorError && <span className="error">{inspectorError}</span>}
              </div>
              <select
                className="input auto-select"
                aria-label={`${p.label} model`}
                value={settings.models[p.key]}
                disabled={!owner}
                onChange={(e) => setModel(p.key, e.target.value)}
              >
                {modelOptions(p.key).map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            {p.key === 'builder' && (
              <div className="auto-line">
                <div className="auto-copy">
                  <b>Parallel builders</b>
                  <span>Run independent tasks in parallel — only for tasks the approved plan marks independent and that touch different files. Each gets its own worktree.</span>
                </div>
                <label className="auto-field">
                  <span>Builders at once</span>
                  <input
                    className="input auto-num"
                    type="number"
                    min={0}
                    max={4}
                    aria-label="Builders at once"
                    value={settings.parallelBuilders}
                    disabled={!owner}
                    onChange={(e) => patch({ parallelBuilders: Number(e.target.value) })}
                  />
                </label>
                <span className="meta">{settings.parallelBuilders === 0 ? 'Off' : `${settings.parallelBuilders} at once`}</span>
              </div>
            )}
            {p.key === 'builder' && settings.parallelBuilders > 0 && <p className="footnote" style={{ marginTop: 0 }}>Each takes a run slot (3 per runner).</p>}
            {p.key === 'inspector' && <div className="auto-note">Use a different model for the Inspector than for the Builder. The same model reviewing its own work tends to agree with itself.</div>}
          </div>
        ))}
      </div>

      <div className="auto-card">
        <div className="auto-card-head">
          <h3>Send a PR to a person when any of these match</h3>
          <span className="meta">checked after the agent review passes</span>
        </div>
        {settings.routing.map((rule) => {
          const kind = RULE_KINDS.find((k) => k.key === rule.kind) ?? RULE_KINDS[0];
          return (
            <div className="auto-line" key={rule.id}>
              <button
                type="button"
                role="switch"
                aria-checked={rule.on}
                aria-label={kind.label}
                className={`auto-switch ${rule.on ? 'on' : ''}`}
                disabled={!owner}
                onClick={() => toggleRule(rule.id)}
              >
                <span />
              </button>
              <div className="auto-copy">
                <b>{kind.label}</b>
                <span>{kind.hint}</span>
              </div>
              <input
                className="input mono auto-value"
                aria-label={`${kind.label} value`}
                placeholder={kind.placeholder}
                value={rule.value}
                disabled={!owner}
                onChange={(e) => setRuleValue(rule.id, e.target.value)}
              />
              <button className="btn sm ghost" disabled={!owner} onClick={() => removeRule(rule.id)}>
                Remove
              </button>
            </div>
          );
        })}
        {!settings.routing.length && <div className="empty">No rules yet — every PR that passes the agent review waits as Ready to merge.</div>}
        <div className="auto-line">
          <select className="input auto-select" aria-label="Rule kind" value={newKind} disabled={!owner} onChange={(e) => setNewKind(e.target.value as RoutingRule['kind'])}>
            {RULE_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
          <input
            className="input mono auto-value"
            aria-label="New rule value"
            placeholder={RULE_KINDS.find((k) => k.key === newKind)?.placeholder}
            value={newValue}
            disabled={!owner}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addRule()}
          />
          <button className="btn" disabled={!owner || !newValue.trim()} onClick={addRule}>
            + Add rule
          </button>
        </div>
        <p className="footnote">Kinds: changed paths, changed lines, Jira type or label, repo. The agent reviewer can also send a PR to a person, with its reason shown on the PR. It can never skip a rule that matched.</p>
      </div>

      <div className="auto-card">
        <div className="auto-card-head">
          <h3>Commands runs may use without asking</h3>
          <span className="meta">anything else pauses the run and shows on Home</span>
        </div>
        <div className="auto-chips">
          {settings.allowlist.map((cmd) => (
            <span className="auto-chip" key={cmd}>
              {cmd}
              <button type="button" aria-label={`Remove ${cmd}`} disabled={!owner} onClick={() => removeAllow(cmd)}>
                ×
              </button>
            </span>
          ))}
          {!settings.allowlist.length && <span className="meta">Nothing allowed yet — every command pauses its run.</span>}
        </div>
        <div className="auto-line">
          <input
            className="input"
            aria-label="New command"
            placeholder="e.g. make lint, or a prefix like go test"
            value={newCmd}
            disabled={!owner}
            onChange={(e) => setNewCmd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (addAllow(newCmd), setNewCmd(''))}
          />
          <button className="btn" disabled={!owner || !newCmd.trim()} onClick={() => (addAllow(newCmd), setNewCmd(''))}>
            Add
          </button>
        </div>
        <div className="auto-sub">Paused runs asked for these lately</div>
        {asks.map((d) => {
          const command = String(d.input.command);
          const prefix = commandPrefix(command);
          const run = live.runs.get(d.runId);
          const where = run?.ticket ?? projectName(run?.cwd ?? null);
          return (
            <div className="auto-ask" key={d.id}>
              <code>{command}</code>
              <span className="meta">
                {where} · {run?.repo ?? projectName(run?.cwd ?? null)} · {ago(d.createdAt, now)}
              </span>
              <button className="btn sm" disabled={!owner || settings.allowlist.includes(prefix)} onClick={() => addAllow(prefix)}>
                {settings.allowlist.includes(prefix) ? 'Allowed' : 'Add to allowlist'}
              </button>
            </div>
          );
        })}
        {!asks.length && <p className="footnote">No paused run is waiting for a command right now.</p>}
        <p className="footnote">Edits and git commits on the run’s own branch are always allowed. Pushing to any other branch, and anything that deletes outside the clone, always pauses.</p>
      </div>

      <div className="auto-save">
        {otherError && <p className="error auto-error">{otherError}</p>}
        {owner ? (
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        ) : (
          <span className="meta">Only owners can change these settings.</span>
        )}
        {saved && <span className="meta">Saved.</span>}
      </div>
    </section>
  );
}
