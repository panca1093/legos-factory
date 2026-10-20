# Spec: Ports for tickets and code hosting

Status: implemented · builds on the stage engine

## Why
Jira and Bitbucket were called by name from routes, the sync and the engine. Another team using GitHub or Linear would have to edit the core. The core now owns two small interfaces; one module per provider implements them.

## Ports (`server/ports.ts`)
- `WorkSource` — where tickets live: `list`, `get`, `status`, `transitionTo(key, status)` (looks the transition up at the moment of the move; false if the ticket cannot reach that status), `comment`.
- `Forge` — where code lives: `listRepos`, `listPrs`, `getPr` (with `ci`, the forge's verdict on the checks, or null), `files`, `diff`, `comments`, `addComment`, `merge`, `cloneToken` (a short-lived git credential), `searchUsers`.

The core receives them from `deps.workSource(workspaceId)` and `deps.forge(workspaceId)`; both are null until the workspace connects its provider (today: a workbench connection). Nothing outside `server/providers` names a product's tools or API.

## Providers (`server/providers`)
- `jira-workbench.ts`: `WorkSource` over workbench's Jira tools (JQL presets, the Development field, Atlassian rich text → Markdown).
- `bitbucket-workbench.ts`: `Forge` over workbench's Bitbucket tools (paged repo listing, cut-off diffs and comment lists salvaged, clone token read out of the clone URL).
- `github.ts`: `Forge` over GitHub's REST API, read-only: list and get PRs (with check status), files, diff, comments and a clone credential. Writes (`addComment`, `merge`) fail with a clear error.
`server/workbench.ts` keeps only the gateway client (MCP session, `execute`, `whoami`, integrations).

The move is a refactor: the same tool calls in the same order, the same HTTP answers. Two deliberate differences: `Pr` gains `ci` (always null for Bitbucket, whose PR tool reports none), and the unknown-filter error now comes from the provider.

## Organisation-specific text is workspace configuration
- Jira project keys → repos: `workspace_repos.jira_projects`, per workspace (already so).
- PR title rules: `workspaces.config.prTitle.{design,build}`, free text added to that stage's instructions; owners set them in Settings (`PUT /api/workspaces/:id/config`, returned by `GET /api/workspaces`). Unset, the agent follows each repo's own format. The built-in "no deployment tag" sentence is gone from the code.
- Status names stay in `settings.json` (`jiraFlow`); ticket keys look like `ABC-123`.

## Tests
One contract suite runs against the Bitbucket provider (fake workbench) and the GitHub provider (fake HTTP): neutral shapes for repos, PRs, files, diff, comments, clone credential, and write behaviour per provider. The Jira provider's transition lookup. The Jira sync runs against in-memory `WorkSource` and `Forge` objects with no workbench at all. Title rules reach the prompt only when configured.

## Out of scope
Wiring GitHub into the running app (the clone URL and git credential helper in `server/workspace.ts` are still Bitbucket-shaped, and there is no per-workspace provider choice or token store); a second `WorkSource`; calling `merge` (nothing in the engine merges); the verified name of workbench's merge tool.
