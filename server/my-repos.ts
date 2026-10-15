import type { DatabaseSync } from 'node:sqlite';

export const MY_REPOS_CAP = 25;

export type MyRepo = { name: string; mainBranch: string | null; addedAt: string };

const keyOf = (repo: string) => repo.trim().toLowerCase();
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });

// The repos each user maintains; every repo-scoped action is limited to these.
export class MyRepos {
  constructor(private db: DatabaseSync) {}

  list(owner: string): MyRepo[] {
    return this.db
      .prepare(`select name, main_branch as mainBranch, added_at as addedAt from user_repos where owner = ? order by repo_key`)
      .all(owner) as MyRepo[];
  }

  has(owner: string, repo: string): boolean {
    return !!this.db.prepare(`select 1 from user_repos where owner = ? and repo_key = ?`).get(owner, keyOf(repo));
  }

  add(owner: string, row: Pick<MyRepo, 'name' | 'mainBranch'>): MyRepo {
    if (this.has(owner, row.name)) throw conflict(`${row.name} is already in your repos`);
    if (this.list(owner).length >= MY_REPOS_CAP) throw conflict(`you can keep at most ${MY_REPOS_CAP} repos`);
    const repo = { ...row, addedAt: new Date().toISOString() };
    this.db
      .prepare(`insert into user_repos (owner, repo_key, name, main_branch, added_at) values (?, ?, ?, ?, ?)`)
      .run(owner, keyOf(row.name), row.name, row.mainBranch, repo.addedAt);
    return repo;
  }

  remove(owner: string, repo: string) {
    this.db.prepare(`delete from user_repos where owner = ? and repo_key = ?`).run(owner, keyOf(repo));
  }
}
