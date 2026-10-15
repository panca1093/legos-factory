import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { HttpError, TICKET_RE, parse, readBody, requireWorkbench, text, upstream, type Deps, type Env } from '../http.ts';

const JQL_PRESETS: Record<string, string> = {
  mine: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
  sprint: 'assignee = currentUser() AND sprint in openSprints() ORDER BY status ASC, updated DESC',
};

const reposQuery = z.object({ workspace: text() });
const connectSchema = z.object({ integration: text().refine((i) => /^[a-z0-9-]{1,64}$/.test(i), 'invalid integration') });
const days = (c: Context) => Math.min(Math.max(Number(c.req.query('days') ?? 7) || 7, 1), 90);

export function jiraRoutes(deps: Deps) {
  const { activity, opts, http } = deps;
  const routes = new Hono<Env>();

  routes.get('/api/jira/issues', async (c) => {
    const jql = (c.req.query('jql') ?? '').trim() || JQL_PRESETS[c.req.query('filter') ?? 'mine'];
    if (!jql || jql.length > 1000) throw new HttpError(400, 'unknown filter or JQL too long');
    const wb = await requireWorkbench(deps, c.get('uid'));
    return c.json(await upstream(wb.client.jiraSearch(wb.token, jql, 20, c.req.query('pageToken') || undefined)));
  });

  routes.get('/api/jira/issues/:key', async (c) => {
    const key = c.req.param('key').toUpperCase();
    if (!TICKET_RE.test(key)) throw new HttpError(400, 'invalid issue key');
    const wb = await requireWorkbench(deps, c.get('uid'));
    return c.json(await upstream(wb.client.jiraIssue(wb.token, key)));
  });

  routes.get('/api/repos', async (c) => {
    const workspace = parse(reposQuery, c.req.query()).workspace || opts.bitbucketWorkspace || '';
    if (!workspace) throw new HttpError(400, 'workspace is required', { needWorkspace: true });
    if (!/^[\w.-]{1,100}$/.test(workspace)) throw new HttpError(400, 'invalid workspace');
    const wb = await requireWorkbench(deps, c.get('uid'));
    return c.json({ workspace, repos: await upstream(deps.workspaceRepos(c.get('uid'), wb, workspace, c.req.query('refresh') === '1')) });
  });

  routes.get('/api/workbench/integrations', async (c) => {
    const wb = await requireWorkbench(deps, c.get('uid'));
    return c.json({ integrations: await upstream(wb.client.integrations(wb.token)) });
  });

  routes.post('/api/workbench/connect', async (c) => {
    const { integration } = parse(connectSchema, await readBody(c));
    const wb = await requireWorkbench(deps, c.get('uid'));
    return c.json(await upstream(wb.client.connect(wb.token, integration)));
  });

  routes.get('/api/activity/me', async (c) => c.json({ items: await activity.list(c.get('uid'), Date.now() - days(c) * 86_400_000) }));

  // Team view is read from the hub as the signed-in user; the hub never sees cost or transcripts.
  routes.get('/api/team', async (c) => {
    if (!opts.hubUrl) throw new HttpError(409, 'team hub not configured', { configured: false });
    const wb = await requireWorkbench(deps, c.get('uid'), { configured: true });
    const unreachable = (err: unknown) => {
      throw new HttpError(502, `team hub unreachable: ${err instanceof Error ? err.message : err}`, { configured: true });
    };
    const res = await http(`${opts.hubUrl}/hub/team?days=${days(c)}`, { headers: { authorization: `Bearer ${wb.token}` }, signal: AbortSignal.timeout(10_000) }).catch(unreachable);
    if (!res.ok) throw new HttpError(502, `team hub answered HTTP ${res.status}`, { configured: true });
    return c.json({ configured: true, ...(await res.json().catch(unreachable)) });
  });

  return routes;
}
