import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

// Throwaway checkouts: a run on a repo gets a fresh shallow clone, deleted when the run ends. The path
// encodes workspace, repo and key (ticket), so continuing a session re-clones into the same place and
// Claude's transcript (stored by working directory) still lines up.

const run = promisify(execFile);
const PART_RE = /^[\w.-]{1,100}$/;
const CLONE_TIMEOUT_MS = 3 * 60_000;

export type RepoRef = { workspace: string; slug: string };

export function workspacesDir(): string {
  return process.env.LEGOS_WORKSPACES ?? join(homedir(), '.legos-factory', 'workspaces');
}

const safe = (s: string) => PART_RE.test(s) && s !== '.' && s !== '..';

export function parseRepo(s: string): RepoRef | null {
  const [workspace, slug, ...rest] = s.trim().split('/');
  return !rest.length && workspace && slug && safe(workspace) && safe(slug) ? { workspace, slug } : null;
}

export function workspacePath(root: string, workspaceId: string, repo: RepoRef, key: string): string {
  if (![workspaceId, key].every(safe)) throw new Error('invalid workspace key');
  return join(root, workspaceId, repo.workspace, repo.slug, key);
}

// A path this module manages, split back into its parts; null for any other directory.
export function managedWorkspace(root: string, path: string): { workspaceId: string; repo: RepoRef; key: string } | null {
  const parts = relative(root, path).split(sep);
  if (parts.length !== 4 || !parts.every(safe)) return null;
  const [workspaceId, workspace, slug, key] = parts;
  return { workspaceId, repo: { workspace, slug }, key };
}

const BITBUCKET = 'https://bitbucket.org';
const TOKEN_ENV = 'LEGOS_GIT_TOKEN';
const CLONE_HELPER = `!f() { test "$1" = get && printf 'username=x-token-auth\\npassword=%s\\n' "$${TOKEN_ENV}"; }; f`;
// asks the factory for a fresh token each time (see GET /git/credential); holds no secret itself
const RUN_HELPER = '!f() { test "$1" = get || exit 0; curl -fsS -H "x-legos-run: $LEGOS_RUN_SECRET" "$LEGOS_URL/git/credential"; }; f';
// outranks a global insteadOf that sends bitbucket.org over SSH (the longest match wins)
const keepHttps = (workspace: string) => [`url.${BITBUCKET}/${workspace}/.insteadOf`, `${BITBUCKET}/${workspace}/`];
const AUTH_FAILED_RE = /authentication failed|could not read (username|password)|returned error: 40[13]|access denied|invalid credentials/i;
const AUTH_HINT = 'reconnect workbench in Settings (needs repository write access)';

export type Author = { name?: string | null; email?: string | null };

// With urlTemplate (`{workspace}`, `{slug}` filled in) a plain clone; otherwise HTTPS from Bitbucket with a
// workbench token handed to git through the environment, never argv or .git/config.
export async function createWorkspace(opts: {
  path: string;
  repo: RepoRef;
  branch?: string;
  urlTemplate?: string;
  credential?: () => Promise<string>;
  author?: Author | null;
}): Promise<string> {
  const { workspace, slug } = opts.repo;
  const direct = opts.urlTemplate !== undefined;
  if (!direct && !opts.credential) throw new Error('no git credential for this repo');
  const token = direct ? null : await opts.credential!();
  const url = direct ? opts.urlTemplate!.replace('{workspace}', workspace).replace('{slug}', slug) : `${BITBUCKET}/${workspace}/${slug}.git`;
  // a leftover from a crash or an ended run: start clean
  await rm(opts.path, { recursive: true, force: true });
  await mkdir(dirname(opts.path), { recursive: true, mode: 0o700 });
  const branch = opts.branch ? ['--branch', opts.branch] : [];
  const helper = token ? ['-c', 'credential.helper=', '-c', `credential.helper=${CLONE_HELPER}`, '-c', keepHttps(workspace).join('=')] : [];
  try {
    await run('git', [...helper, 'clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', ...branch, '--', url, opts.path], {
      timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(token && { [TOKEN_ENV]: token }) },
    });
    if (token) await configure(opts.path, workspace, opts.author ?? {});
  } catch (err: any) {
    await rm(opts.path, { recursive: true, force: true });
    const stderr = String(err?.stderr || err?.message || err);
    let why = stderr.trim().split('\n').pop()!.replace(/x-token-auth:[^@\s]*@/g, 'x-token-auth:***@');
    if (token) why = why.replaceAll(token, '***');
    const hint = token && AUTH_FAILED_RE.test(stderr) ? ` — ${AUTH_HINT}` : '';
    throw Object.assign(new Error(`could not clone ${workspace}/${slug}${opts.branch ? `@${opts.branch}` : ''}: ${why}${hint}`), { status: 400 });
  }
  return opts.path;
}

async function configure(path: string, workspace: string, author: Author) {
  const set = (...args: string[]) => run('git', ['config', '--local', ...args], { cwd: path });
  const key = `credential.${BITBUCKET}.helper`;
  await set(key, '');
  await set('--add', key, RUN_HELPER);
  await set(...keepHttps(workspace));
  if (author.name) await set('user.name', author.name);
  if (author.email) await set('user.email', author.email);
}

export async function removeWorkspace(root: string, path: string) {
  if (!managedWorkspace(root, path)) return;
  await rm(path, { recursive: true, force: true });
}

export const exists = (path: string) => stat(path).then(() => true, () => false);
