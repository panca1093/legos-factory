import type { DatabaseSync } from 'node:sqlite';
import type { Context } from 'hono';
import type { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { RunManager, StartRequest } from './claude-runs.ts';
import type { Run } from '../shared/types.ts';
import type { ActivityLog } from './activity.ts';
import type { Connections, Pending } from './connections.ts';
import type { MyRepos } from './my-repos.ts';
import type { FixQueues } from './pr-fixes.ts';
import type { Users } from './users.ts';
import { tokenFromCloneUrl, type Workbench } from './workbench.ts';
import type { RepoRef } from './workspace.ts';

export type AppOptions = {
  // null = no sign-in (LEGOS_AUTH=off): everything belongs to one local user
  users?: Users | null;
  // defaults to a throwaway in-memory database
  db?: DatabaseSync;
  selfUrl?: string;
  fetch?: typeof fetch;
  // team hub base URL; unset = no team activity
  hubUrl?: string | null;
  // workbench MCP URL behind "Sign in with workbench"; unset hides that option
  workbenchUrl?: string | null;
  // where repo runs get their throwaway clones, and how to reach a repo (see workspace.ts)
  workspaces?: string;
  gitUrl?: string;
  // the Bitbucket workspace repos are listed from when none is asked for (the forge can't tell us)
  bitbucketWorkspace?: string | null;
};

export type Env = { Variables: { uid: string } };

export type WorkbenchClient = { client: Workbench; token: string };
export type Repos = Awaited<ReturnType<Workbench['bitbucketRepos']>>;

// What the route modules share; built once in createApp.
export type Deps = {
  runs: RunManager;
  opts: AppOptions;
  users: Users | null;
  db: DatabaseSync;
  activity: ActivityLog;
  myRepos: MyRepos;
  http: typeof fetch;
  fixes: FixQueues;
  wsRoot: string;
  connsFor: (owner: string) => Connections;
  // OAuth state -> whose connect it was, shared by every user's Connections
  pending: Map<string, Pending>;
  // the owner's connected workbench, if any: apps, Jira and the team hub go through it
  workbench: (owner: string) => Promise<WorkbenchClient | null>;
  workspaceRepos: (uid: string, wb: WorkbenchClient, workspace: string, refresh?: boolean) => Promise<Repos>;
  // per-run secret -> run, so only runs launched here reach the connections proxy and git credentials
  grants: Map<string, string>;
  // how Claude Code processes reach this app
  selfUrl: string;
  // runs.start, plus a grant for repo runs (git credentials) and for the named connections (MCP proxy)
  startRun: (req: StartRequest, mcpNames?: string[]) => Run;
  // run -> its throwaway clone, deleted once no live run works in it
  clones: Map<string, string>;
  busyIn: (path: string) => boolean;
  ownsRun: (uid: string, runId: string) => boolean;
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: object = {},
  ) {
    super(message);
  }
}

export const NO_WB = 'connect a workbench in Settings first';
export const TICKET_RE = /^[A-Z][A-Z0-9]+-\d+$/;
export const BRANCH_RE = /^(?!-)[\w./-]{1,200}$/;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const localOnly = (host: string | undefined) => LOCAL_HOSTS.has((host ?? '').replace(/:\d+$/, ''));

export const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Domain modules tag the caller's mistakes with a 4xx status; any other failure is upstream's.
const errStatus = (err: unknown) => {
  const s = (err as { status?: number })?.status;
  return s && s >= 400 && s < 500 ? s : 502;
};

export const domain = <T>(work: Promise<T>) =>
  work.catch((err) => {
    throw err instanceof HttpError ? err : new HttpError(errStatus(err), errMsg(err));
  });

// Workbench and forge failures: 502 whatever they say.
export const upstream = <T>(work: Promise<T>) =>
  work.catch((err) => {
    throw err instanceof HttpError ? err : new HttpError(502, errMsg(err));
  });

export const onError = (err: Error, c: Context) => {
  if (err instanceof HttpError) return c.json({ error: err.message, ...err.extra }, err.status as ContentfulStatusCode);
  // the rest as Hono's default handler would
  if ('getResponse' in err) {
    const res = (err as HTTPException).getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text('Internal Server Error', 500);
};

export async function requireWorkbench(deps: Deps, uid: string, extra?: object) {
  const wb = await deps.workbench(uid);
  if (!wb) throw new HttpError(409, NO_WB, extra);
  return wb;
}

// A short-lived Bitbucket token minted by the owner's workbench; never logged or stored.
export async function gitToken(deps: Deps, uid: string, repo: RepoRef): Promise<string> {
  const wb = await requireWorkbench(deps, uid);
  const token = tokenFromCloneUrl(await upstream(wb.client.bitbucketCloneUrl(wb.token, repo.workspace, repo.slug)));
  if (!token) throw new HttpError(502, 'workbench sent an unexpected clone URL');
  return token;
}

export function requireMyRepo(deps: Deps, uid: string, repo: string) {
  if (!deps.myRepos.has(uid, repo)) throw new HttpError(403, 'repo is not in your repos', { needRepo: true });
}

// A body that isn't a JSON object reads as {}, so every field falls back to its default.
export async function readBody(c: Context): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw new HttpError(400, r.error.issues[0].message);
  return r.data;
}

// Non-strings read as '', so a missing field and a wrong type get the same answer.
export const text = () => z.string().trim().catch('');
export const optText = () => text().transform((s) => s || undefined);
