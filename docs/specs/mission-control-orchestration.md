# Orchestration: building the mission control redesign with parallel agents

How to run `mission-control-redesign.md` with one orchestrator and many small worker agents. Written for models that need explicit instructions: every work package names its files, its tests and the exact commands that prove it.

## Roles

- **Orchestrator** (one session, runs the whole time). Plans waves, starts workers, verifies every result with commands, merges into the integration branch, stops for the human at milestones. Never writes product code.
- **Worker** (one session per work package, short-lived). Does exactly one work package in its own git worktree and branch, then reports.
- **Human.** Answers stop-questions, reviews and merges milestone PRs into `main`.

## Branches

- `mc/integration` is cut from `main` once. Every work package branches from the current `mc/integration` as `mc/wp-XX`, in its own worktree: `git worktree add ../lf-wp-XX -b mc/wp-XX mc/integration`.
- The orchestrator merges a verified `mc/wp-XX` into `mc/integration` with `git merge --no-ff`. Nothing merges into `main` without the human.

## Work packages

Columns: id · depends on · files the worker may change (nothing else) · what to build · tests that must exist and pass.

### Milestone M0: contract (all four may run in parallel; their files do not overlap)

**WP-01 Types** · none · `shared/types.ts`
- Add `PipelineStage = 'backlog' | 'shaping' | 'spec_review' | 'building' | 'pr_review' | 'ready' | 'done'`.
- Add `PlanTask = { id: string; do: string; repo: string; test: string; needs: string[]; touches: string[]; state: 'waiting' | 'running' | 'paused' | 'done' | 'failed' }` and `Plan = { tasks: PlanTask[]; error: string | null }`.
- Add `Persona = 'foreman' | 'builder' | 'inspector' | 'cataloger'` and `RoutingRule = { id: string; kind: 'paths' | 'lines' | 'jira' | 'repo'; value: string; on: boolean }`.
- Add `AutomationSettings = { allowlist: string[]; routing: RoutingRule[]; models: Record<Persona, string>; parallelBuilders: number; reviewAttempts: number; brainstorm: 'optional' | 'always' }`.
- Extend `Run` with `task: string | null; persona: Persona | null`. Extend `WorkItem` with `source: 'jira' | 'local'; plan: Plan | null` and each repo with `stage: PipelineStage; attempt: number`.
- Tests: none new; `npm run typecheck` must pass after fixing every place the new required fields break (set them to `null`, `'jira'`, `'building'`, `0` where code builds these objects). You may touch the files that fail typecheck only to add those default values.

**WP-02 Database columns** · none · `server/db.ts`, `test/db-columns.test.ts` (new)
- Using the existing "tables made before these columns existed" pattern in `server/db.ts`, add: `work_items.source text not null default 'jira'`, `work_items.plan text`, `work_item_repos.stage text not null default 'building'`, `work_item_repos.attempt integer not null default 0`, `runs.task text`, `runs.persona text`.
- Tests: `adds the new columns to a fresh database`, `adds the new columns to a database created before them` (create the old schema by hand, then open it).

**WP-03 Automation settings** · WP-01 · `server/policy.ts`, `server/routes/settings.ts` (new), `server/app.ts` (one `app.route` line), `test/automation-settings.test.ts` (new)
- `loadSettings()` also returns `automation: AutomationSettings`, with these defaults when missing or invalid: allowlist `['npm test', 'npm run build', 'npm run lint', 'go test', 'go vet']`, routing `[]`, models `{ foreman: 'opus', builder: 'sonnet', inspector: 'opus', cataloger: 'haiku' }`, parallelBuilders `0`, reviewAttempts `3`, brainstorm `'optional'`.
- `saveAutomation(a)` writes only the `automation` key of `settings.json`, keeping every other key.
- Routes: `GET /api/settings/automation` → `AutomationSettings`; `PUT /api/settings/automation` validates with zod (allowlist entries non-empty, reviewAttempts 1–5, parallelBuilders 0–4, inspector model must differ from builder model → 400 with a clear message) and saves.
- Tests: `returns defaults when settings.json has no automation key`, `keeps other keys when saving`, `rejects an inspector model equal to the builder model`, `rejects reviewAttempts outside 1–5`.

