# Spec: My repos

Status: approved

## Why
Today the factory treats every Bitbucket repo in the workspace as fair game: the repo picker loads the full workspace list (1144 repos, ~8 s, cached 1 h) on every dialog/Jira visit; Reviews guesses where to look (browser-remembered repos + repos from runs + the workspace's 15 most recently updated repos); ticket → PR search uses repos from runs + `localStorage` (`lf:repos`), so results differ per browser. Each user declares the repos they actively maintain; the factory works only on those.

## Decisions
1. Strict: every repo-scoped action is rejected unless the repo is in the user's list.
2. Review requests in repos outside the list are not shown (accepted).
3. The user curates the list fully by hand — no auto-fill or suggestions from history.
4. Bitbucket access stays via workbench; git clone stays SSH. Unchanged.
5. Cap 25 repos per user. Removing a repo keeps its history (runs/sessions/activity still shown); in-flight runs and fix queues keep going.

## Data
New table in factory.db (server/db.ts):
```sql
create table if not exists user_repos (
  owner text not null,
  repo_key text not null,        -- lowercase "workspace/slug", for matching
  name text not null,            -- forge spelling, e.g. "Acme/api"
  main_branch text,
  added_at text not null,
  primary key (owner, repo_key));
```
`server/my-repos.ts`: small `MyRepos` class (style of ActivityLog) with list(owner), has(owner, repo), add(owner, row), remove(owner, repo). Add it to Deps. Rules (cap, duplicate) in the class/routes, not SQL.

## API
- `GET /api/my-repos` (new) → `{ repos: [{ name, mainBranch, addedAt }] }` ordered by name.
- `POST /api/my-repos` `{ repo }` (new): server looks it up in the workspace list (existing `workspaceRepos` cache) to confirm it exists and take `mainBranch`. 404 not found, 409 already added (case-insensitive), 409 cap reached, 201 on success.
- `DELETE /api/my-repos/:ws/:slug` (new) → 204.
- `GET /api/repos`: unchanged; now only used by the Settings "Add repository" search.
- `POST /api/runs` with `repo`: `403 { error: 'repo is not in your repos', needRepo: true }` if not listed. Same check when continuing a run in a managed workspace whose repo was since removed. Local-folder runs unaffected.
- `GET /api/prs/:ws/:slug/:id` and its `/diff`, `/comments`, `/fixes` routes: 403 needRepo if not listed. (`/api/fixes/:id/...` routes act on an existing queue the user owns — leave them unchecked.)
- `GET /api/prs?ticket=`: searches only my repos; `repos` query param removed; run-history repos not in the list ignored.
- `GET /api/reviews`: scans only my repos; `repos` param, the "most active repos" heuristic and `REVIEW_REPOS` removed; workspace for the Bitbucket user lookup comes from the first listed repo (replaces the `workspace` param). Empty list → `409 { needRepos: true }`.
- One helper `requireMyRepo(deps, uid, repo)` used by routes and launchRun.

## Web
- Settings → new "Repositories" section: list with remove per repo; "Add repository" opens the existing searchable picker (RepoPicker logic) over the full workspace list; the workspace field moves here (still remembered as `lf:bb-ws`); shows "n / 25".
- New task dialog: repo field becomes a plain dropdown of my repos; default branch from mainBranch; empty list → "No repos yet — add them in Settings" with a link.
- Jira tab: remove the per-row "pick a repo to find the PR" picker (PR lookup uses my repos); remove the background `api.repos()` warm-up.
- Reviews: remove the workspace field (keep the Bitbucket name field); empty list → "Add the repos you review in Settings" with a link.
- PR page: a needRepo error shows "This repo isn't in your repos" with an "Add to my repos" button (explicit user action).
- Remove `recentRepos`, `rememberRepo` and the `lf:repos` key.

## Tests (fail before, pass after)
- MyRepos: add/list/remove, owner isolation, case-insensitive duplicate → 409, cap → 409.
- POST /api/my-repos: unknown repo → 404; mainBranch taken from the workspace list.
- POST /api/runs with an unlisted repo → 403 needRepo; continuing a run whose repo was removed → 403.
- PR detail for an unlisted repo → 403.
- /api/prs?ticket= only calls the forge for listed repos.
- /api/reviews only scans listed repos; empty list → 409 needRepos.

## Open questions
Resolved: cap 25; removing a repo keeps its history.

## Out of scope
Jira project ↔ repo mapping; git mirror cache; workbench clone URL / moving off SSH; team/hub-shared repo lists.
