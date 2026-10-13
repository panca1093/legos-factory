# legos-factory

Software development factory: local mission control for coding agents.

Local mission control for coding agents. v1 runtime: Claude Code. Codex and Hermes come later behind the same model (`shared/types.ts`).

- **Observe** — every Claude Code session in `~/.claude/projects` (terminal ones too): timeline, tools, errors, token buckets (deduped by message id, subagents included; unknown ≠ 0).
- **Chat** — interactive Claude Code sessions to discuss: reply between turns, stop a turn, end the session. Pick any model your account offers, switch mid-session. Idle chats close after 30 min (`LEGOS_IDLE_MS`).
- **Task** — hand off a job: one prompt, runs to completion on its own (Done / Failed / Cancelled), then "Discuss in chat" to follow up. Permissions picked per task.
- **Needs you** — permission requests and `AskUserQuestion` clarifications from all UI-launched runs in one inbox.

- **Connections** — add workbench or any remote MCP server in Settings (OAuth or a static header); every new chat and task gets them as MCP tools.

Runs load your user/project settings, so MCP servers (Jira, Bitbucket, …) and skills work as in the CLI. Nothing org-specific lives here.

```bash
npm install
cp .env.example .env.local   # optional
npm run dev     # api :4317 + ui :5173
npm test
```

`npm run build && npm start` serves the built UI from the API port. `npm run dev:team` also starts a local team hub (`LEGOS_MODE=hub`, :4400) for My activity / Team activity.

## Notes

- Sign-in: a local account with a 6-digit PIN (scrypt, `~/.legos-factory/account.json`, 0600), held in an HMAC-signed cookie for 30 days. Five wrong PINs lock it for 30 s, doubling per further miss. Forgot the PIN: delete that file and set up again. `LEGOS_AUTH=off` skips it for local dev.
- Connections (Settings): a workbench or any MCP server, via OAuth 2.1 (discovery, dynamic client registration, PKCE) or a static header. Credentials stay server-side in `~/.legos-factory/connections.json` (0600); runs reach each server through a local proxy (`/mcp/<name>`) that attaches them fresh. A connected workbench also enables the apps list, Jira tasks and the team hub.

- Binds to 127.0.0.1 only. `/api` rejects non-local `Host` and requires `x-legos: 1` on writes, since launching a run executes code.
- Each live session is a `claude` process. Runs are in memory; restarting the server forgets them (their transcripts stay under Sessions).
- Cost is Claude Code's API-equivalent estimate, not an invoice.
- Team sharing per folder (Private / Status / Full) and ticket detection live in `~/.legos-factory/settings.json` (`LEGOS_SETTINGS` overrides). Private unless a rule says otherwise; nothing is sent anywhere until the team hub exists.
- `CLAUDE_PROJECTS_DIR` overrides the transcripts dir; `LEGOS_API_PORT` the API port.
