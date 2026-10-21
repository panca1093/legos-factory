# Spec: Mission control redesign and the autopilot pipeline

Status: approved design · 2026-10-21 · builds on `main` (work items and Jira sync, My repos, git via workbench). Does not depend on any unmerged branch.

Design reference: `docs/design/mission-control/*.dc.html` (one file per screen; the markup, copy and tokens are the source of truth for look and wording, the data in them is made up). Read `0-flows.dc.html` first; it says "Home" where the app now says "Overview", and its Work item lanes per repo were replaced by the single Flow graph in `5-work-item`.

## Why

The app is organised by mechanism (Overview, Tasks, Sessions, a Jira tab inside Tasks). A ticket's progress is spread over the Jira tab, run pages and PR pages, and every agent step asks for permission. The redesign organises the app by what a person comes to do, and turns a ticket into a pipeline that runs on its own and stops for a person only at a few gates.

## Decisions (agreed)

1. **Navigation:** Overview · Work · Reviews · Activity · Settings, plus New chat / New task in the rail. Sessions, My activity and Team activity move into Activity. The Tasks page and its Jira tab are replaced by Work.
2. **Overview is the existing Overview, adjusted** (same layout, rail, Right now switch, Runs monitor with the inspect panel, Workspace usage). Heading is a greeting ("Good morning, <name>"). Quick actions are removed.
3. **Runs are for watching, Needs you is for acting.** Needs you and Reviews sit side by side under Runs, each one white panel of rows. Needs you groups by kind with a count, one row per kind, one button per row: Run paused · To review · To merge · Escalated · Brainstorm.
4. **New task with an optional ticket.** "Work on a ticket" is not a separate action: a task with a ticket attached becomes tracked work (repos pre-filled from the project → repo mapping, start with Spec or Brainstorm). Without a ticket it is a one-off task as today.
5. **Auto mode.** Runs never ask for permission. A command outside the workspace allowlist **pauses** the run and puts it in Needs you (Allow once · Add to allowlist · Stop). Edits and commits on the run's own branch are always allowed; pushing to another branch and deleting outside the clone always pause.
6. **People act only at gates:** brainstorm (optional), spec review (always), PR review (only when routed), merge (always a person, one click). The factory never merges.
7. **One spec and one task graph per ticket.** The repo is an attribute of a task, like the files it touches. Repos only separate at the end: one PR per repo, and review, routing and merge happen per PR. (Supersedes "one spec per repo" in `work-items-jira-sync.md`.)
8. **The plan is machine-readable.** The spec PR description carries a fenced `plan` block (format below). Spec review approves the task graph too. A missing or broken block means: run every task in order, one at a time.
9. **Personas:** Foreman (brainstorm, spec, plan), Builder (every build run, one model for all), Inspector (read-only review against the plan, a different model from the Builder), Cataloger (after merge, docs; can be off). Definitions live in `workflows/factory/personas/*.md`. Default model per persona in Settings, override per task.
10. **Parallel builds.** Tasks that need nothing from each other and touch different files may run as parallel Builder runs, each in its own worktree and branch; each takes a run slot. A Builder then merges the branches of a repo and runs the full suite before the PR opens. Off by default.
11. **Review loop.** After a build, the Inspector reviews. Changes requested → the same task builds again with the findings (not a new task), at most N times (default 3), then it escalates to a person.
12. **Routing after a passing review is decided by rules, not by the agent.** Workspace rules (changed paths, changed lines, Jira type or label, repo) send a PR to a person if any matches. The Inspector may add a reason and raise a PR to a person; it can never skip a matched rule. Unrouted PRs wait as Ready to merge.
13. **Work board columns are factory stages:** Backlog · Shaping · Spec review (gate) · Building · PR review (gate) · Ready to merge · Done. A ticket sits in the stage of its slowest repo. Backlog holds Jira tickets not started yet and tickets created here.
14. **Team view on the board is for workspace owners only.** Members see their own work.
15. **Opening a ticket shows the work, not Jira details**: stage stepper, the paused bar if any, the Flow (task graph), runs, what happened, cost. Jira is a small link.

## Screens

Each screen below lists purpose, content and where the data comes from. "Existing" means an endpoint on `main` today.

