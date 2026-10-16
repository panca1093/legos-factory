// Minimal MCP client for workbench, always called with the signed-in user's own token.
// Workbench is a gateway: integrations' tools are reached through its execute_tools meta-tool.

export type Integration = { name: string; version: string | null; connected: boolean };

// Jira's "Development" panel: what the linked repos report for an issue (PRs, builds, deploys).
export type JiraDev = {
  prs: { count: number; state: string | null; open: boolean } | null;
  builds: { ok: number; failed: number } | null;
  deploys: { env: string; status: string }[];
  // Jira caches this summary; true means it may lag behind the forge
  stale: boolean;
};

export type JiraIssueRow = {
  key: string;
  summary: string;
  status: string | null;
  assignee: string | null;
  priority: string | null;
  updated: string | null;
  dev: JiraDev | null;
};

// TODO: uncertain — the Development field's id differs per Jira site and workbench can't list fields; 10000 is the common default, verify per site
const DEV_FIELD = process.env.LEGOS_JIRA_DEV_FIELD ?? 'customfield_10000';
// passing `fields` replaces the tool's defaults, so name the ones the row needs too
const ROW_FIELDS = ['summary', 'status', 'assignee', 'priority', 'updated', DEV_FIELD];

// The field is a string like "{pullrequest={...}, build={...}, json={...}}"; the json= tail holds the real summary.
export function parseJiraDev(raw: unknown): JiraDev | null {
  if (typeof raw !== 'string') return null;
  const at = raw.indexOf('json=');
  if (at < 0) return null;
  let doc: any;
  try {
    doc = JSON.parse(raw.slice(at + 5, raw.lastIndexOf('}')));
  } catch {
    return null;
  }
  const sum = doc?.cachedValue?.summary ?? {};
  const pr = sum.pullrequest?.overall;
  const build = sum.build?.overall;
  const dev: JiraDev = {
    prs: pr ? { count: Number(pr.count ?? 0), state: pr.state ?? null, open: pr.open === true } : null,
    builds: build ? { ok: Number(build.successfulBuildCount ?? 0), failed: Number(build.failedBuildCount ?? 0) } : null,
    deploys: (sum['deployment-environment']?.overall?.topEnvironments ?? []).map((e: any) => ({ env: String(e.title), status: String(e.status) })),
    stale: doc.isStale === true,
  };
  return dev.prs || dev.builds || dev.deploys.length ? dev : null;
}

export type RepoRow = { name: string; mainBranch: string | null; updated: string | null; description: string | null };

const REPO_PAGES = 30;
// pages fetched at once after the first; a 1,100-repo workspace drops from ~33 s serial to a few seconds
const REPO_PAGE_BATCH = 6;

export type PrRow = { repo: string; id: number; title: string; state: string; author: string | null; source: string; destination: string; updated: string | null };
export type Pr = PrRow & {
  description: string;
  url: string | null;
  reviewers: { name: string; uuid: string | null; approved: boolean }[];
  comments: number;
  tasks: number;
  created: string | null;
};
export type PrFile = { status: string; path: string; oldPath: string | null; added: number; removed: number };
export type PrComment = { id: number; author: string | null; text: string; path: string | null; line: number | null; created: string | null };

export type JiraIssue = JiraIssueRow & {
  issueType: string | null;
  description: string | null;
  labels: string[];
  reporter: string | null;
  // parent issue key, e.g. the epic
  parent: string | null;
  created: string | null;
  url: string | null;
};

const PROTOCOL = '2025-06-18';

export function tokenFromCloneUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const token = u.protocol === 'https:' && u.hostname === 'bitbucket.org' && u.username === 'x-token-auth' && u.password ? decodeURIComponent(u.password) : null;
    return token && !/[\x00-\x1f\x7f]/.test(token) ? token : null;
  } catch {
    return null;
  }
}

