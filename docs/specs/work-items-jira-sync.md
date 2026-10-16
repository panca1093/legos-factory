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
  status text,                    -- Jira status last read
  done integer not null default 0, -- Ready for QA reached or every impl PR merged: no periodic sync
  note text, note_at text,        -- latest skip or error; transitions live in Jira's history
  primary key (owner, ticket));
create table if not exists work_item_repos (
  owner text not null, ticket text not null, repo_key text not null, name text not null,
  added_at text not null, primary key (owner, ticket, repo_key));
create table if not exists ticket_links (
  owner text not null, ticket text not null, repo_key text not null,
  kind text not null,             -- 'spec' | 'impl'
  pr_id integer not null, branch text not null, title text not null,
  state text not null,            -- OPEN | MERGED | DECLINED | SUPERSEDED
  run_id text, commented integer not null default 0, updated_at text not null,
  primary key (owner, ticket, repo_key, pr_id));
-- plus user_repos.jira_projects: comma-separated Jira project keys mapped to that repo
```
server/work-items.ts: a WorkItems class in the style of ActivityLog/MyRepos. Rules live in the usecase file server/jira-sync.ts, not in SQL.

## Runs
- Run and StartRequest gain `stage: 'design' | 'build' | null`; the activity item stores it. A run started from a work item must have a stage (the work-item dialog asks for it); a run without a ticket has stage null.
- Stage prompts: a design or build run's prompt gets a short generic preamble telling the agent to read the repo's own conventions first (CLAUDE.md, AGENTS.md, CONTRIBUTING, docs folder); for design, write the spec where the repo keeps specs and open a PR; for build, implement and open a PR; put the ticket key in both the branch name and the PR title, following the repo's title format.
- PR capture on run end, before the clone is deleted: read the clone's current branch; if it isn't the base branch, look for an OPEN PR with that source branch in that repo (one bitbucket_list_prs call); if found, store a ticket_links row with kind = run.stage.
- Launching a run with a ticket requires the repo to be part of that ticket's work item; otherwise 409 { needWorkItem: true }. The dialog adds the repo first.

## Jira sync (server/jira-sync.ts)
syncWorkItem(deps, owner, ticket):
1. Refresh each linked PR's state with bitbucket_get_pr.
2. Every link is factory-made. For each link with commented = 0, post one jira_add_comment line `<Spec|Implementation> PR for <repo>: <title> — <url>`, then set commented = 1 before the call, so a failed comment is never retried: at most once (no remote-link tool in workbench, so the comment is how the link reaches Jira).
3. Read the current status with jira_get_issue; apply the status rules with compare-and-swap.
4. Keep the latest skip or error in work_items.note (an error outranks a skip). A clean sync clears it. A PR capture failure (`Error: PR capture failed in <repo>: ...`) outranks every skip and error and is never overwritten by a sync, including one already running when it was written (the note is re-read right before the write); only a new factory link for that same repo clears it.
5. Polling stop: `done` becomes true only when the Jira status is Ready for QA (`jiraFlow.readyForQa`) or every repo of the work item has a MERGED impl PR. Any other status (ON HOLD, QA, Done, Rejected, unknown names) keeps polling; a null status keeps the previous value. On-demand syncs run regardless of `done`.
When it runs: right after a run with a ticket starts (In Progress move); right after PR capture at run end; every LEGOS_SYNC_MS (default 120 s) for work items with `done = 0` and only for owners with a connected workbench. At most one sync at a time per work item. Errors are noted on the work item and never thrown into the run.

## API
- GET /api/work-items → { items: WorkItem[] }, each { ticket, repos, links, note, status } (status = last Jira status read), for the caller only. The only read: the ticket modal and the Jira cards both use it and pick their item by ticket.
- PUT /api/work-items/:ticket { repos: string[] } → set the work item's repo list (creates the item if missing) and return it. Every repo must be in My repos (403 needRepo otherwise). Dropping a repo that already has links → 409. Keeping or adding is idempotent. An empty list on a missing item → 400.
- PATCH /api/my-repos/:ws/:slug { projects: string[] } → set the Jira project keys mapped to a repo (uppercased, deduped, sorted, at most 20; 400 on a bad key, 403 if the repo is not in My repos) and return the MyRepo. GET /api/my-repos already includes `projects`.
- GET /api/prs?ticket= is unchanged: a search by key, used only to display PR chips ("found by search"). PRs are never linked by hand; every link comes from a factory run.

## Web
- The Jira page refreshes the work-items list every 30 s while visible and on window focus.
- Jira tab "Work on this" opens a work-item dialog: my repos as checkboxes (repos mapped to the ticket's project pre-checked), a stage picker (Design / Build). On start: create/update the work item, then launch one run per selected repo (the existing run queue limits concurrency).
- Ticket modal gains a Work item panel: one row per repo with spec and impl PR chips (state-coloured, linking to the factory PR page); "Add repo" and "remove" (a repo without PRs); last Jira status and the latest note (e.g. "Skipped In Progress → Code Review: status was ON HOLD"). No Link PR or Sync now: sync runs by itself.
- The dialog and the modal both write with the single PUT, sending the full desired repo list, then refresh GET /api/work-items.
- Jira cards take PR chips from GET /api/work-items when a work item exists; otherwise today's chips. Jira's Development field stays a secondary hint.
- Settings → Repositories: each repo gets an editable list of Jira project keys.

## Tests (fail before, pass after)
- Status rules (pure function): all table rows; chained inProgress → readyForQa; declined impl PR holds back; repo without impl PR holds back; spec PRs never count.
- Compare-and-swap: status differs from expected → no transition call + skip note; transition id looked up by target name; missing transition → error note.
- Comments: each new factory link commented at most once (a failed comment is not retried).
- Notes: a capture failure survives skips, errors and a sync running while it is written; a link in repo B does not clear repo A's failure, a link in A does.
- PR capture: run ending on a feature branch with an OPEN PR stores a link of the run's stage kind; base branch or no PR stores nothing; capture happens before the clone is deleted.
- Launch: ticket run whose repo isn't in the work item → 409 needWorkItem; ticket run without stage → 400.
- Work-item API: PUT sets the list (owner isolation, My repos check, 400 on an empty list for a new item, 409 when dropping a repo that has links, idempotent); PATCH my-repos projects (normalisation, 400, 403).
- DB upgrade: an old ticket_links with a `source` column loses it and keeps its rows.
- Periodic sync: skips done items and owners without workbench; ON HOLD, or Done with an open impl PR, keeps polling; all impl PRs merged or Ready for QA stops; never runs twice at once for one item.
- All Jira/Bitbucket calls via a fake workbench; no network.
- npm test, npm run typecheck, npm run build all green.

## Out of scope (phase B or later)
Stage engine (spec-PR merge gate, "Start build" button, per-repo stage state); Jira remote links (no workbench tool); Jira write-back beyond the comment and transitions; team/hub views of work items.

## Resolved
- Sync interval: 120 s (LEGOS_SYNC_MS).
- Several repos picked: one click starts one run per repo; the run queue limits concurrency.
