# legos-factory

Software development factory: local mission control for coding agents.

Local mission control for coding agents. v1 runtime: Claude Code. Codex and Hermes come later behind the same model (`shared/types.ts`).

- **Observe** — every Claude Code session in `~/.claude/projects` (terminal ones too): timeline, tools, errors, token buckets (deduped by message id, subagents included; unknown ≠ 0).
- **Chat** — interactive Claude Code sessions to discuss: reply between turns, stop a turn, end the session. Pick any model your account offers, switch mid-session. Idle chats close after 30 min (`LEGOS_IDLE_MS`).
- **Task** — hand off a job: one prompt, runs to completion on its own (Done / Failed / Cancelled), then "Discuss in chat" to follow up. Permissions picked per task.
- **Needs you** — permission requests and `AskUserQuestion` clarifications from all UI-launched runs in one inbox.

Runs load your user/project settings, so MCP servers (Jira, Bitbucket, …) and skills work as in the CLI. Nothing org-specific lives here.

```bash
npm install
cp .env.example .env.local   # then fill in your workbench URL
npm run dev     # api :4317 + ui :5173
npm test
```

`npm run build && npm start` serves the built UI from the API port. `npm run dev:team` also starts a local team hub (`LEGOS_MODE=hub`, :4400) for My activity / Team activity.

## Notes

- Sign-in: "Sign in with <your SSO>" via a workbench server (OAuth 2.1 + PKCE, dynamic client registration). Tokens stay server-side in `~/.legos-factory/auth.json` (0600). Each run gets the `workbench` MCP through a local proxy that attaches its owner's fresh token. Configure it in `.env.local` (see `.env.example`); without `LEGOS_WORKBENCH_URL`, sign-in and workbench features are off. `LEGOS_AUTH=off` skips sign-in for local dev.

- Binds to 127.0.0.1 only. `/api` rejects non-local `Host` and requires `x-legos: 1` on writes, since launching a run executes code.
- Each live session is a `claude` process. Runs are in memory; restarting the server forgets them (their transcripts stay under Sessions).
- Cost is Claude Code's API-equivalent estimate, not an invoice.
- Team sharing per folder (Private / Status / Full) and ticket detection live in `~/.legos-factory/settings.json` (`LEGOS_SETTINGS` overrides). Private unless a rule says otherwise; nothing is sent anywhere until the team hub exists.
- `CLAUDE_PROJECTS_DIR` overrides the transcripts dir; `LEGOS_API_PORT` the API port.