// Jira's rich text (ADF) → Markdown. The tool's own plain-text description drops headings and lists.
const escapeMd = (s: string) => s.replace(/[\\`*_[\]<>|]/g, '\\$&');

function adfInline(nodes: any[] = []): string {
  return nodes
    .map((n) => {
      switch (n?.type) {
        case 'text': {
          let t = escapeMd(n.text ?? '');
          for (const m of n.marks ?? []) {
            if (m.type === 'code') t = '`' + (n.text ?? '').replace(/`/g, "'") + '`';
            else if (m.type === 'strong') t = `**${t}**`;
            else if (m.type === 'em') t = `*${t}*`;
            else if (m.type === 'strike') t = `~~${t}~~`;
          }
          const link = (n.marks ?? []).find((m: any) => m.type === 'link')?.attrs?.href;
          return link ? `[${t}](${link})` : t;
        }
        case 'hardBreak':
          return '  \n';
        case 'emoji':
          return n.attrs?.text ?? n.attrs?.shortName ?? '';
        case 'mention':
          return escapeMd(n.attrs?.text ?? '');
        case 'status':
          return n.attrs?.text ? `\`${n.attrs.text}\`` : '';
        case 'inlineCard':
          return n.attrs?.url ? `<${n.attrs.url}>` : '';
        case 'date':
          return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : '';
        default:
          return adfInline(n?.content);
      }
    })
    .join('');
}

const indent = (text: string, pad: string) => text.replace(/\n(?=.)/g, `\n${pad}`);

function adfBlocks(nodes: any[] = []): string {
  return nodes
    .map((n): string => {
      switch (n?.type) {
        case 'paragraph':
          return adfInline(n.content);
        case 'heading':
          return `${'#'.repeat(Math.min(Math.max(Number(n.attrs?.level) || 2, 1), 6))} ${adfInline(n.content)}`;
        case 'bulletList':
        case 'orderedList': {
          const start = Number(n.attrs?.order) || 1;
          return (n.content ?? [])
            .map((item: any, i: number) => {
              const marker = n.type === 'bulletList' ? '- ' : `${start + i}. `;
              // tight list: an item's paragraphs and nested lists sit on consecutive lines
              const body = (item.content ?? []).map((c: any) => adfBlocks([c])).join('\n');
              return marker + indent(body, ' '.repeat(marker.length));
            })
            .join('\n');
        }
        case 'codeBlock':
          return '```' + (n.attrs?.language ?? '') + '\n' + (n.content ?? []).map((t: any) => t.text ?? '').join('') + '\n```';
        case 'blockquote':
        case 'panel':
          return adfBlocks(n.content)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n');
        case 'rule':
          return '---';
        case 'table': {
          const rows: string[][] = (n.content ?? []).map((r: any) => (r.content ?? []).map((cell: any) => adfBlocks(cell.content).replace(/\n+/g, ' ')));
          if (!rows.length) return '';
          const width = Math.max(...rows.map((r) => r.length));
          const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
          return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
        }
        case 'expand':
        case 'nestedExpand':
          return [n.attrs?.title ? `**${escapeMd(n.attrs.title)}**` : '', adfBlocks(n.content)].filter(Boolean).join('\n\n');
        case 'mediaSingle':
        case 'mediaGroup':
          return '*[attachment]*';
        default:
          return adfBlocks(n?.content);
      }
    })
    .filter((b) => b !== '')
    .join('\n\n');
}

export function adfToMarkdown(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object' || (doc as any).type !== 'doc') return null;
  return adfBlocks((doc as any).content).trim() || null;
}

// Recovers the diff text from a cut-off `{"results":[{"result":"…` envelope, ending at the last whole line.
export function salvageDiff(raw: string): string | null {
  const prefix = '{"results":[{"result":"';
  if (!raw.startsWith(prefix)) return null;
  const body = raw.slice(prefix.length);
  const cut = body.lastIndexOf('\\n');
  if (cut < 0) return null;
  try {
    return JSON.parse(`"${body.slice(0, cut)}"`);
  } catch {
    return null;
  }
}

// A comment list whose JSON envelope was cut: the comments that arrived whole.
export function salvageComments(raw: string): unknown[] | null {
  const prefix = '{"results":[{"result":{"comments":[';
  if (!raw.startsWith(prefix)) return null;
  const body = raw.slice(prefix.length);
  const cut = body.lastIndexOf('},{"id":');
  if (cut < 0) return [];
  try {
    return JSON.parse(`[${body.slice(0, cut + 1)}]`);
  } catch {
    return null;
  }
}

const BUSY = new Set([502, 503, 504]);

export class Workbench {
  // MCP session per token; tokens rotate hourly so this stays small
  private sessions = new Map<string, string>();

  constructor(
    private mcpUrl: string,
    private http: typeof fetch = fetch,
    private retryDelayMs = 500,
  ) {}

