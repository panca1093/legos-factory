import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { JiraFlow, Settings, ShareLevel } from '../shared/types.ts';

const run = promisify(execFile);

export function settingsPath(): string {
  return process.env.LEGOS_SETTINGS ?? join(homedir(), '.legos-factory', 'settings.json');
}

const FLOW: JiraFlow = { todo: 'To Do', inProgress: 'In Progress', codeReview: 'Code Review', readyForQa: 'Ready for QA' };
const DEFAULTS: Settings = { share: { default: 'private', rules: [] }, ticketKeys: [], jiraFlow: FLOW };
const LEVELS: ShareLevel[] = ['private', 'status', 'full'];

const expand = (p: string) => resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

// A missing or broken file falls back to private-by-default; never share by accident.
export async function loadSettings(): Promise<Settings & { error: string | null }> {
  let raw: any;
  try {
    raw = JSON.parse(await readFile(settingsPath(), 'utf8'));
  } catch (err: any) {
    return { ...DEFAULTS, error: err.code === 'ENOENT' ? null : `could not read ${settingsPath()}: ${err.message}` };
  }
  const rules = Array.isArray(raw?.share?.rules) ? raw.share.rules : [];
  return {
    share: {
      default: LEVELS.includes(raw?.share?.default) ? raw.share.default : 'private',
      rules: rules
        .filter((r: any) => typeof r?.path === 'string' && LEVELS.includes(r?.level))
        .map((r: any) => ({ path: expand(r.path), level: r.level })),
    },
    ticketKeys: Array.isArray(raw?.ticketKeys) ? raw.ticketKeys.filter((k: unknown) => typeof k === 'string' && /^[A-Z][A-Z0-9]+$/.test(k)) : [],
    jiraFlow: Object.fromEntries(Object.entries(FLOW).map(([k, d]) => [k, typeof raw?.jiraFlow?.[k] === 'string' && raw.jiraFlow[k].trim() ? raw.jiraFlow[k].trim() : d])) as JiraFlow,
    error: null,
  };
}

// Longest matching folder wins, so a repo can override its parent folder.
export function shareFor(cwd: string | null, s: Settings): ShareLevel {
  if (!cwd) return s.share.default;
  const dir = resolve(cwd);
  let best: { len: number; level: ShareLevel } | null = null;
  for (const r of s.share.rules) {
    if ((dir === r.path || dir.startsWith(r.path + sep)) && (!best || r.path.length > best.len)) best = { len: r.path.length, level: r.level };
  }
  return best?.level ?? s.share.default;
}

// Words shaped like ticket keys that aren't tickets.
const NOT_TICKETS = new Set(['UTF', 'ISO', 'SHA', 'RFC', 'GPT', 'HTTP', 'TLS', 'SSL', 'ES', 'AES', 'RSA', 'CVE', 'PR', 'MR']);

export function detectTicket(text: string | null | undefined, keys: string[]): string | null {
  if (!text) return null;
  const re = keys.length ? new RegExp(`\\b(${keys.join('|')})-(\\d+)\\b`, 'i') : /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/;
  const m = text.match(re);
  if (!m) return null;
  const key = m[1].toUpperCase();
  return !keys.length && NOT_TICKETS.has(key) ? null : `${key}-${m[2]}`;
}

export async function gitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000 });
    const b = stdout.trim();
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}
