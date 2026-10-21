import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Run, StreamMessage } from '../shared/types.ts';
import { ActivityLog, toTeamItem } from './activity.ts';
import type { RunManager } from './claude-runs.ts';
import { Connections, type Pending } from './connections.ts';
import { openDb } from './db.ts';
import { Dispatcher, EMBEDDED } from './dispatcher.ts';
import { capturePr, syncWorkItem } from './jira-sync.ts';
import { MyRepos } from './my-repos.ts';
import { HttpError, NO_WB, gitToken, localOnly, loopbackBind, onError, type AppOptions, type Deps, type Env, type Repos, type WorkbenchClient } from './http.ts';
import { FixQueues } from './pr-fixes.ts';
import { RunnerRegistry } from './runner-auth.ts';
import type { Forge } from './ports.ts';
import { Runner, localTransport } from './runner.ts';
import { Oidc } from './oidc.ts';
import { Runs } from './runs.ts';
import { StageStore, onRunFinished, settle } from './stages.ts';
import { authRoutes, SID_COOKIE } from './routes/auth.ts';
import { connectionsRoutes } from './routes/connections.ts';
import { jiraRoutes } from './routes/jira.ts';
import { myReposRoutes } from './routes/my-repos.ts';
import { prsRoutes } from './routes/prs.ts';
import { runnerRoutes } from './routes/runner.ts';
import { runsRoutes } from './routes/runs.ts';
import { workItemsRoutes } from './routes/work-items.ts';
import { workspacesRoutes } from './routes/workspaces.ts';
import { Workspaces, allowed } from './tenancy.ts';
import { bitbucketForge } from './providers/bitbucket-workbench.ts';
import { jiraWorkSource } from './providers/jira-workbench.ts';
import { Workbench } from './workbench.ts';
import { WorkItems } from './work-items.ts';
import { loadWorkflow } from './workflow.ts';
import { createWorkspace, managedWorkspace, parseRepo, removeWorkspace, sweepWorkspaces, workspacePath, workspacesDir } from './workspace.ts';

export type { AppOptions } from './http.ts';
export { nameFromEmail, type ReviewRequest } from './routes/prs.ts';

// whoever runs everything when sign-in is off (LEGOS_AUTH=off), in their own personal workspace
const LOCAL_UID = 'local';

