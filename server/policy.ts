import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { routingRuleError } from './routing.ts';
import type { AutomationSettings, JiraFlow, Settings, ShareLevel } from '../shared/types.ts';

const run = promisify(execFile);

export function settingsPath(): string {
  return process.env.LEGOS_SETTINGS ?? join(homedir(), '.legos-factory', 'settings.json');
}

const FLOW: JiraFlow = { todo: 'To Do', inProgress: 'In Progress', codeReview: 'Code Review', readyForQa: 'Ready for QA' };
const DEFAULTS: Settings = { share: { default: 'private', rules: [] }, jiraFlow: FLOW };
const routingRuleSchema = z.object({ id: z.string(), kind: z.enum(['paths', 'lines', 'jira', 'repo']), value: z.string(), on: z.boolean() }).superRefine((rule, ctx) => {
  const error = routingRuleError(rule);
  if (error) ctx.addIssue({ code: 'custom', message: `routing rule ${rule.id}: ${error}`, path: ['value'] });
});
export const automationSchema = z.object({
  allowlist: z.array(z.string().trim().min(1, 'allowlist entries must not be empty')),
  routing: z.array(routingRuleSchema),
  models: z.object({ foreman: z.string(), builder: z.string(), inspector: z.string(), cataloger: z.string() }).refine((models) => models.inspector !== models.builder, { message: 'inspector model must differ from builder model', path: ['inspector'] }),
  parallelBuilders: z.number().int().min(0).max(4),
  reviewAttempts: z.number().int().min(1).max(5),
  brainstorm: z.enum(['optional', 'always']),
});
const AUTOMATION: AutomationSettings = {
  allowlist: ['npm test', 'npm run build', 'npm run lint', 'go test', 'go vet'],
  routing: [],
  models: { foreman: 'opus', builder: 'sonnet', inspector: 'opus', cataloger: 'haiku' },
  parallelBuilders: 0,
  reviewAttempts: 3,
  brainstorm: 'optional',
};
function readAutomation(raw: unknown): { automation: AutomationSettings; automationErrors: string[] } {
  const automationErrors: string[] = [];
  const entries = (Object.keys(AUTOMATION) as (keyof AutomationSettings)[]).map((key) => {
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined;
    if (key === 'routing' && Array.isArray(value)) {
      const rules = value.flatMap((rule) => {
        const parsed = routingRuleSchema.safeParse(rule);
        if (parsed.success) return [parsed.data];
        const id = rule && typeof rule.id === 'string' ? rule.id : null;
        automationErrors.push(id === null ? 'routing' : `routing rule ${id}`);
        return [];
      });
      return [key, rules];
    }
    const parsed = automationSchema.shape[key].safeParse(value);
    if (parsed.success) return [key, parsed.data];
    automationErrors.push(key);
    return [key, structuredClone(AUTOMATION[key])];
  });
  return { automation: Object.fromEntries(entries) as AutomationSettings, automationErrors };
}
const LEVELS: ShareLevel[] = ['private', 'status', 'full'];

const expand = (p: string) => resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

// A missing or broken file falls back to private-by-default; never share by accident.
export async function loadSettings(): Promise<Settings & { automation: AutomationSettings; automationErrors: string[]; error: string | null }> {
  let raw: any;
  try {
    raw = JSON.parse(await readFile(settingsPath(), 'utf8'));
  } catch (err: any) {
    return { ...DEFAULTS, ...readAutomation(undefined), error: err.code === 'ENOENT' ? null : `could not read ${settingsPath()}: ${err.message}` };
  }
  const rules = Array.isArray(raw?.share?.rules) ? raw.share.rules : [];
  return {
    share: {
      default: LEVELS.includes(raw?.share?.default) ? raw.share.default : 'private',
      rules: rules
        .filter((r: any) => typeof r?.path === 'string' && LEVELS.includes(r?.level))
        .map((r: any) => ({ path: expand(r.path), level: r.level })),
    },
    jiraFlow: Object.fromEntries(Object.entries(FLOW).map(([k, d]) => [k, typeof raw?.jiraFlow?.[k] === 'string' && raw.jiraFlow[k].trim() ? raw.jiraFlow[k].trim() : d])) as JiraFlow,
    ...readAutomation(raw?.automation),
    error: null,
  };
}

export async function saveAutomation(automation: AutomationSettings): Promise<void> {
  const path = settingsPath();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    raw = {};
  }
  await mkdir(dirname(path), { recursive: true });
  // The temp name carries the pid and a random suffix so two saves in flight never share a file.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    await writeFile(tmp, JSON.stringify({ ...raw, automation }, null, 2) + '\n');
    // The rename replaces the inode, so the permissions the owner chose have to be carried over.
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
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

export async function gitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000 });
    const b = stdout.trim();
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}
