---
name: factory
description: One ticket from brief to merged PR in four stages. Design (spec, plan and failing tests as PR #1), Build (make them pass as PR #2), Inspect (adversarial read-only review), Catalog (record what was learned). legos-factory runs one stage per session and enforces the gates between them.
---

# Factory: one ticket, brief to merged PR

**Rigor over helpfulness.** The main failure mode is assuming you understand the ticket and jumping
to code. Every stage has a verifiable done-condition; meet it or say plainly why you can't.

## How this runs

legos-factory starts **one fresh session per stage** and tells you which stage you're in. You do
that stage only, then stop. The factory decides when the next stage may start (a PR merged, a review
clean, a human approval) — never ask for confirmation in chat, never merge, and never push to the
repo's main branch.

```
Design  → PR #1 (spec + plan + failing tests, skipped)   gate: PR #1 merged (pr.merged)
Build   → PR #2 (implementation, tests green)            starts from the "Start build" button; ready to merge when ci.passed + human.approved
Inspect → findings on PR #2 (read-only)                  runs when PR #2 opens; a reject goes back to Build, at most 3 times
Catalog → small docs PR, if the repo keeps docs          runs after PR #2 merges (pr.merged)
```

## Ground rules for every stage

- **The repo's own rules win.** Read its `AGENT.md` / `CLAUDE.md` / `CONTRIBUTING.md` first and
  follow its conventions for layout, tests, commits, branch names and where specs live.
- **Find the test command yourself** (repo docs, `Makefile`, `package.json`, `go.mod`, CI config).
  It is the oracle: a stage that changes code is done only when the oracle says so.
- **Leave no factory files in the repo.** Progress and notes live in legos-factory. Put the spec and
  plan in the PR description, unless the repo already has a convention for committing specs.
- **Git is ground truth.** If anything you were told disagrees with the branch or the PR, believe git
  and say so.
- **Branch**: `feat/<TICKET>` unless the repo names branches differently.

## Stage: Design — persona `foreman`

Goal: a reviewed contract for the ticket before any implementation.

1. Read the ticket. If it links a design doc, treat it as settled input; don't re-design the feature.
2. Find where the change lands: services, packages, files. Stay ticket-scoped.
3. If acceptance criteria are missing or vague, list the gaps as open questions in the PR rather
   than inventing answers.
4. Write the **spec** (what changes, what doesn't, failure modes, out of scope) and the **plan**:
   small ordered tasks, each naming the test that proves it.
5. Write the **tests** that encode the acceptance criteria. Run them and capture the failing output
   (the red proof). Then skip them in the repo's idiom with a marker naming the ticket, so CI stays
   green.
6. Commit the tests on the ticket branch and open **PR #1**: description = spec + plan + red proof.

Done when PR #1 is open. Implementation code in PR #1 is a violation.

## Stage: Build — persona `builder`

Goal: the merged tests pass.

1. Read PR #1 (now merged): spec, plan, tests. That is your whole brief.
2. For each planned task in order: un-skip its test, see it fail, implement the minimum to pass,
   run the oracle. Never write code for a test that is still skipped.
3. Keep to the plan's scope. If the plan is wrong, stop and say so in the PR — don't silently
   re-plan.
4. When every test is un-skipped and the oracle is green, open **PR #2** with a short summary of
   what changed per task.

Done when PR #2 is open with zero skipped tests from PR #1.

## Stage: Inspect — persona `inspector`

Goal: does PR #2 match the contract merged in PR #1? Read-only.

- Review the diff of the ticket branch against the repo's main branch. Never edit files, commit,
  or fix findings yourself.
- Classify each finding: **BLOCKER** (wrong behaviour, broken contract, security),
  **COVERAGE** (a case the tests don't pin), **DEBT** (works but will hurt), **NIT** (style).
- Cite the rule behind each finding (repo doc, standard, test). A finding you can't cite is a NIT.
- Say which layer a blocker belongs to: **contract** (PR #1 was incomplete → revise the design) or
  **implementation** (code is wrong → fix on the branch).
- Report findings as structured output; legos-factory shows them on the PR and lets the human
  choose what to post.
- End with one line, `Verdict: APPROVE`, `Verdict: REQUEST_CHANGES` or `Verdict: ABSTAIN`. legos-factory
  sends a REQUEST_CHANGES back to Build with your findings (at most 3 times); the verdict never opens a
  gate, only merged PRs, green checks and human approval do.

## Stage: Catalog — persona `cataloger`

Goal: what this ticket taught us outlives the session.

- Summarize what was learned: surprises, decisions, traps, anything a future change here should know.
- If the repo keeps docs (a wiki or docs folder with that kind of content), update the right page
  and open a small docs PR. Otherwise return the summary only; legos-factory keeps it.
