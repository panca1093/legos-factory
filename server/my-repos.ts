import type { DatabaseSync } from 'node:sqlite';

export const MY_REPOS_CAP = 25;

// projects: Jira project keys mapped to the repo, which pre-select it for their tickets
export type MyRepo = { name: string; mainBranch: string | null; addedAt: string; projects: string[] };

const keyOf = (repo: string) => repo.trim().toLowerCase();
const splitKeys = (s: string) => s.split(',').filter(Boolean);
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });

// The repos each workspace maintains; every repo-scoped action is limited to these.
export class MyRepos {
  constructor(private db: DatabaseSync) {}

  list(workspaceId: string): MyRepo[] {
    const rows = this.db
      .prepare(`select name, main_branch as mainBranch, added_at as addedAt, jira_projects as projects from workspace_repos where workspace_id = ? order by repo_key`)
      .all(workspaceId) as (Omit<MyRepo, 'projects'> & { projects: string })[];
    return rows.map((r) => ({ ...r, projects: splitKeys(r.projects) }));
  }

  get(workspaceId: string, repo: string): MyRepo | null {
    return this.list(workspaceId).find((r) => keyOf(r.name) === keyOf(repo)) ?? null;
  }

  setProjects(workspaceId: string, repo: string, projects: string[]) {
    this.db.prepare(`update workspace_repos set jira_projects = ? where workspace_id = ? and repo_key = ?`).run([...new Set(projects)].sort().join(','), workspaceId, keyOf(repo));
  }

  has(workspaceId: string, repo: string): boolean {
    return !!this.db.prepare(`select 1 from workspace_repos where workspace_id = ? and repo_key = ?`).get(workspaceId, keyOf(repo));
  }

  add(workspaceId: string, row: Pick<MyRepo, 'name' | 'mainBranch'>): MyRepo {
    if (this.has(workspaceId, row.name)) throw conflict(`${row.name} is already in your repos`);
    if (this.list(workspaceId).length >= MY_REPOS_CAP) throw conflict(`you can keep at most ${MY_REPOS_CAP} repos`);
    const repo = { ...row, addedAt: new Date().toISOString(), projects: [] };
    this.db
      .prepare(`insert into workspace_repos (workspace_id, repo_key, name, main_branch, added_at) values (?, ?, ?, ?, ?)`)
      .run(workspaceId, keyOf(row.name), row.name, row.mainBranch, repo.addedAt);
    return repo;
  }

  remove(workspaceId: string, repo: string) {
    this.db.prepare(`delete from workspace_repos where workspace_id = ? and repo_key = ?`).run(workspaceId, keyOf(repo));
  }
}