**WP-04 Work item API shape** · WP-01, WP-02 · `server/work-items.ts`, `server/routes/work-items.ts`, `test/work-items-shape.test.ts` (new)
- `GET /api/work-items` returns `source`, `plan` (parsed JSON or null) and per repo `stage` and `attempt` from the new columns.
- Add `POST /api/work-items/:ticket/approve-spec`, `POST /api/work-items/:ticket/prs/:repo/approve` and `POST /api/work-items/:ticket/prs/:repo/merge`, each answering `501 {"error":"not implemented yet"}`.
- Tests: `returns the new fields with defaults`, `the three new endpoints answer 501`.

**Milestone check M0:** all four merged into `mc/integration`; `npm test`, `npm run typecheck`, `npm run build` green. Orchestrator pushes `mc/integration`, opens PR "feat: mission control contract (M0)" to `main`, and **stops for the human**.

### Milestone M1: tracks in parallel (after M0 is on `main` and `mc/integration` is rebased on it)

Track B, auto mode:

**WP-10 Allowlist and pause** · M0 · `server/claude-runs.ts`, `test/automode.test.ts` (new)
- In `canUseTool`: for the Bash tool, if the command starts with any allowlist entry (after trimming), resolve allow without creating a decision. Edit, Write and NotebookEdit inside the run's cwd: allow. Everything else: today's decision flow, with `reason` set to `outside the allowlist` for Bash.
- Read the allowlist from `loadSettings().automation` when the run starts.
- Tests: `runs an allowlisted command without a decision`, `pauses on a command outside the allowlist`, `allows edits inside the clone`, `pauses on an edit outside the clone`.

**WP-11 Add to allowlist from a paused run** · WP-10 · `server/routes/runs.ts`, `test/automode.test.ts`
- The decision answer accepts `remember: true` for a Bash decision; the command's first two words are appended to the allowlist with `saveAutomation`, then the decision is allowed.
- Tests: `remember adds the command prefix to the allowlist`, `remember is ignored for non-Bash decisions`.

Track A, front end. **WP-20 runs first; WP-21 to WP-27 run in parallel after it.** New styles go in a CSS file next to the page (`web/pages/Work.css`, imported by `Work.tsx`); only WP-20 edits `web/styles.css`. Match `docs/design/mission-control/<n>-*.dc.html` for layout, copy and classes.

**WP-20 Shell and API client** · M0 · `web/App.tsx`, `web/chrome.tsx`, `web/api.ts`, `web/styles.css`
- Rail: New chat / New task, then Overview · Work · Reviews · Activity · Settings, then Chats. Routes: `#/` Overview, `#/work`, `#/work/:ticket`, `#/reviews`, `#/activity`, `#/settings`; old `#/tasks` and `#/sessions` redirect to `#/work` and `#/activity` (keep `#/sessions/:id` and `#/runs/:id`).
- `api.ts`: add `automation()`, `saveAutomation(a)`, `approveSpec(ticket)`, `approvePr(ticket, repo)`, `mergePr(ticket, repo)`, and `answer(id, answer, remember?)` if the decision call lacks `remember`.
- Pages that do not exist yet render a placeholder heading only; WP-21 to WP-27 replace them.
- Check: `npm run build`; open each route with the dev server and see no console errors.

**WP-21 Overview** · WP-20 · `web/pages/Overview.tsx`, `web/pages/Overview.css` · design `1-overview`
- Greeting heading, Right now switch (Needs you · Working · To merge), Runs monitor as today with stage on cards and no action buttons in the inspect panel, Workspace usage, Needs you panel grouped by kind (rows: Run paused, To review, To merge, Escalated, Brainstorm; hide a row whose count is 0), Reviews panel next to it, Recent sessions below. Remove Quick actions.
- Needs you counts come from live decisions and `api.workItems()` stages; Reviews from `api.reviews()`.

