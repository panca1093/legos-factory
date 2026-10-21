import type { DevSummary, WorkItemDetail, WorkItemRow, WorkSource } from '../ports.ts';
import type { Workbench } from '../workbench.ts';

// Jira through workbench's execute_tools, with the signed-in user's own token.

// the Development field's id differs per Jira site and workbench cannot list fields; 10000 is the common default
const DEV_FIELD = process.env.LEGOS_JIRA_DEV_FIELD ?? 'customfield_10000';
// passing `fields` replaces the tool's defaults, so name the ones the row needs too
const ROW_FIELDS = ['summary', 'status', 'assignee', 'priority', 'updated', DEV_FIELD];

const PRESETS: Record<string, string> = {
  mine: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
  sprint: 'assignee = currentUser() AND sprint in openSprints() ORDER BY status ASC, updated DESC',
};

// The field is a string like "{pullrequest={...}, build={...}, json={...}}"; the json= tail holds the real summary.
export function parseJiraDev(raw: unknown): DevSummary | null {
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
  const dev: DevSummary = {
    prs: pr ? { count: Number(pr.count ?? 0), state: pr.state ?? null, open: pr.open === true } : null,
    builds: build ? { ok: Number(build.successfulBuildCount ?? 0), failed: Number(build.failedBuildCount ?? 0) } : null,
    deploys: (sum['deployment-environment']?.overall?.topEnvironments ?? []).map((e: any) => ({ env: String(e.title), status: String(e.status) })),
    stale: doc.isStale === true,
  };
  return dev.prs || dev.builds || dev.deploys.length ? dev : null;
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


export function jiraWorkSource(wb: Workbench, token: string): WorkSource {
  const run = (tool: string, args: object) => wb.execute(token, tool, args);
  return {

    async list({ filter, query }, maxResults, nextPageToken) {
      const jql = query || PRESETS[filter];
      if (!jql) throw Object.assign(new Error('unknown filter'), { status: 400 });
      const out = await run('jira_search_issues', { jql, maxResults, fields: ROW_FIELDS, ...(nextPageToken && { nextPageToken }) });
      return {
        items: (out?.issues ?? []).map(
          (i: any): WorkItemRow => ({
            key: i.key,
            summary: i.summary ?? '',
            status: i.status ?? null,
            assignee: i.assignee ?? null,
            priority: i.priority ?? null,
            updated: i.updated ?? null,
            dev: parseJiraDev(i.fields?.[DEV_FIELD]),
          }),
        ),
        next: out?.nextPageToken ?? null,
      };
    },

    async get(issueKey): Promise<WorkItemDetail> {
      // the raw description (ADF) keeps headings and lists that the tool's plain-text version flattens
      const i = await run('jira_get_issue', { issueKey, fields: ['description'] });
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
    },

    async status(issueKey) {
      const i = await run('jira_get_issue', { issueKey });
      return i?.status ?? null;
    },

    // the transition id is looked up at the moment of the move
    async transitionTo(issueKey, status) {
      const r = await run('jira_get_transitions', { issueKey });
      const all = (Array.isArray(r) ? r : (r?.transitions ?? [])).map((t: any) => ({ id: String(t.id), toStatus: String(t.toStatus ?? t.to?.name ?? '') }));
      const want = status.trim().toLowerCase();
      const t = all.find((x: { toStatus: string }) => x.toStatus.trim().toLowerCase() === want);
      if (!t) return false;
      const done = await run('jira_transition_issue', { issueKey, transitionId: t.id });
      if (done?.success === false) throw new Error(`jira_transition_issue refused ${issueKey}`);
      return true;
    },

    async comment(issueKey, body) {
      await run('jira_add_comment', { issueKey, body });
    },
  };
}
