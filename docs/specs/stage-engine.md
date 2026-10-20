# Spec: Stage engine (phase B)

Status: implemented · builds on Work items and the runner dispatcher

## Why
Phase A tracked a ticket's PRs and moved Jira forward, but every run was started by hand and nothing stopped Build from starting before the spec was agreed. The engine runs the factory workflow (`workflows/factory`) per repo of a work item: Design → gate → Build → Inspect → Catalog, one run per stage on the dispatcher.

## Decisions
1. The stage list, personas, gates, read-only and manual-start flags are read from `workflows/factory/factory.yaml` (`server/workflow.ts`); the engine has no stage order of its own. An unknown stage or fact in the manifest is an error at startup.
2. Gates are facts, never claims. Three neutral facts exist: `pr.merged`, `ci.passed`, `human.approved`, stored in `stage_events` keyed by repo and PR (so recording is idempotent). Sources: the forge, observed while the Jira sync refreshes a PR (`StageStore.observe`), and people, through the two buttons below. An agent's final message, a reviewer's verdict and a persona never record a fact.
3. Design: one run per repo opens the spec PR (captured as before). Its gate is `pr.merged` on that PR; when it holds the repo becomes `build / ready`.
4. Build: the manifest marks it `start: manual`. It begins only through `POST /api/work-items/:ticket/repos/:ws/:slug/start-build`, which refuses (409) until the gate is open and records `human.approved` for the click. `POST /api/runs` with a manual stage is routed to the same check.
5. Inspect starts when the build PR is captured (`on_pr_open`): a read-only task on the PR branch with the reviewer persona. It ends with a `Verdict:` line.
   - `APPROVE`: the repo waits at the build gate. The verdict opens nothing.
   - `REQUEST_CHANGES`: Build runs again on the same branch with the review text, then Inspect again. At most `MAX_REVIEW_LOOPS` (3) rounds, enforced in code; the next reject, an `ABSTAIN`, a missing verdict or a failed run escalates.
6. The build gate (`ci.passed` + `human.approved`) shows when a PR is ready to merge. `POST …/approve` records `human.approved` for the build PR. Merging stays a person's action.
7. Catalog runs when the build PR is merged (`after: pr.merged`).
8. Escalated means the engine stopped and a person decides; the reason is shown on the work item. A new design run, or Start build again, takes it from there; facts that arrive later still move it.
9. Jira moves exactly as in phase A (forward-only, compare-and-swap): stage runs and PR states feed the same rules.

## Data
```sql
work_item_stages (workspace_id, ticket, repo_key, stage, phase 'run'|'gate'|'ready'|'escalated'|'done', loops, pr_id, note, owner, updated_at)
stage_events (workspace_id, ticket, repo_key, type, pr_id, actor, at)  -- one row per fact
```
A repo with PRs linked by hand and no row is read from its links and facts.

## API
`GET /api/work-items` gains `stages: [{ repo, stage, phase, loops, prId, note, missing }]`. New: `POST /api/work-items/:ticket/repos/:ws/:slug/start-build` and `…/approve`. Stage runs are tasks with higher dispatcher priority than new chats and tasks.

## Tests
Full walk with facts only; an agent claiming "merged" changes nothing; Start build refused before the gate; read-only review of the PR branch; reject loop bounded at 3 and then escalated; no verdict and failed runs escalate; stages from hand-linked PRs; a manifest whose Build is automatic starts it by itself; manifest validation; verdict parsing.

## Out of scope
Merging from the factory; CI status from Bitbucket through workbench (its PR tool reports none, so `ci.passed` arrives only from forges that do); several workflows per workspace; posting the review on the PR.