### Overview (`1-overview`, phone: `8-overview-phone`)
- Greeting + one-line lead ("1 run is paused for you, 5 things wait on your call").
- Right now switch: Needs you · Working · To merge, with counts.
- Runs monitor and inspect panel as today; cards show ticket, repo and stage; the inspect panel adds a Pipeline row. No action buttons in the inspect panel except "Open work item"; paused runs say "Waiting for you → Needs you".
- Workspace usage (collapsible, as today).
- Needs you (left) and Reviews (right) as described in decision 3. Recent sessions below, full width.
- Data: live runs and decisions (existing SSE), work items (existing `GET /api/work-items`), reviews (existing `GET /api/reviews`), plus pipeline state (new, see Data).

### Work (`2-work-board`)
- One board, columns from decision 13; gate columns are marked "You".
- Card: key, source badge (`Jira` / `Local`), title, one line per repo with its state, one "next" link. Backlog cards have Start, which opens New task with the ticket attached.
- Filters: text; backlog source (assigned to me · my projects · current sprint). Mine/Team switch only for owners.
- Data: `GET /api/jira/issues` (existing) for the backlog, `GET /api/work-items` (existing, extended with stage per repo).

### Work item (`5-work-item`)
- Header: key, title, Jira link, Brainstorm button.
- Stage stepper: Brainstorm · Spec (You) · Build + agent review · PR review (if routed) · Merge (You) · Ready for QA · Catalog, each with its persona.
- Paused bar when a run is paused (names the task and the command).
- Flow: the task graph in columns left to right (a column = tasks that may run together), each node = id, state, repo tag, title, "needs …", Builder; it ends in a Pull requests box (one row per repo: PR, which tasks, state). Legend: done · running · paused · next.
- Runs list (persona avatar, repo tag, model, time, est. cost), routing rules panel, What happened (actor per event), cost so far.

