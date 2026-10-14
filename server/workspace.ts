import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

// Throwaway checkouts: a run on a repo gets a fresh shallow clone, deleted when the run ends. The path
// encodes owner, repo and key (ticket), so continuing a session re-clones into the same place and
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

export function workspacePath(root: string, owner: string, repo: RepoRef, key: string): string {
  if (![owner, key].every(safe)) throw new Error('invalid workspace key');
  return join(root, owner, repo.workspace, repo.slug, key);
}

// A path this module manages, split back into its parts; null for any other directory.
export function managedWorkspace(root: string, path: string): { owner: string; repo: RepoRef; key: string } | null {
  const parts = relative(root, path).split(sep);
  if (parts.length !== 4 || !parts.every(safe)) return null;
  const [owner, workspace, slug, key] = parts;
  return { owner, repo: { workspace, slug }, key };
}

// `{workspace}` and `{slug}` are filled in; SSH by default so pushes use the machine's own git credentials.
export const DEFAULT_GIT_URL = 'git@bitbucket.org:{workspace}/{slug}.git';

export async function createWorkspace(opts: { path: string; repo: RepoRef; branch?: string; urlTemplate?: string }): Promise<string> {
  const url = (opts.urlTemplate ?? DEFAULT_GIT_URL).replace('{workspace}', opts.repo.workspace).replace('{slug}', opts.repo.slug);
  // a leftover from a crash or an ended run: start clean
  await rm(opts.path, { recursive: true, force: true });
  await mkdir(dirname(opts.path), { recursive: true, mode: 0o700 });
  const branch = opts.branch ? ['--branch', opts.branch] : [];
  try {
    await run('git', ['clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', ...branch, '--', url, opts.path], {
      timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err: any) {
    await rm(opts.path, { recursive: true, force: true });
    const why = String(err?.stderr || err?.message || err).trim().split('\n').pop();
    throw Object.assign(new Error(`could not clone ${opts.repo.workspace}/${opts.repo.slug}${opts.branch ? `@${opts.branch}` : ''}: ${why}`), { status: 400 });
  }
  return opts.path;
}

export async function removeWorkspace(root: string, path: string) {
  if (!managedWorkspace(root, path)) return;
  await rm(path, { recursive: true, force: true });
}

export const exists = (path: string) => stat(path).then(() => true, () => false);
