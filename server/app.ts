import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { StreamMessage } from '../shared/types.ts';
import { ActivityLog, toTeamItem } from './activity.ts';
import type { RunManager, StartRequest } from './claude-runs.ts';
import { Connections, type Pending } from './connections.ts';
import { openDb } from './db.ts';
import { capturePr, syncWorkItem } from './jira-sync.ts';
import { MyRepos } from './my-repos.ts';
import { NO_WB, gitToken, localOnly, onError, type AppOptions, type Deps, type Env, type Repos, type WorkbenchClient } from './http.ts';
import { FixQueues } from './pr-fixes.ts';
import { authRoutes, SID_COOKIE } from './routes/auth.ts';
import { connectionsRoutes } from './routes/connections.ts';
import { jiraRoutes } from './routes/jira.ts';
import { myReposRoutes } from './routes/my-repos.ts';
import { prsRoutes } from './routes/prs.ts';
import { runsRoutes } from './routes/runs.ts';
import { workItemsRoutes } from './routes/work-items.ts';
import { workspacesRoutes } from './routes/workspaces.ts';
import { Workspaces, allowed } from './tenancy.ts';
import { Workbench } from './workbench.ts';
import { WorkItems } from './work-items.ts';
import { createWorkspace, managedWorkspace, parseRepo, removeWorkspace, workspacePath, workspacesDir } from './workspace.ts';

export type { AppOptions } from './http.ts';
export { nameFromEmail, type ReviewRequest } from './routes/prs.ts';

// whoever runs everything when sign-in is off (LEGOS_AUTH=off), in their own personal workspace
const LOCAL_UID = 'local';

export function createApp(runs: RunManager, opts: AppOptions = {}, deps = buildDeps(runs, opts)) {
  const { users } = deps;
  const app = new Hono<Env>();

  // Launching a run is code execution: block DNS rebinding (Host) and cross-site POSTs (custom header forces CORS preflight).
  app.use('/api/*', async (c, next) => {
    if (!localOnly(c.req.header('host'))) return c.json({ error: 'forbidden host' }, 403);
    if (c.req.method !== 'GET' && c.req.header('x-legos') !== '1') return c.json({ error: 'missing x-legos header' }, 403);
    const user = users?.verify(getCookie(c, SID_COOKIE)) ?? null;
    if (users && !user) return c.json({ error: 'sign in required' }, 401);
    const uid = user?.id ?? LOCAL_UID;
    deps.workspaces.ensurePersonal(uid, user?.name ?? 'Local');
    const { id, role } = deps.workspaces.active(uid);
    if (!allowed(role, c.req.method, c.req.path)) return c.json({ error: `the ${role} role cannot do this in this workspace` }, 403);
    c.set('uid', uid);
    c.set('ws', id);
    c.set('role', role);
    await next();
  });

  app.route('/', runsRoutes(deps));
  app.route('/', authRoutes(deps));
  app.route('/', connectionsRoutes(deps));
  app.route('/', prsRoutes(deps));
  app.route('/', jiraRoutes(deps));
  app.route('/', myReposRoutes(deps));
  app.route('/', workItemsRoutes(deps));
  app.route('/', workspacesRoutes(deps));
  app.onError(onError);
  return app;
}