### Reviews (`3-reviews`)
- Tabs: Factory gates (spec reviews and routed PRs, master-detail with "why this came to you" and the Inspector's findings; Approve / Request changes) · Teammates (existing reviews; "Review with factory" drafts) · Comments on your PRs (factory PRs with new comments; tick and Ask factory, existing fix queue).

### Activity (`4-activity`)
- Mine: range, totals (runs, tickets shipped, gates passed, paused, est. cost with "—" for unpriced), day groups of runs with stage and outcome, Open / Continue. Absorbs Sessions and My activity.
- Team: existing team hub view, status only.

### New task (`6-new-task`)
- Chat | Task. Task: optional ticket (search, attach, remove); with a ticket: Start with Spec or Brainstorm first, repos pre-filled with their source shown, summary of what will run and where you will be asked; without a ticket: prompt and one repo. More options: model, base branch.

### Settings → Automation (`7-settings-automation`)
- Gates (brainstorm optional/always; spec review always on; review attempts; merge always a person).
- Personas (model per persona; Builder: run independent tasks in parallel, builders at once; Inspector must differ from Builder).
- Routing rules (toggle, edit, add; kinds: paths, changed lines, Jira type or label, repo).
- Allowlist (chips, add, remove; "paused runs asked for these lately" with Add).
- Owners edit, members read.

## Plan block (in the spec PR description)

````
```plan
- id: T1
  do: Retry with exponential backoff
  repo: acme/api
  test: payout/retry_test.go:TestRetryCap
  needs: []
  touches: [payout/retry.go]
- id: T3
  do: Banner renders retry state
  repo: acme/web
  test: web/RetryBanner.test.tsx
  needs: []
  touches: [web/RetryBanner.tsx]
```
````
- `id` unique; `repo` must be one of the work item's repos; `needs` refers to ids; no cycles.
- Two tasks may run together only if neither needs the other (transitively) and their `touches` do not overlap. `touches` is a hint; the full suite after merging is the real check.
- Parse failure → one task per repo, sequential, and a note on the work item.

## Data and endpoints (lean: each has a caller in the screens above)

- `settings.json` (existing `server/policy.ts`) gains: `allowlist: string[]` (command prefixes), `routing: Rule[]`, `personas: { foreman, builder, inspector, cataloger: { model } }`, `parallelBuilders: number` (0 = off), `reviewAttempts: number`. Prefer this file over new tables.
- `work_item_repos` gains `stage` (`shaping | spec_review | building | pr_review | ready | done`) and `attempt`.
- `work_items` gains `plan` (JSON of the parsed plan) and `source` (`jira | local`) so local tickets can exist.
- No new table for runs: add `task` and `persona` columns to the existing `runs` table.
- Endpoints: extend `GET /api/work-items` with stage, plan and per-task state; `POST /api/work-items/:ticket/approve-spec`; `POST /api/work-items/:ticket/prs/:repo/approve` and `.../merge`; `GET/PUT /api/settings/automation`. Reuse the decision endpoints for paused runs.
- `claude-runs.ts canUseTool`: check the allowlist first and allow; otherwise keep today's decision flow (this is the "pause").
- `launch-run.ts`: append the persona file to the system prompt per stage; pass the persona's model.

## Delivery: four PRs, in order

1. **Shell and screens on today's data.** Nav, Overview adjusted, Work board (backlog + work items, stages derived from existing links), Activity merge, New task with optional ticket, Reviews tabs Teammates and Comments. No engine. Done when every screen renders with real data and `npm test` + `npm run build` are green.
2. **Auto mode.** Allowlist check in `canUseTool`, paused runs in Needs you, Settings → Automation (gates, personas' models, allowlist, rules stored but not yet used). Tests: allowlisted command runs without a decision; others create a decision; Add to allowlist persists.
3. **Pipeline engine.** Plan parsing, stages per repo, persona per stage, Inspector loop with attempts, routing rules, Ready to merge, parallel builders behind the setting, Cataloger. Gates open on facts only (PR state, approvals). Tests per transition, including parse failure fallback and escalation after N attempts.
4. **Gates in Reviews and the Flow view.** Factory gates tab, approve/request changes, merge, the Work item Flow graph and Pull requests box.

## Parallel delivery (alternative to the four PRs in order)

The work can run as three parallel tracks once a small contract is merged. Each track owns its files; a track never edits files another track owns.

**Step 0, contract (one agent, merged before anything else):**
- `shared/types.ts`: `Stage` per repo, `PlanTask` and `Plan`, `AutomationSettings` (allowlist, routing rules, personas' models, parallelBuilders, reviewAttempts), `Run.task` and `Run.persona`, the extended `WorkItem` (source, plan, per-repo stage and attempt, per-task state).
- `server/db.ts`: the new columns from "Data and endpoints".
- Automation settings storage and endpoint (`server/policy.ts`, `server/routes/settings.ts`).
- API shapes, returning defaults where the behaviour does not exist yet: `GET /api/work-items` with the new fields, `GET/PUT /api/settings/automation`, `POST /api/work-items/:ticket/approve-spec`, `POST /api/work-items/:ticket/prs/:repo/approve` and `.../merge` (respond 501 until track C).
- Tests that pin those shapes. After step 0, `shared/types.ts` and `server/db.ts` change only by agreement.

**Tracks (in parallel, each on its own branch and worktree from the contract):**

| Track | Owns | Delivers |
|---|---|---|
| A · Front end | `web/**` | Every screen in this spec against the contract's API, including the Automation settings, Factory gates and Flow views |
| B · Auto mode | `server/claude-runs.ts`, `server/routes/runs.ts`, their tests (settings storage and endpoint are in step 0) | Allowlist check and pause, settings storage and endpoint |
| C · Pipeline | `server/pipeline.ts` (new), `server/launch-run.ts`, `server/work-items.ts`, `server/jira-sync.ts`, `server/routes/work-items.ts`, `server/routes/prs.ts`, their tests | Plan parsing, stages, personas and models, Inspector loop, routing, Ready to merge, parallel builders, approve and merge endpoints |

A track that needs a change in a file it does not own writes it down in its PR body instead of making it.

**Integration:** merge B, then C, then A, each rebased on the one before; run the full suite after each merge.

The work packages, worker rules and prompts for running this with an orchestrator and small worker agents are in `mission-control-orchestration.md`.

## Open questions (resolve before the PR that needs them)

- Merge from the app: `main` has no merge call and it is unverified whether workbench exposes a Bitbucket merge tool. If not, "Merge" opens the PR in the forge. (PR 3)
- Roles: `main` has no workspace roles. Team view and "owners edit" need a minimal owner flag. (PR 1 for Team view, PR 2 for settings)
- Local tickets: key format and where they come from (created in New task). (PR 1)
- Where the single spec lives when a ticket spans repos: the first repo in the work item, following its own conventions. (PR 3)

## Out of scope

Hosted multi-tenant, runner/control-plane split, OIDC, GitHub forge. Any of these can come later without changing the screens.