**WP-22 Work board** · WP-20 · `web/pages/Work.tsx` (new), `web/pages/Work.css`, `web/pages/Jira.tsx`, `web/pages/Tasks.tsx` (delete when unused) · design `2-work-board`
- Columns Backlog · Shaping · Spec review · Building · PR review · Ready to merge · Done. Backlog = `api.jiraIssues(filter)` minus tickets that already have a work item. Other columns = work items by the slowest repo's `stage`. Gate columns show a "You" tag. Start on a backlog card opens New task with the ticket attached.
- Mine/Team switch is shown only when `me.isOwner` is true; until an owner flag exists, hide it.

**WP-23 Work item page** · WP-20 · `web/pages/WorkItem.tsx` (new), `web/pages/WorkItem.css` · design `5-work-item`
- Header, stage stepper with personas, paused bar (answers through the existing decision call), Flow graph from `plan.tasks` (columns by dependency depth, node = id, state, repo tag, title, needs, Builder), Pull requests box per repo, runs list, What happened, cost.
- If `plan` is null, show one node per repo.

**WP-24 Activity** · WP-20 · `web/pages/Activity.tsx`, `web/pages/Sessions.tsx`, `web/pages/Activity.css` · design `4-activity`
- Tabs Mine and Team. Mine = today's My activity plus the session list (search, open, continue). Team = today's Team activity.

**WP-25 New task dialog** · WP-20 · `web/components.tsx` (only `LaunchDialog` and helpers it alone uses) · design `6-new-task`
- Chat | Task. Task has an optional ticket; with a ticket: Start with Spec or Brainstorm, repos pre-filled from the project → repo mapping, summary of what will run; without: prompt and one repo. More options: model, base branch.

**WP-26 Reviews** · WP-20 · `web/pages/Reviews.tsx`, `web/pages/Reviews.css` · design `3-reviews`
- Tabs Factory gates (work items in `spec_review` or `pr_review`; master-detail; Approve calls `approveSpec`/`approvePr`, show the server's error text on 501), Teammates (today's list), Comments on your PRs (factory PRs with comments; Ask factory uses the existing fix queue).

**WP-27 Settings → Automation** · WP-20 · `web/pages/Settings.tsx`, `web/pages/Settings.css` · design `7-settings-automation`
- New Automation section: gates, personas' models (show the server's 400 message when inspector equals builder), parallel builders, routing rules (toggle, add, remove), allowlist (chips, add, remove). Loads with `api.automation()`, saves with `api.saveAutomation()`.

Track C, pipeline. WP-30, WP-31, WP-32 and WP-34 may run in parallel; the rest follow their dependencies.

**WP-30 Plan parser** · M0 · `server/plan.ts` (new), `test/plan.test.ts` (new)
- `parsePlan(prDescription: string, repos: string[]): Plan` reads the fenced `plan` block (YAML subset in the spec; write a small parser, no new dependency unless `npm ls` shows one already).
- `waves(plan): string[][]` groups task ids into columns by dependency depth; `canRunTogether(a, b)` per the spec rule.
- Errors (no block, bad YAML, unknown repo, unknown id in needs, cycle) → `{ tasks: one task per repo in order, error: '<reason>' }`.
- Tests: one per error case, `groups independent tasks into one wave`, `keeps tasks with overlapping touches apart`.

**WP-31 Stage machine** · M0 · `server/pipeline.ts` (new), `test/pipeline.test.ts` (new)
- Pure function `next(state, facts): Action[]` with no I/O. State: per repo stage and attempt, plan task states. Facts: spec approved, run ended (task, persona, ok, verdict), PR opened/merged/declined, rule matched, attempts limit. Actions: start run (task, persona, repo), set stage, escalate, mark ready.
- Tests: a table with one row per transition in the spec's Decisions 6, 8, 10, 11 and 12, plus `escalates after reviewAttempts failed reviews` and `a review finding re-runs the same task`.

