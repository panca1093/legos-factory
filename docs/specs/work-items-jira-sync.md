# Spec: Work items and Jira sync (phase A)

Status: approved · 2026-10-16 · builds on My repos (#4) and Git via workbench (#5)

## Why
Today a run remembers only ticket and repo. The factory does not know which branch or PR came out of a run; it finds a ticket's PRs by guessing (key in branch names/titles) and via Jira's Development field, which counts every PR that merely mentions the key. Jira status is moved by hand. Phase A gives the factory its own record — ticket → repos → PRs (spec / impl) → state — and from it moves the Jira status forward automatically. It works with today's manual runs. The stage engine (Design → gate → "Start build") is phase B and out of scope.

## Decisions (agreed)
1. A work item is one ticket plus the repos picked before the first run. A ticket often spans several repos. Repos come from My repos only.
2. One spec per repo: each repo goes through its own spec PR, then its own implementation PR.
3. The target repo owns the conventions (where specs live, how PR titles look). The agent reads the repo's own guidance first; the factory never hard-codes paths or title formats. The spec PR title carries no deployment tag.
4. Jira transitions are automatic, forward-only, compare-and-swap: before each transition read the current status; move only if it is exactly the expected "from" status; otherwise skip and record a note (e.g. someone moved it to ON HOLD).
5. Merging the implementation PR equals a UAT deploy (merge queue), so "all impl PRs merged" triggers Ready for QA.
6. Repos can be mapped to Jira projects in Settings; these are hints that pre-select repos when starting a work item.

## Status rules (per work item, over ALL its repos)
| Condition | Transition (from → to) |
|---|---|
| A run with this ticket starts in any repo | todo → inProgress |
| Every repo has an impl PR that is OPEN or MERGED | inProgress → codeReview |
| Every repo's impl PR is MERGED | codeReview → readyForQa |
- Chained steps in one sync: if every impl PR is already merged while status is still inProgress, apply codeReview then readyForQa, each step compare-and-swap.
- A DECLINED PR does not count; a repo whose only impl PR was declined holds the work item back. Spec PRs never count.
- Status names come from settings.json (`jiraFlow`), defaulting to "To Do", "In Progress", "Code Review", "Ready for QA".
- The transition id is looked up at the moment of each move with jira_get_transitions, matching the target status name.
- Never move backward; never touch QA, release, ON HOLD or Rejected.

## Data (factory.db)
```sql
create table if not exists work_items (
  owner text not null, ticket text not null, created_at text not null,
  primary key (owner, ticket));
create table if not exists work_item_repos (
  owner text not null, ticket text not null, repo_key text not null, name text not null,
  added_at text not null, primary key (owner, ticket, repo_key));
create table if not exists ticket_links (
  owner text not null, ticket text not null, repo_key text not null,
  kind text not null,             -- 'spec' | 'impl'
  pr_id integer not null, branch text not null, title text not null,
  state text not null,            -- OPEN | MERGED | DECLINED | SUPERSEDED
  source text not null,           -- 'factory' | 'manual'
  run_id text, commented integer not null default 0, updated_at text not null,
  primary key (owner, ticket, repo_key, pr_id));
create table if not exists work_item_events (
  owner text not null, ticket text not null, at text not null,
  type text not null,             -- 'transition' | 'skipped' | 'comment' | 'error'
  detail text not null);
create table if not exists repo_projects (
  owner text not null, repo_key text not null, project text not null,
  primary key (owner, repo_key, project));
```
server/work-items.ts: a WorkItems class in the style of ActivityLog/MyRepos. Rules live in the usecase file server/jira-sync.ts, not in SQL.

## Runs
- Run and StartRequest gain `stage: 'design' | 'build' | null`; the activity item stores it. A run with a ticket must have a stage (the launch dialog asks for it); a run without a ticket has stage null.
- Stage prompts: a design or build run's prompt gets a short generic preamble telling the agent to read the repo's own conventions first (CLAUDE.md, AGENTS.md, CONTRIBUTING, docs folder); for design, write the spec where the repo keeps specs and open a PR; for build, implement and open a PR; put the ticket key in both the branch name and the PR title, following the repo's title format.
- PR capture on run end, before the clone is deleted: read the clone's current branch; if it isn't the base branch, look for an OPEN PR with that source branch in that repo (one bitbucket_list_prs call); if found, store a ticket_links row with kind = run.stage and source = 'factory'.
- Launching a run with a ticket requires the repo to be part of that ticket's work item; otherwise 409 { needWorkItem: true }. The dialog adds the repo first.

## Jira sync (server/jira-sync.ts)
syncWorkItem(deps, owner, ticket):
1. Refresh each linked PR's state with bitbucket_get_pr.
2. For each new factory link with commented = 0, post one jira_add_comment line `<Spec|Implementation> PR for <repo>: <title> — <url>`, then set commented = 1 (no remote-link tool in workbench, so the comment is how the link reaches Jira).
3. Read the current status with jira_get_issue; apply the status rules with compare-and-swap.
4. Write every move, skip and error to work_item_events.
When it runs: right after a run with a ticket starts (In Progress move); right after PR capture at run end; on a "Sync now" button; every LEGOS_SYNC_MS (default 120 s) for work items not yet at readyForQa and only for owners with a connected workbench. At most one sync at a time per work item. Errors are recorded as events and never thrown into the run.

## API
- GET /api/work-items/:ticket → { ticket, repos, links, events, status } (status = last Jira status read).
- POST /api/work-items/:ticket { repos: string[] } → create the work item or add repos; every repo must be in My repos (403 needRepo otherwise).
- DELETE /api/work-items/:ticket/repos/:ws/:slug → remove a repo; 409 if that repo already has links.
- POST /api/work-items/:ticket/links { repo, prId, kind } → link an existing PR by hand (source 'manual'); checks the PR exists and its title or branch contains the key.
- DELETE /api/work-items/:ticket/links/:ws/:slug/:prId → unlink, manual links only.
- POST /api/work-items/:ticket/sync → sync now, returns the work item.
- GET/PUT /api/my-repos/:ws/:slug/projects → read/set Jira project keys mapped to a repo.
- GET /api/prs?ticket= unchanged as a fallback search; the UI marks these results "found by search" with a Link action.

## Web
- Jira tab "Work on this" opens a work-item dialog: my repos as checkboxes (repos mapped to the ticket's project pre-checked), a stage picker (Design / Build). On start: create/update the work item, then launch one run per selected repo (the existing run queue limits concurrency).
- Ticket modal gains a Work item panel: one row per repo with spec and impl PR chips (state-coloured, linking to the factory PR page); "Add repo", "Link PR", "Sync now"; last Jira status and recent events (e.g. "skipped: status was ON HOLD").
- Jira cards take PR chips from ticket_links when a work item exists; otherwise today's chips. Jira's Development field stays a secondary hint.
- Settings → Repositories: each repo gets an editable list of Jira project keys.

## Tests (fail before, pass after)
- Status rules (pure function): all table rows; chained inProgress → readyForQa; declined impl PR holds back; repo without impl PR holds back; spec PRs never count.
- Compare-and-swap: status differs from expected → no transition call + skipped event; transition id looked up by target name; missing transition → error event.
- Comments: each new factory link commented exactly once.
- PR capture: run ending on a feature branch with an OPEN PR stores a link of the run's stage kind; base branch or no PR stores nothing; capture happens before the clone is deleted.
- Launch: ticket run whose repo isn't in the work item → 409 needWorkItem; ticket run without stage → 400.
- Work-item API: owner isolation, My repos check, removal refused when links exist, manual-link validation.
- Periodic sync: skips items at/past readyForQa and owners without workbench; never runs twice at once for one item.
- All Jira/Bitbucket calls via a fake workbench; no network.
- npm test, npm run typecheck, npm run build all green.

## Out of scope (phase B or later)
Stage engine (spec-PR merge gate, "Start build" button, per-repo stage state); Jira remote links (no workbench tool); Jira write-back beyond the comment and transitions; team/hub views of work items.

## Resolved
- Sync interval: 120 s (LEGOS_SYNC_MS).
- Several repos picked: one click starts one run per repo; the run queue limits concurrency.