export function buildDeps(runs: RunManager, opts: AppOptions): Deps {
  const users = opts.users ?? null;
  const db = opts.db ?? openDb(':memory:');
  const workspaces = new Workspaces(db);
  const activity = new ActivityLog(db);
  const myRepos = new MyRepos(db);
  const workItems = new WorkItems(db);
  const http = opts.fetch ?? fetch;
  const selfUrl = opts.selfUrl ?? 'http://localhost:4317';
  const callbackUrl = `${selfUrl}/auth/callback`;
  const pending = new Map<string, Pending>();
  const connsByWorkspace = new Map<string, Connections>();
  const connsFor = (workspaceId: string) => {
    if (!connsByWorkspace.has(workspaceId)) connsByWorkspace.set(workspaceId, new Connections({ callbackUrl, db, workspaceId, fetch: http, pending }));
    return connsByWorkspace.get(workspaceId)!;
  };
  const grants = new Map<string, string>();
  const wsRoot = opts.workspaces ?? workspacesDir();
  const clones = new Map<string, string>();
  const busyIn = (path: string) => [...runs.activeRunBySession().values(), ...clones.keys()].some((id) => runs.get(id)?.cwd === path && !runs.get(id)?.endedAt);
  const clients = new Map<string, Workbench>();
  const workbench = async (workspaceId: string): Promise<WorkbenchClient | null> => {
    const wb = await connsFor(workspaceId).workbench();
    if (!wb) return null;
    if (!clients.has(wb.url)) clients.set(wb.url, new Workbench(wb.url, http));
    return { client: clients.get(wb.url)!, token: wb.token };
  };
  const ownsRun = (workspaceId: string, runId: string) => runs.get(runId)?.workspaceId === workspaceId;
  const startRun = (req: StartRequest, mcpNames: string[] = []) => {
    const repoRun = !!req.repo && !!managedWorkspace(wsRoot, req.cwd);
    if (!repoRun && !mcpNames.length) return runs.start(req);
    const secret = randomBytes(24).toString('base64url');
    const mcp = mcpNames.length ? Object.fromEntries(mcpNames.map((name) => [name, { url: `${selfUrl}/mcp/${name}`, headers: { 'x-legos-run': secret } }])) : undefined;
    const run = runs.start({ ...req, mcp, ...(repoRun && { env: { LEGOS_RUN_SECRET: secret, LEGOS_URL: selfUrl } }) });
    grants.set(secret, run.id);
    return run;
  };
  const fixes = new FixQueues(runs, {
    start: startRun,
    prepare: async (q) => {
      const repo = parseRepo(q.repo)!;
      const path = workspacePath(wsRoot, q.workspaceId, repo, `pr-${q.prId}`);
      if (busyIn(path)) throw new Error(`a run is already working in ${path.split('/').pop()}`);
      const author = users?.get(q.owner);
      return createWorkspace({ path, repo, branch: q.branch, urlTemplate: opts.gitUrl, credential: () => gitToken(deps, q.workspaceId, repo), author });
    },
    cleanup: async (_q, cwd) => {
      if (!busyIn(cwd)) await removeWorkspace(wsRoot, cwd);
    },
    reply: async (q, item, text) => {
      const wb = await workbench(q.workspaceId);
      if (!wb) throw new Error(NO_WB);
      const repo = parseRepo(q.repo)!;
      await wb.client.bitbucketAddComment(wb.token, repo.workspace, repo.slug, q.prId, text, item.path && item.line ? { path: item.path, line: item.line } : undefined);
    },
  });
  runs.on('message', (m: StreamMessage) => {
    if (m.type !== 'run') return;
    if (m.run.endedAt) for (const [k, runId] of grants) if (runId === m.run.id) grants.delete(k);
    const clone = m.run.endedAt ? clones.get(m.run.id) : undefined;
    if (clone) {
      clones.delete(m.run.id);
      const { run } = m;
      // the PR is found from the clone's branch, so capture it before the clone goes
      void capturePr(deps, run, clone)
        .then(() => {
          if (run.ticket && run.stage) void syncWorkItem(deps, run.workspaceId, run.ticket);
          if (!busyIn(clone)) return removeWorkspace(wsRoot, clone);
        })
        .catch((err) => console.warn('workspace cleanup failed:', err.message));
    }
    void activity
      .record(m.run, m.run.workspaceId)
      .then(async (item) => {
        if (!item || item.share === 'private' || !opts.hubUrl) return;
        const wb = await workbench(m.run.workspaceId);
        if (!wb) return;
        const res = await http(`${opts.hubUrl}/hub/events`, {
          method: 'POST',
          headers: { authorization: `Bearer ${wb.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ items: [toTeamItem(item)] }),
        });
        if (!res.ok) console.warn(`hub rejected status update (HTTP ${res.status})`);
      })
      .catch((err) => console.warn('activity update failed:', err.message));
  });

  // listing a big workspace takes several calls; repos change rarely
  const repoCache = new Map<string, { at: number; repos: Repos }>();
  // concurrent callers join the same load
  const repoLoads = new Map<string, Promise<Repos>>();
  const workspaceRepos = (workspaceId: string, wb: WorkbenchClient, workspace: string, refresh = false): Promise<Repos> => {
    const key = `${workspaceId}:${workspace}`;
    const hit = repoCache.get(key);
    if (hit && Date.now() - hit.at < 3600_000 && !refresh) return Promise.resolve(hit.repos);
    let load = repoLoads.get(key);
    if (!load) {
      load = wb.client
        .bitbucketRepos(wb.token, workspace)
        .then((repos) => (repoCache.set(key, { at: Date.now(), repos }), repos))
        .finally(() => repoLoads.delete(key));
      repoLoads.set(key, load);
    }
    return load;
  };

  const deps: Deps = { runs, opts, users, workspaces, db, activity, myRepos, workItems, syncs: new Map(), http, fixes, wsRoot, connsFor, pending, workbench, workspaceRepos, grants, selfUrl, startRun, clones, busyIn, ownsRun };
  return deps;
}