**WP-32 Persona and model per run** · M0 · `server/launch-run.ts`, `test/launch-persona.test.ts` (new)
- When a run has a persona, append the text of `workflows/factory/personas/<persona>.md` to its prompt after the stage guide, and use `automation.models[persona]` unless the request names a model. Store `task` and `persona` on the run.
- Tests: `adds the builder persona to a build run`, `uses the persona model when none is given`, `keeps an explicit model`.

**WP-33 Pipeline wiring** · WP-30, WP-31, WP-32, WP-10 · `server/pipeline.ts`, `server/jira-sync.ts`, `server/work-items.ts`, `test/pipeline-wiring.test.ts` (new)
- On spec approval, run end and each sync tick, build facts, call `next`, execute the actions (start runs through `launchRun`, Inspector runs read-only, write stages and attempts). One run per task at a time; respect the run queue.
- Tests with fakes: `approving the spec starts the first wave`, `a passing review with no matching rule marks the repo ready`, `a failing review starts the same task again`.

**WP-34 Routing rules** · M0 · `server/routing.ts` (new), `test/routing.test.ts` (new)
- `route(pr: { files: string[]; changedLines: number; repo: string; jiraType: string | null; labels: string[] }, rules: RoutingRule[], inspectorReasons: string[]): { toPerson: boolean; reasons: string[] }`. Glob match for paths (no new dependency).
- Tests: one per rule kind, `the inspector can add a reason`, `an empty rule list sends nothing to a person`.

**WP-35 Gate endpoints** · WP-33, WP-34 · `server/routes/work-items.ts`, `server/routes/prs.ts`, `test/gates.test.ts` (new)
- Replace the 501s: approve-spec feeds the pipeline; approve PR marks it ready; merge calls a workbench merge tool if `tools/list` exposes one, otherwise answers `409 {"error":"merge in the forge", "url": <pr url>}`.
- Tests: `approve-spec starts the build wave`, `merge without a forge tool answers 409 with the PR url`.

**WP-36 Parallel builders** · WP-33 · `server/pipeline.ts`, `server/workspace.ts`, `test/parallel-builders.test.ts` (new)
- When `parallelBuilders > 0`, start up to that many tasks of the same wave at once, each in a worktree of the repo clone on its own branch; when the wave's tasks for a repo are done, a Builder run merges the branches and runs the full suite before the PR.
- Tests: `runs two independent tasks at once`, `never runs tasks with overlapping touches together`, `stays sequential when parallelBuilders is 0`.

**WP-37 Cataloger** · WP-33 · `server/pipeline.ts`, `test/pipeline.test.ts`
- After a repo's PR merges and the Cataloger model is not `off`, start one Cataloger run on that repo.
- Tests: `starts the cataloger after merge`, `skips it when off`.

**Milestone checks:** M1-B after WP-10, WP-11; M1-A after WP-20 to WP-27; M1-C after WP-30 to WP-37. At each, the orchestrator pushes `mc/integration`, opens or updates one PR per milestone to `main`, and **stops for the human**. Merge order into `main`: M0, M1-B, M1-C, M1-A.

## Rules every worker follows (paste into every worker prompt)

1. Read `CLAUDE.md`, `docs/specs/mission-control-redesign.md` and your work package. Read every file you will change before changing it.
2. Change only the files your work package lists. If you need another file, stop and report `BLOCKED: needs <file> because <reason>`.
3. Write the listed tests first, run them and see them fail, then write the code until they pass.
4. Run, in this order, and paste the last 20 lines of each output in your report: `npm test`, `npm run typecheck`, `npm run build`. Do not report success if any of them fails.
5. No comments that restate code; one-line comments only for a non-obvious reason. No new dependencies. No changes to formatting of code you did not change.
6. Never touch `~/.legos-factory`. To run the app: `LEGOS_DB=/tmp/lf-wp-XX.db LEGOS_AUTH=off npm run dev`.
7. Commit with the repository's configured git identity. Small commits, one concern each, message `feat(<area>): <what>`. Never add `Co-Authored-By`, "Generated with" or any tool attribution.
8. Never use real company names, hostnames, ticket keys or e-mails. Use `acme`, `example.com`, `PROJ-123`.
9. If something in the spec is unclear or contradicts the code, stop and report `QUESTION: <one precise question>` instead of guessing.