export function createApp(manager: RunManager, opts: AppOptions = {}, deps = buildDeps(manager, opts)) {
  const { users } = deps;
  const app = new Hono<Env>();

  // Launching a run is code execution: block DNS rebinding (Host) and cross-site POSTs (custom header forces CORS preflight).
  app.use('/api/*', async (c, next) => {
    if (!deps.hostOk(c.req.header('host'))) return c.json({ error: 'forbidden host' }, 403);
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
  app.route('/', runnerRoutes(deps));
  app.onError(onError);
  return app;
}

// At process start: drop the clones no queued or leased job will come back to.
export function sweepOrphans({ runs, wsRoot }: Deps) {
  sweepWorkspaces(wsRoot, new Set(runs.openJobs().flatMap((j) => (j.request.clone ? [workspacePath(wsRoot, j.workspaceId, parseRepo(j.request.clone.repo)!, j.request.clone.key)] : []))));
}

export function buildDeps(manager: RunManager, opts: AppOptions): Deps {
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
  const networked = !loopbackBind(opts.bind) || !!opts.publicUrl;
  const embedded = opts.embeddedRunner !== false;
  const runs = new Runs(new Dispatcher(db, { leaseMs: opts.leaseMs ?? 60_000, maxAttempts: opts.maxAttempts ?? 3 }), {
    selfUrl,
    publicUrl: opts.publicUrl,
    grants,
    lookup: (runId) => activity.get(runId),
    models: embedded ? () => manager.models() : undefined,
    embedded,
  });
  const publicHost = opts.publicUrl ? new URL(opts.publicUrl).host.toLowerCase() : null;
  const hostOk = (host: string | undefined) => localOnly(host) || (!!publicHost && host?.toLowerCase() === publicHost);
  const busyIn = (path: string) => {
    const snap = runs.snapshot();
    return snap.type === 'snapshot' && snap.runs.some((r) => r.cwd === path && !r.endedAt);
  };
  const clients = new Map<string, Workbench>();
  const workbench = async (workspaceId: string): Promise<WorkbenchClient | null> => {
    const wb = await connsFor(workspaceId).workbench();
    if (!wb) return null;
    if (!clients.has(wb.url)) clients.set(wb.url, new Workbench(wb.url, http));
    return { client: clients.get(wb.url)!, token: wb.token };
  };
  const forge = async (workspaceId: string) => {
    const wb = await workbench(workspaceId);
    return wb && bitbucketForge(wb.client, wb.token);
  };
  const workSource = async (workspaceId: string) => {
    const wb = await workbench(workspaceId);
    return wb && jiraWorkSource(wb.client, wb.token);
  };
  const ownsRun = (workspaceId: string, runId: string) => runs.get(runId)?.workspaceId === workspaceId;
  const startRun: Deps['startRun'] = (req, mcpNames = []) => {
    const gitHelper = !!req.repo && (!!req.clone || !!managedWorkspace(wsRoot, req.cwd));
    try {
      return runs.start({ ...req, mcpNames, gitHelper });
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw status ? new HttpError(status, (err as Error).message) : err;
    }
  };
  const fixes = new FixQueues(runs, {
    start: (r) => startRun({ ...r, recoverable: false }),
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
      const git = await forge(q.workspaceId);
      if (!git) throw new Error(NO_WB);
      await git.addComment(parseRepo(q.repo)!, q.prId, text, item.path && item.line ? { path: item.path, line: item.line } : undefined);
    },
  });
  runs.on('message', (m: StreamMessage) => {
    if (m.type !== 'run') return;
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

  // the runner read the branch of a throwaway clone before deleting it, so the PR it left can be found
  runs.on('finished', (run: Run, branch: string | null) => {
    void capturePr(deps, run, branch)
      .then(() => onRunFinished(deps, run))
      .then(() => {
        if (run.repo && run.ticket && run.stage) void syncWorkItem(deps, run.workspaceId, run.ticket);
      })
      .catch((err) => console.warn('PR capture failed:', err.message))
      .finally(() => runs.release(run.id));
  });

  // listing a big workspace takes several calls; repos change rarely
  const repoCache = new Map<string, { at: number; repos: Repos }>();
  // concurrent callers join the same load
  const repoLoads = new Map<string, Promise<Repos>>();
  const workspaceRepos = (workspaceId: string, git: Forge, workspace: string, refresh = false): Promise<Repos> => {
    const key = `${workspaceId}:${workspace}`;
    const hit = repoCache.get(key);
    if (hit && Date.now() - hit.at < 3600_000 && !refresh) return Promise.resolve(hit.repos);
    let load = repoLoads.get(key);
    if (!load) {
      load = git
        .listRepos(workspace)
        .then((repos) => (repoCache.set(key, { at: Date.now(), repos }), repos))
        .finally(() => repoLoads.delete(key));
      repoLoads.set(key, load);
    }
    return load;
  };

  const deps: Deps = { runs, runners: new RunnerRegistry(db), oidc: opts.oidc ? new Oidc(opts.oidc, http) : null, embedded, hostOk, networked, opts, users, workspaces, db, activity, myRepos, workItems, stages: new StageStore(db), workflow: loadWorkflow(opts.workflowDir), syncs: new Map(), http, fixes, wsRoot, connsFor, pending, workbench, forge, workSource, workspaceRepos, grants, selfUrl, startRun, busyIn, ownsRun };

  deps.stages.onNewFact((ws, ticket, repo) => void settle(deps, ws, ticket, repo).catch((err) => console.warn('stage engine failed:', err.message)));
  runs.recover();
  const open = runs.openJobs();
  activity.failOrphans(new Set(open.map((j) => j.runId)));
  setInterval(() => runs.reap(), 5000).unref();
  if (embedded) {
    new Runner({
      transport: localTransport(runs, { id: EMBEDDED, workspaceId: null, embedded: true }, opts.pollWaitMs),
      manager,
      wsRoot,
      gitUrl: opts.gitUrl,
      credential: (job) => gitToken(deps, job.request.workspaceId ?? 'local', parseRepo(job.clone!.repo)!),
    }).start();
  }
  return deps;
}
