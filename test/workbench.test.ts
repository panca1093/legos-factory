import { describe, expect, it } from 'vitest';
import { adfToMarkdown, parseJiraDev, salvageComments, salvageDiff, Workbench } from '../server/workbench.ts';

// Shapes as Jira returns the Development field (values trimmed to what the parser reads)
const MERGED_DEV =
  '{pullrequest={dataType=pullrequest, state=MERGED, stateCount=1}, build={count=1, dataType=build, failedBuildCount=0, successfulBuildCount=1, unknownBuildCount=0}, json={"cachedValue":{"errors":[],"summary":{"pullrequest":{"overall":{"count":1,"stateCount":1,"state":"MERGED","dataType":"pullrequest","open":false}},"build":{"overall":{"count":1,"failedBuildCount":0,"successfulBuildCount":1,"unknownBuildCount":0,"dataType":"build"}},"deployment-environment":{"overall":{"count":1,"topEnvironments":[{"title":"UAT","status":"NOT_DEPLOYED"}],"dataType":"deployment-environment"}}}},"isStale":true}}';
const REPO_ONLY_DEV =
  '{repository={count=1, dataType=repository}, json={"cachedValue":{"errors":[],"summary":{"repository":{"overall":{"count":1,"dataType":"repository"}}}},"isStale":true}}';
const OPEN_DEV =
  '{pullrequest={dataType=pullrequest, state=OPEN, stateCount=2}, json={"cachedValue":{"errors":[],"summary":{"pullrequest":{"overall":{"count":2,"stateCount":2,"state":"OPEN","dataType":"pullrequest","open":true}}}},"isStale":false}}';

describe('workbench responses', () => {
  it('reads a plain JSON answer whose content mentions "data:"', async () => {
    const http = (async (_u: any, init: any) => {
      const msg = JSON.parse(init.body);
      if (msg.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { headers: { 'mcp-session-id': 's1' } });
      if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
      const result = { results: [{ result: { id: 668, title: 'x', description: 'response shape `{data: [...]}`\ndata: not a stream line' } }] };
      return Response.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    }) as typeof fetch;
    const wb = new Workbench('https://wb.test/mcp', http);
    expect(await wb.execute('tok', 'bitbucket_get_pr', {})).toMatchObject({ id: 668, description: expect.stringContaining('{data: [') });
  });
});

describe('Jira rich text', () => {
  const t = (text: string, marks?: object[]) => ({ type: 'text', text, ...(marks && { marks }) });
  const p = (...content: object[]) => ({ type: 'paragraph', content });
  const li = (...content: object[]) => ({ type: 'listItem', content });
  it('turns headings, nested lists, marks and tables into Markdown', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'emoji', attrs: { text: '🧭' } }, t(' Context')] },
        p(t('Uses '), t('GET /v1/x', [{ type: 'code' }]), t(' and tag risk.date:<ts> — see '), t('TRD', [{ type: 'link', attrs: { href: 'https://x/trd' } }])),
        { type: 'bulletList', content: [li(p(t('rejected if:')), { type: 'bulletList', content: [li(p(t('unknown scheme'))), li(p(t('bad date')))] }), li(p(t('stored', [{ type: 'strong' }])))] },
        { type: 'orderedList', attrs: { order: 3 }, content: [li(p(t('third'))), li(p(t('fourth')))] },
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('Case'))] }, { type: 'tableHeader', content: [p(t('Result'))] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('dup'))] }, { type: 'tableCell', content: [p(t('no-op'))] }] }] },
      ],
    };
    expect(adfToMarkdown(doc)).toBe(
      [
        '## 🧭 Context',
        'Uses `GET /v1/x` and tag risk.date:\\<ts\\> — see [TRD](https://x/trd)',
        '- rejected if:\n  - unknown scheme\n  - bad date\n- **stored**',
        '3. third\n4. fourth',
        '| Case | Result |\n| --- | --- |\n| dup | no-op |',
      ].join('\n\n'),
    );
  });

  it('gives up on anything that is not an ADF document', () => {
    expect(adfToMarkdown('plain text')).toBeNull();
    expect(adfToMarkdown(null)).toBeNull();
    expect(adfToMarkdown({ type: 'doc', content: [] })).toBeNull();
  });
});

