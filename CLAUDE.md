# Working rules

Read these before changing anything. They apply to every session, human or agent.

## Scope

- Do what was asked and nothing around it. Notice something else worth fixing? Mention it; don't fold it into the change.
- Simplest solution first. No abstraction, option or layer without a caller that exists today.
- Don't touch files you don't need for the task. Other people may have uncommitted work in them.

## Lean schemas and endpoints

- Every new table and every new endpoint must be justified against a real caller (UI, runner, test of a shipped feature). If nothing calls it, don't add it.
- Prefer a column on an existing table over a new table, and an existing endpoint over a new one.

## Goal-driven

- Start from the outcome that must be true, then write the test that shows it, then the behavior. Tests come before or with the behavior, never after "if time allows".
- `npm test` and `npm run build` must be green before you push. Say plainly when they aren't.

## Comments

- Let identifiers carry the meaning.
- Allowed: a one-line doc on an exported function or module saying what it is for, and a one-line WHY for a non-obvious constraint.
- Not allowed: comments that restate the code, multi-line blocks, section banners, filler, TODOs without an owner.

## Commits and pull requests

- No AI co-author trailers and no "generated with" lines in commits or PR bodies.
- Commit with the identity configured for the repository; don't change it.
- Small, separate commits, one concern each. The PR body lists what changed, what was deliberately not done, and the risks.

## Public repository

- Nothing org-specific in tracked files or commits: no company or team names, internal URLs, hostnames, ticket keys, e-mail addresses or tokens. Use neutral examples (`acme`, `example.com`, `PROJ-123`).
- Org-specific behavior (title templates, project-to-repo mapping, status names) is per-workspace configuration, not code.