## Worker prompt (the orchestrator fills the angle brackets)

```text
You are a worker on the legos-factory repo. You do exactly one work package and then report.

Work package: <WP id and title>
Your worktree: <path>   Your branch: <mc/wp-XX>   Base: mc/integration

<paste the full work package text from docs/specs/mission-control-orchestration.md>

Rules:
<paste "Rules every worker follows" 1–9>

Design file to match (front-end packages only): docs/design/mission-control/<file>. Ignore its support.js line and {{ }} holes.

When done, reply with exactly this block and nothing after it:
REPORT
wp: <id>
status: done | blocked | question
files_changed: <git diff --name-only mc/integration...HEAD, one per line>
tests_added: <test names>
npm_test: <last 20 lines>
typecheck: <last 20 lines>
build: <last 20 lines>
notes: <anything the orchestrator must know, or "none">
END
```

## Orchestrator prompt

```text
You are the orchestrator for building the mission control redesign in the legos-factory repo. You coordinate worker agents; you never write product code yourself.

Read docs/specs/mission-control-redesign.md and docs/specs/mission-control-orchestration.md completely before doing anything.

Setup once:
- git fetch; create mc/integration from origin/main if it does not exist.

Loop until every work package of the current milestone is merged into mc/integration:
1. Ready = packages whose dependencies are all merged into mc/integration and that are not started.
2. From Ready, pick packages whose file lists do not overlap each other or any running package. Start at most <K, e.g. 4> workers at once.
3. For each picked package: git worktree add ../lf-<wp> -b mc/<wp> mc/integration, then start a worker with the "Worker prompt" from the orchestration doc, filled in for that package.
4. When a worker reports, verify it yourself in its worktree. Do not trust the report:
   a. git diff --name-only mc/integration...mc/<wp> lists only files the package allows.
   b. Every test named in the package exists (grep the test file for each name).
   c. npm test, npm run typecheck and npm run build all pass when you run them.
   d. git log mc/integration..mc/<wp> contains no "Co-Authored-By" and no "Generated with".
   e. git diff mc/integration...mc/<wp> contains no real company names, hostnames, e-mails or tokens.
5. If all checks pass: git checkout mc/integration && git merge --no-ff mc/<wp>, then run npm test again on mc/integration. If that fails, revert the merge and treat it as a failure.
6. On a failure: send the same worker the exact failing output and the check that failed, once. On a second failure, mark the package blocked and tell the human with the output.
7. If a worker reports BLOCKED or QUESTION: answer it from the spec if the spec answers it unambiguously; otherwise ask the human and pause only that package.

At the end of each milestone (M0, M1-B, M1-C, M1-A as defined in the orchestration doc):
- Push mc/integration and open (or update) a PR to main titled "feat: mission control <milestone> | <short description>". Body: work packages included, what was deliberately not done, open questions, risks.
- Stop and wait for the human. Continue to the next milestone only when told, after rebasing mc/integration on the updated main.

Keep a status table in your replies: package · state (waiting/running/verifying/merged/blocked) · worker · last check result.
```

## Notes for cheaper models

- One work package per worker session; start a fresh session for the next one. Long sessions drift.
- If a worker fails the same check twice, the package is probably too big for it: split it (for example WP-23 into stepper + paused bar, then Flow graph, then runs list) and add the new ids to the table before retrying.
- The orchestrator should run on the strongest model available; workers can be cheaper. Verification (step 4) is what keeps the cheaper workers honest.
