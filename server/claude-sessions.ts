import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionDetail, SessionSummary, TimelineEvent, Usage } from '../shared/types.ts';

const MAX_TEXT = 4000;

export function projectsDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
}

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s);

function toolInputSummary(input: any): string {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    if (typeof input[k] === 'string') return input[k];
  }
  return JSON.stringify(input);
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b: any) => (b?.type === 'text' ? b.text : b?.type ? `[${b.type}]` : '')).join('\n');
  }
  return '';
}

// Works for both JSONL transcript records and live SDK messages — they share the Messages API shape.
export function toEvents(r: any, fallbackAt = new Date().toISOString()): TimelineEvent[] {
  const at: string = r.timestamp ?? fallbackAt;
  const base = r.uuid ?? `${r.type}-${at}`;
  const sidechain = r.isSidechain === true || (r.parent_tool_use_id ?? null) !== null;
  const out: TimelineEvent[] = [];
  const push = (e: Omit<TimelineEvent, 'id' | 'at' | 'sidechain'>) =>
    out.push({ id: `${base}:${out.length}`, at, sidechain, ...e, text: clip(e.text) });

  if (r.type === 'user' && !r.isMeta) {
    const c = r.message?.content;
    if (typeof c === 'string') {
      const local = c.match(/^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/);
      push({ kind: c.startsWith('<') ? 'system' : 'user', text: local ? local[1] : c });
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text') push({ kind: 'user', text: b.text });
        else if (b.type === 'tool_result') push({ kind: 'tool_result', text: blockText(b.content), isError: b.is_error === true });
      }
    }
  } else if (r.type === 'assistant') {
    for (const b of r.message?.content ?? []) {
      if (b.type === 'text' && b.text) push({ kind: 'assistant', text: b.text });
      else if (b.type === 'thinking' && b.thinking) push({ kind: 'thinking', text: b.thinking });
      else if (b.type === 'tool_use') push({ kind: 'tool_use', tool: b.name, text: toolInputSummary(b.input) });
    }
  } else if (r.type === 'system' && (r.level === 'error' || r.subtype === 'api_error' || r.subtype === 'compact_boundary')) {
    push({ kind: 'system', text: r.content ?? r.subtype, isError: r.level === 'error' || r.subtype === 'api_error' });
  }
  return out;
}

const addUsage = (a: Usage, u: any) => {
  a.input += u.input_tokens ?? 0;
  a.cacheWrite += u.cache_creation_input_tokens ?? 0;
  a.cacheRead += u.cache_read_input_tokens ?? 0;
  a.output += u.output_tokens ?? 0;
};

async function* records(path: string): AsyncGenerator<any> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // partial trailing line while the session is still being written
    }
  }
}

// One API message is split across several assistant records sharing message.id, each repeating usage.
async function usageByMessage(path: string, into: Map<string, any>) {
  for await (const r of records(path)) {
    if (r.type === 'assistant' && r.message?.usage) into.set(r.message.id ?? r.uuid, r.message.usage);
  }
}

async function listSubagentFiles(sessionPath: string): Promise<string[]> {
  const dir = join(sessionPath.replace(/\.jsonl$/, ''), 'subagents');
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export async function summarize(path: string, withEvents = false): Promise<SessionDetail> {
  const s: SessionDetail = {
    id: basename(path, '.jsonl'),
    runtime: 'claude-code',
    cwd: null,
    title: '',
    gitBranch: null,
    startedAt: null,
    lastActivityAt: null,
    models: [],
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    subagents: 0,
    ticket: null,
    share: 'private',
    usage: null,
    activeRunId: null,
    events: [],
  };
  let customTitle = '';
  let firstPrompt = '';
  const usage = new Map<string, any>();
  const models = new Set<string>();

  for await (const r of records(path)) {
    if (r.timestamp) {
      s.startedAt ??= r.timestamp;
      s.lastActivityAt = r.timestamp;
    }
    if (r.cwd) s.cwd ??= r.cwd;
    if (r.gitBranch) s.gitBranch = r.gitBranch;
    if (r.type === 'custom-title') customTitle = r.customTitle;
    if (r.type === 'user' && !r.isMeta) {
      // CLI stores prompts as a string, SDK as text blocks; tool_result-only records aren't prompts
      const c = r.message?.content;
      const prompt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : '';
      if (prompt && !prompt.startsWith('<') && !prompt.startsWith('[Request interrupted')) {
        s.turns++;
        firstPrompt ||= prompt;
      }
    }
    if (r.type === 'assistant') {
      const m = r.message;
      if (m?.model && m.model !== '<synthetic>') models.add(m.model);
      if (m?.usage) usage.set(m.id ?? r.uuid, m.usage);
    }
    for (const e of toEvents(r)) {
      if (e.kind === 'tool_use') s.toolCalls++;
      if (e.kind === 'tool_result' && e.isError) s.toolErrors++;
      if (withEvents) s.events.push(e);
    }
  }

  const subs = await listSubagentFiles(path);
  s.subagents = subs.length;
  for (const f of subs) await usageByMessage(f, usage);

  if (usage.size > 0) {
    const total: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    for (const u of usage.values()) addUsage(total, u);
    s.usage = total;
  }
  s.models = [...models];
  s.title = (customTitle || firstPrompt || '(untitled)').split('\n')[0].slice(0, 120);
  return s;
}

type CacheEntry = { mtimeMs: number; size: number; summary: SessionSummary };
const cache = new Map<string, CacheEntry>();

// Summaries for the given sessions (those legos-factory started), in the given order; missing transcripts are skipped.
export async function listSessions(ids: string[]): Promise<SessionSummary[]> {
  const out = await Promise.all(
    ids.map(async (id) => {
      const path = await findSessionPath(id);
      const st = path && (await stat(path).catch(() => null));
      if (!path || !st) return null;
      const hit = cache.get(path);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
      const { events: _, ...summary } = await summarize(path);
      cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, summary });
      return summary;
    }),
  );
  return out.filter((s): s is SessionSummary => s !== null);
}

export async function findSessionPath(id: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const root = projectsDir();
  for (const d of await readdir(root).catch(() => [] as string[])) {
    const p = join(root, d, `${id}.jsonl`);
    if (await stat(p).then(() => true, () => false)) return p;
  }
  return null;
}

export async function getSession(id: string): Promise<SessionDetail | null> {
  const p = await findSessionPath(id);
  return p ? summarize(p, true) : null;
}