  private async post(token: string, body: object, session: string | null) {
    for (let attempt = 0; ; attempt++) {
      const out = await this.postOnce(token, body, session);
      if (!BUSY.has(out.res.status) || attempt === 2) return out;
      await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
    }
  }

  private async postOnce(token: string, body: object, session: string | null) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (session) Object.assign(headers, { 'mcp-session-id': session, 'mcp-protocol-version': PROTOCOL });
    const res = await this.http(this.mcpUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const raw = await res.text();
    if (!res.ok) return { res, msg: null };
    // Streamable HTTP may answer as an SSE stream of data: lines. Decide by the shape, not by "data:" appearing
    // somewhere: a plain JSON answer can carry that text (e.g. a PR description).
    const sse = (res.headers.get('content-type') ?? '').includes('text/event-stream') || /^(event|data|id|:)/.test(raw.trimStart());
    const json = sse ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('') : raw;
    try {
      return { res, msg: json.trim() ? JSON.parse(json) : null };
    } catch {
      throw new Error('workbench sent an unreadable response');
    }
  }

  private async session(token: string): Promise<string> {
    const hit = this.sessions.get(token);
    if (hit) return hit;
    const { res } = await this.post(
      token,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'legos-factory', version: '1' } } },
      null,
    );
    if (!res.ok) throw new Error(`workbench unavailable (HTTP ${res.status})`);
    const sid = res.headers.get('mcp-session-id') ?? '';
    await this.post(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    this.sessions.set(token, sid);
    return sid;
  }

  // Calls a workbench tool and returns its parsed JSON text result.
  async call(token: string, name: string, args: object = {}, retried = false): Promise<any> {
    const sid = await this.session(token);
    const { res, msg } = await this.post(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, sid);
    if ((res.status === 404 || res.status === 400) && !retried) {
      // expired MCP session: start a new one once
      this.sessions.delete(token);
      return this.call(token, name, args, true);
    }
    if (!res.ok) throw new Error(`workbench ${name} failed (HTTP ${res.status})`);
    if (msg?.error) throw new Error(msg.error.message ?? `workbench ${name} failed`);
    const text = msg?.result?.content?.find((c: any) => c.type === 'text')?.text;
    if (msg?.result?.isError) throw new Error(text ?? `workbench ${name} failed`);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }

  // Runs one integration tool through execute_tools; `salvage` rescues an answer workbench cut off at ~60k chars.
  async execute(token: string, tool: string, args: object, salvage?: (raw: string) => unknown): Promise<any> {
    const out = await this.call(token, 'execute_tools', { executions: [{ tool, args }] });
    if (typeof out === 'string') {
      const rescued = salvage?.(out);
      if (rescued) return rescued;
      throw new Error(`${tool} answer was too large and got cut off by workbench`);
    }
    const first = out?.results?.[0];
    if (!first) throw new Error(`${tool} returned nothing`);
    // e.g. { error: 'NOT_CONNECTED', message: 'github not connected. Use connect(...)' }
    if (first.error) throw new Error(first.message ?? (typeof first.error === 'string' ? first.error : (first.error.message ?? `${tool} failed`)));
    return first.result;
  }

  async whoami(token: string): Promise<{ id: string | null; email: string | null; name: string | null } | null> {
    const me = await this.call(token, 'whoami');
    return me && (me.id || me.email) ? { id: me.id ?? null, email: me.email ?? null, name: me.name ?? null } : null;
  }

  async integrations(token: string): Promise<Integration[]> {
    const out = await this.call(token, 'list_integrations');
    return (out?.integrations ?? []).map((i: any) => ({ name: String(i.name), version: i.version ?? null, connected: i.connected === true }));
  }

  // Returns the workbench URL the user opens to authorise the integration.
  async connect(token: string, integration: string): Promise<{ url: string | null; connectionId: string | null }> {
    const out = await this.call(token, 'connect', { integration });
    const url = out?.url ?? out?.authUrl ?? out?.connectUrl ?? (typeof out === 'string' ? out.match(/https?:\/\/\S+/)?.[0] : null);
    return { url: url ?? null, connectionId: out?.connectionId ?? null };
  }

  async jiraSearch(token: string, jql: string, maxResults: number, nextPageToken?: string): Promise<{ issues: JiraIssueRow[]; nextPageToken: string | null }> {
    const out = await this.execute(token, 'jira_search_issues', { jql, maxResults, fields: ROW_FIELDS, ...(nextPageToken && { nextPageToken }) });
    return {
      issues: (out?.issues ?? []).map((i: any) => ({
        key: i.key,
        summary: i.summary ?? '',
        status: i.status ?? null,
        assignee: i.assignee ?? null,
        priority: i.priority ?? null,
        updated: i.updated ?? null,
        dev: parseJiraDev(i.fields?.[DEV_FIELD]),
      })),
      nextPageToken: out?.nextPageToken ?? null,
    };
  }

  // Every repo in a Bitbucket workspace, most recently updated first. The tool has no search, so page through all.
  async bitbucketRepos(token: string, workspace: string): Promise<RepoRow[]> {
    const page = (n: number) => this.execute(token, 'bitbucket_list_repos', { workspace, pagelen: 100, page: n });
    const pages = [await page(1)];
    for (let next = 2; pages.at(-1)?.hasMore && next <= REPO_PAGES; next += REPO_PAGE_BATCH) {
      const batch = await Promise.all(Array.from({ length: Math.min(REPO_PAGE_BATCH, REPO_PAGES - next + 1) }, (_, i) => page(next + i)));
      // an empty page past the end has hasMore false; keep everything up to the first such page
      const end = batch.findIndex((p) => !p?.hasMore);
      pages.push(...(end < 0 ? batch : batch.slice(0, end + 1)));
    }
    const out: RepoRow[] = pages.flatMap((r) =>
      (r?.repos ?? []).map((x: any) => ({ name: String(x.full_name ?? `${workspace}/${x.slug}`), mainBranch: x.mainbranch ?? null, updated: x.updated_on ?? null, description: x.description || null })),
    );
    return out.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  }

  async bitbucketPrs(token: string, workspace: string, slug: string, state: 'OPEN' | 'MERGED' | 'DECLINED', pagelen = 50): Promise<PrRow[]> {
    const r = await this.execute(token, 'bitbucket_list_prs', { workspace, repoSlug: slug, state, pagelen });
    return (r?.prs ?? []).map((p: any) => ({
      repo: `${workspace}/${slug}`,
      id: Number(p.id),
      title: String(p.title ?? ''),
      state: String(p.state ?? state),
      author: p.author ?? null,
      source: String(p.source ?? ''),
      destination: String(p.destination ?? ''),
      updated: p.updated_on ?? null,
    }));
  }

  async bitbucketPr(token: string, workspace: string, slug: string, id: number): Promise<Pr> {
    const p = await this.execute(token, 'bitbucket_get_pr', { workspace, repoSlug: slug, pullRequestId: id });
    return {
      repo: `${workspace}/${slug}`,
      id: Number(p.id),
      title: String(p.title ?? ''),
      state: String(p.state ?? ''),
      author: p.author ?? null,
      source: String(p.source ?? ''),
      destination: String(p.destination ?? ''),
      updated: p.updated_on ?? null,
      created: p.created_on ?? null,
      description: String(p.description ?? ''),
      url: p.url ?? null,
      reviewers: (p.reviewers ?? []).map((r: any) => ({ name: String(r.display_name ?? 'Reviewer'), uuid: r.uuid ?? null, approved: r.approved === true })),
      comments: Number(p.comment_count ?? 0),
      tasks: Number(p.task_count ?? 0),
    };
  }

  async bitbucketPrFiles(token: string, workspace: string, slug: string, id: number): Promise<PrFile[]> {
    const r = await this.execute(token, 'bitbucket_get_pr_diff', { workspace, repoSlug: slug, prId: id, diffstat: true });
    return (r?.files ?? []).map((f: any) => ({
      status: String(f.status ?? 'modified'),
      path: String(f.new ?? f.old ?? ''),
      oldPath: f.old && f.old !== f.new ? String(f.old) : null,
      added: Number(f.lines_added ?? 0),
      removed: Number(f.lines_removed ?? 0),
    }));
  }

  // The whole unified diff, or as much of it as workbench returns: workbench cuts tool text at ~60,000 characters,
  // which breaks the JSON of a big diff.
  async bitbucketPrDiff(token: string, workspace: string, slug: string, id: number): Promise<{ diff: string; truncated: boolean }> {
    const out = await this.call(token, 'execute_tools', { executions: [{ tool: 'bitbucket_get_pr_diff', args: { workspace, repoSlug: slug, prId: id } }] });
    if (typeof out === 'string') {
      const partial = salvageDiff(out);
      if (partial === null) throw new Error('bitbucket_get_pr_diff returned an unreadable result');
      return { diff: partial, truncated: true };
    }
    const first = out?.results?.[0];
    if (!first) throw new Error('bitbucket_get_pr_diff returned nothing');
    if (first.error) throw new Error(first.message ?? 'bitbucket_get_pr_diff failed');
    const r = first.result;
    return { diff: typeof r === 'string' ? r : String(r?.diff ?? r?.text ?? ''), truncated: false };
  }

  async bitbucketPrComments(token: string, workspace: string, slug: string, id: number): Promise<PrComment[]> {
    const r = await this.execute(token, 'bitbucket_list_pr_comments', { workspace, repoSlug: slug, prId: id, pagelen: 100 }, (raw) => {
      const comments = salvageComments(raw);
      return comments && { comments };
    });
    return (r?.comments ?? []).map((c: any) => ({
      id: Number(c.id),
      author: c.author ?? null,
      text: String(c.text ?? ''),
      path: c.inline?.path ?? null,
      line: c.inline?.line ?? null,
      created: c.created_on ?? null,
    }));
  }

  async bitbucketSearchUsers(token: string, workspace: string, query: string): Promise<{ name: string; uuid: string }[]> {
    const r = await this.execute(token, 'bitbucket_search_users', { workspace, query, pagelen: 20 });
    return (r?.users ?? []).map((u: any) => ({ name: String(u.display_name ?? ''), uuid: String(u.uuid ?? '') })).filter((u: { uuid: string }) => u.uuid);
  }

  // The tool has no parent id, so a reply is a new comment on the same line (or a general one).
  async bitbucketAddComment(token: string, workspace: string, slug: string, id: number, text: string, inline?: { path: string; line: number }): Promise<{ id: number }> {
    const r = await this.execute(token, 'bitbucket_add_pr_comment', { workspace, repoSlug: slug, prId: id, text, ...(inline && { inline }) });
    return { id: Number(r?.id) };
  }

  // https://x-token-auth:<token>@bitbucket.org/<ws>/<slug>.git, good for ≤2h; never log or persist it
  async bitbucketCloneUrl(token: string, workspace: string, slug: string): Promise<string> {
    const r = await this.execute(token, 'bitbucket_get_clone_url', { workspace, repoSlug: slug });
    return String((typeof r === 'string' ? r : (r?.url ?? r?.cloneUrl ?? r?.clone_url)) ?? '');
  }

  async jiraStatus(token: string, issueKey: string): Promise<string | null> {
    const i = await this.execute(token, 'jira_get_issue', { issueKey });
    return i?.status ?? null;
  }

  async jiraTransitions(token: string, issueKey: string): Promise<{ id: string; name: string; toStatus: string }[]> {
    const r = await this.execute(token, 'jira_get_transitions', { issueKey });
    return (Array.isArray(r) ? r : (r?.transitions ?? [])).map((t: any) => ({ id: String(t.id), name: String(t.name ?? ''), toStatus: String(t.toStatus ?? t.to?.name ?? '') }));
  }

  async jiraTransition(token: string, issueKey: string, transitionId: string): Promise<void> {
    const r = await this.execute(token, 'jira_transition_issue', { issueKey, transitionId });
    if (r?.success === false) throw new Error(`jira_transition_issue refused ${issueKey}`);
  }

  async jiraAddComment(token: string, issueKey: string, body: string): Promise<void> {
    await this.execute(token, 'jira_add_comment', { issueKey, body });
  }

  async jiraIssue(token: string, issueKey: string): Promise<JiraIssue> {
    // the raw description (ADF) keeps headings and lists that the tool's plain-text version flattens
    const i = await this.execute(token, 'jira_get_issue', { issueKey, fields: ['description'] });
    return {
      key: i.key,
      summary: i.summary ?? '',
      status: i.status ?? null,
      assignee: i.assignee ?? null,
      priority: i.priority ?? null,
      updated: i.updated ?? null,
      dev: null,
      issueType: i.issueType ?? null,
      description: adfToMarkdown(i.fields?.description) ?? i.description ?? null,
      labels: Array.isArray(i.labels) ? i.labels : [],
      reporter: i.reporter ?? null,
      parent: typeof i.parent === 'string' ? i.parent : (i.parent?.key ?? null),
      created: i.created ?? null,
      url: i.url ?? null,
    };
  }
}
