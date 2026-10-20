import { Hono } from 'hono';
import { z } from 'zod';
import { parseRepo } from '../workspace.ts';
import { HttpError, domain, parse, readBody, requireMyRepo, requireWorkbench, text, upstream, type Deps, type Env, type WorkbenchClient } from '../http.ts';

const projectsSchema = z.object({
  projects: z
    .custom<string[]>((p) => Array.isArray(p) && p.length <= 20 && p.every((k) => typeof k === 'string'), 'projects must list at most 20 Jira project keys')
    .transform((p) => p.map((k) => k.trim().toUpperCase()))
    .refine((p) => p.every((k) => /^[A-Z][A-Z0-9]{1,9}$/.test(k)), 'project keys look like PROJ'),
});
const addSchema = z.object({ repo: text().refine((r) => !!parseRepo(r), 'repo must look like workspace/repo') });

export function myReposRoutes(deps: Deps) {
  const { myRepos } = deps;
  const routes = new Hono<Env>();

  routes.get('/api/my-repos', (c) => c.json({ repos: myRepos.list(c.get('ws')) }));

  routes.post('/api/my-repos', async (c) => {
    const ws = c.get('ws');
    const { repo } = parse(addSchema, await readBody(c));
    const wb = await requireWorkbench(deps, ws);
    return c.json(await domain(addRepo(deps, ws, wb, repo)), 201);
  });

  routes.patch('/api/my-repos/:ws/:slug', async (c) => {
    const ws = c.get('ws');
    const repo = `${c.req.param('ws')}/${c.req.param('slug')}`;
    requireMyRepo(deps, ws, repo);
    const { projects } = parse(projectsSchema, await readBody(c));
    myRepos.setProjects(ws, repo, projects);
    return c.json(myRepos.get(ws, repo));
  });

  routes.delete('/api/my-repos/:ws/:slug', (c) => {
    myRepos.remove(c.get('ws'), `${c.req.param('ws')}/${c.req.param('slug')}`);
    return c.body(null, 204);
  });

  return routes;
}

// Only repos that exist in their workspace, under the forge's spelling and with its main branch.
async function addRepo(deps: Deps, ws: string, wb: WorkbenchClient, repo: string) {
  const found = (await upstream(deps.workspaceRepos(ws, wb, parseRepo(repo)!.workspace))).find((r) => r.name.toLowerCase() === repo.toLowerCase());
  if (!found) throw new HttpError(404, `${repo} not found in Bitbucket`);
  return deps.myRepos.add(ws, { name: found.name, mainBranch: found.mainBranch });
}