describe('cut-off diffs', () => {
  it('keeps the whole lines of a diff whose JSON envelope was cut, and gives up on anything else', () => {
    const full = JSON.stringify({ results: [{ result: 'diff --git a/x b/x\n+one\n+two\n+thr' }] });
    const cut = full.slice(0, full.indexOf('+thr') + 2);
    expect(salvageDiff(cut)).toBe('diff --git a/x b/x\n+one\n+two');
    expect(salvageDiff('{"error":"x"}')).toBeNull();
    expect(salvageDiff('{"results":[{"result":"no newline yet')).toBeNull();
  });
});

describe('Jira Development field', () => {
  it('reads PRs, builds and deploys, and ignores what it cannot use', () => {
    expect(parseJiraDev(OPEN_DEV)).toEqual({ prs: { count: 2, state: 'OPEN', open: true }, builds: null, deploys: [], stale: false });
    expect(parseJiraDev(REPO_ONLY_DEV)).toBeNull(); // commits only: nothing to show
    expect(parseJiraDev('{}')).toBeNull();
    expect(parseJiraDev('{json={not json}}')).toBeNull();
    expect(parseJiraDev(undefined)).toBeNull();
  });
});

const URL_ = 'https://wb.test/mcp';

// Fake workbench MCP: sessions, list_integrations, connect, and execute_tools for Jira.
function fake(opts: { expireOnce?: boolean } = {}) {
  const seen: { method: string; tool?: string; args?: any; auth: string | null; session: string | null }[] = [];
  let expired = !opts.expireOnce;
  let n = 0;
  const http = (async (_u: any, init: any) => {
    const msg = JSON.parse(init.body);
    const h = new Headers(init.headers);
    seen.push({ method: msg.method, tool: msg.params?.name, args: msg.params?.arguments, auth: h.get('authorization'), session: h.get('mcp-session-id') });
    if (msg.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { headers: { 'mcp-session-id': `s${++n}` } });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    if (!expired) {
      expired = true;
      return new Response('session expired', { status: 404 });
    }
    const text = (v: unknown) => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(v) }] } })}\n\n`;
    const name = msg.params.name;
    if (name === 'list_integrations') return new Response(text({ integrations: [{ name: 'atlassian-jira', version: '1.0.0', connected: true }, { name: 'github', version: '1.0.0', connected: false }] }));
    if (name === 'connect') return new Response(text({ connectionId: 'c1', url: 'https://wb.test/connect/c1' }));
    if (name === 'execute_tools') {
      const ex = msg.params.arguments.executions[0];
      if (ex.tool === 'jira_search_issues') {
        // like the real tool: an explicit `fields` list returns only those fields
        const all: Record<string, unknown> = { summary: 'Do it', status: 'To Do', assignee: 'P', priority: 'P2', updated: 'x' };
        const want: string[] | undefined = ex.args.fields;
        const row: Record<string, unknown> = { key: 'PROJ-1', ...(want ? Object.fromEntries(Object.entries(all).filter(([k]) => want.includes(k))) : all) };
        if (want?.includes('customfield_10000')) row.fields = { customfield_10000: MERGED_DEV };
        return new Response(text({ results: [{ result: { issues: [row], nextPageToken: 'n1' } }] }));
      }
      if (ex.tool === 'jira_get_issue') return new Response(text({ results: [{ result: { key: 'PROJ-1', summary: 'Do it', description: 'details', url: 'https://jira/PROJ-1', labels: ['a'], reporter: 'Rae', parent: 'PROJ-0', created: 'c1' } }] }));
      return new Response(text({ results: [{ error: 'NOT_CONNECTED', integration: 'github', message: 'github not connected. Use connect(\'github\') to connect.' }] }));
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'unknown tool' } }));
  }) as typeof fetch;
  return { wb: new Workbench(URL_, http), seen };
}

describe('Workbench client', () => {
  it('lists integrations with the caller token and reuses its MCP session', async () => {
    const { wb, seen } = fake();
    expect(await wb.integrations('tok-a')).toEqual([
      { name: 'atlassian-jira', version: '1.0.0', connected: true },
      { name: 'github', version: '1.0.0', connected: false },
    ]);
    await wb.integrations('tok-a');
    expect(seen.filter((s) => s.method === 'initialize')).toHaveLength(1);
    expect(seen.every((s) => s.auth === 'Bearer tok-a')).toBe(true);
  });

  it('keeps sessions separate per user token', async () => {
    const { wb, seen } = fake();
    await wb.integrations('tok-a');
    await wb.integrations('tok-b');
    expect(seen.filter((s) => s.method === 'initialize').map((s) => s.auth)).toEqual(['Bearer tok-a', 'Bearer tok-b']);
  });

  it('starts a new MCP session once when the old one expired', async () => {
    const { wb, seen } = fake({ expireOnce: true });
    expect((await wb.integrations('tok')).length).toBe(2);
    expect(seen.filter((s) => s.method === 'initialize')).toHaveLength(2);
  });

  it('searches and reads Jira through execute_tools', async () => {
    const { wb, seen } = fake();
    expect(await wb.jiraSearch('tok', 'assignee = currentUser()', 20)).toEqual({
      issues: [
        {
          key: 'PROJ-1', summary: 'Do it', status: 'To Do', assignee: 'P', priority: 'P2', updated: 'x',
          dev: { prs: { count: 1, state: 'MERGED', open: false }, builds: { ok: 1, failed: 0 }, deploys: [{ env: 'UAT', status: 'NOT_DEPLOYED' }], stale: true },
        },
      ],
      nextPageToken: 'n1',
    });
    expect(seen.at(-1)!.args).toEqual({ executions: [{ tool: 'jira_search_issues', args: { jql: 'assignee = currentUser()', maxResults: 20, fields: ['summary', 'status', 'assignee', 'priority', 'updated', 'customfield_10000'] } }] });
    expect(await wb.jiraIssue('tok', 'PROJ-1')).toMatchObject({ key: 'PROJ-1', description: 'details', url: 'https://jira/PROJ-1', labels: ['a'], reporter: 'Rae', parent: 'PROJ-0', created: 'c1' });
  });

  it('surfaces per-tool errors and returns the connect URL', async () => {
    const { wb } = fake();
    await expect(wb.execute('tok', 'github_list_prs', {})).rejects.toThrow('github not connected');
    expect(await wb.connect('tok', 'github')).toEqual({ url: 'https://wb.test/connect/c1', connectionId: 'c1' });
  });
});

// One tool reply per call: plain text (what workbench sends back) or an HTTP status.
function scripted(replies: (string | number)[]) {
  const http = (async (_u: any, init: any) => {
    const msg = JSON.parse(init.body);
    if (msg.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { headers: { 'mcp-session-id': 's1' } });
    if (msg.method === 'notifications/initialized') return new Response('', { status: 202 });
    const r = replies.shift()!;
    if (typeof r === 'number') return new Response('unavailable', { status: r });
    return Response.json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: r } ] } });
  }) as typeof fetch;
  return new Workbench('https://wb.test/mcp', http, 0);
}

describe('cut-off comment lists', () => {
  const c = (id: number) => ({ id, author: 'Ada', text: `long {"id":1} text ${id}`, created_on: '2026-10-01' });
  const full = JSON.stringify({ results: [{ result: { comments: [c(1), c(2), c(3)], hasMore: true } }] });
  const cut = full.slice(0, full.indexOf('"id":3') + 12) + '\n…[truncated: 103866 chars, limit 60000.]';

  it('keeps the whole comments before the cut, and gives up on anything else', () => {
    expect(salvageComments(cut)?.map((x: any) => x.id)).toEqual([1, 2]);
    expect(salvageComments('{"error":"x"}')).toBeNull();
    expect(salvageComments('{"results":[{"result":{"comments":[{"id":1,"te')).toEqual([]);
  });

  it('returns the salvaged comments of a PR whose list was cut', async () => {
    const wb = scripted([cut]);
    expect((await wb.bitbucketPrComments('tok', 'acme', 'api', 1)).map((x) => x.id)).toEqual([1, 2]);
  });
});

describe('busy workbench', () => {
  const ok = JSON.stringify({ integrations: [] });
  it('retries a 502, 503 or 504 twice, then gives up', async () => {
    expect(await scripted([503, 502, ok]).integrations('tok')).toEqual([]);
    await expect(scripted([503, 503, 504, ok]).integrations('tok')).rejects.toThrow(/HTTP 504/);
    await expect(scripted([500, ok]).integrations('tok')).rejects.toThrow(/HTTP 500/);
  });
});
