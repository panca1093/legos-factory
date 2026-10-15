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

  routes.get('/api/my-repos', (c) => c.json({ repos: myRepos.list(c.get('uid')) }));

  routes.post('/api/my-repos', async (c) => {
    const uid = c.get('uid');
    const { repo } = parse(addSchema, await readBody(c));
    const wb = await requireWorkbench(deps, uid);
    return c.json(await domain(addRepo(deps, uid, wb, repo)), 201);
  });

  routes.get('/api/my-repos/:ws/:slug/projects', (c) => {
    const repo = `${c.req.param('ws')}/${c.req.param('slug')}`;
    requireMyRepo(deps, c.get('uid'), repo);
    return c.json({ projects: myRepos.projects(c.get('uid'), repo) });
  });

  routes.put('/api/my-repos/:ws/:slug/projects', async (c) => {
    const repo = `${c.req.param('ws')}/${c.req.param('slug')}`;
    requireMyRepo(deps, c.get('uid'), repo);
    const { projects } = parse(projectsSchema, await readBody(c));
    myRepos.setProjects(c.get('uid'), repo, projects);
    return c.json({ projects: myRepos.projects(c.get('uid'), repo) });
  });

  routes.delete('/api/my-repos/:ws/:slug', (c) => {
    myRepos.remove(c.get('uid'), `${c.req.param('ws')}/${c.req.param('slug')}`);
    return c.body(null, 204);
  });

  return routes;
}

// Only repos that exist in their workspace, under the forge's spelling and with its main branch.
async function addRepo(deps: Deps, uid: string, wb: WorkbenchClient, repo: string) {
  const found = (await upstream(deps.workspaceRepos(uid, wb, parseRepo(repo)!.workspace))).find((r) => r.name.toLowerCase() === repo.toLowerCase());
  if (!found) throw new HttpError(404, `${repo} not found in Bitbucket`);
  return deps.myRepos.add(uid, { name: found.name, mainBranch: found.mainBranch });
}
