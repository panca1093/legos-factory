# Spec: Git via workbench

Status: approved · 2026-10-16 · builds on My repos (#4)

## Why
Bitbucket API calls already go through workbench as the signed-in user, but git clone/push use SSH with the Mac's own key (DEFAULT_GIT_URL = git@bitbucket.org:…). Problems: wrong identity (every local user pushes as whoever owns the Mac's key); can't run in a sandbox/container/hub (no SSH key there); a permanent key that works on every repo is within reach of every agent run.
Workbench has `bitbucket_get_clone_url { workspace?, repoSlug }` (verified 2026-10-16). It mints a per-user HTTPS URL `https://x-token-auth:<oauth token>@bitbucket.org/<ws>/<slug>.git` for clone, pull and push. The token expires in ≤2h; push needs the repository:write scope on the user's workbench connection; the URL must not be persisted (e.g. in .git/config).

## Decisions
1. Git credentials come from workbench, per user. No new Bitbucket connection.
2. No token on disk or in argv. The remote URL is plain `https://bitbucket.org/<ws>/<slug>.git`; tokens are handed over only through a git credential helper reading from an env var or the factory endpoint.
3. Fresh token on demand: a run can outlive 2h, so the helper asks the factory each time git needs a credential and the factory mints a new one from workbench. Same trust model as the /mcp/:name proxy: per-run secret in `grants`, local hosts only.
4. Scoped minting: only for the run's own repo, and only while that repo is in the owner's My repos.
5. The `gitUrl` option still works: when opts.gitUrl is set (tests and local override), the current direct clone stays exactly as it is, with no helper. Without it, workbench is the default. DEFAULT_GIT_URL (SSH) is removed as the default.

## Server
### Clone (server/workspace.ts, createWorkspace)
- New optional input `credential?: () => Promise<string>` returning a token.
- When given, clone `https://bitbucket.org/<ws>/<slug>.git` with `-c credential.helper=` (clears inherited helpers), `-c 'credential.helper=!f() { test "$1" = get && echo username=x-token-auth && echo "password=$LEGOS_GIT_TOKEN"; }; f'`, env `LEGOS_GIT_TOKEN=<token>`, `GIT_TERMINAL_PROMPT=0`.
- After cloning, write the run-time helper into the clone's local config (below). The helper holds no secret, only env var references.
- Clone error messages never contain the token: redact anything like `x-token-auth:…@` from stderr.

### Run-time helper (clone's .git/config)
```
[credential "https://bitbucket.org"]
  helper =
  helper = "!f() { test \"$1\" = get || exit 0; curl -fsS -H \"x-legos-run: $LEGOS_RUN_SECRET\" \"$LEGOS_URL/git/credential\"; }; f"
[user]
  name = <owner name>      # only when known
  email = <owner email>    # only when known; otherwise leave git's global config
```

### Endpoint GET /git/credential (new, in server/routes/connections.ts next to /mcp/:name)
1. localOnly(host), else 403.
2. x-legos-run → grants → run, else 403 unknown run.
3. The run must be in a managed workspace with a repo (run.repo), else 403.
4. requireMyRepo(deps, owner, run.repo), else 403.
5. Call workbench bitbucket_get_clone_url for that repo as the run owner; parse the token from the URL; never log it.
6. Respond text/plain `username=x-token-auth\npassword=<token>\n`. Workbench failure → 502. No workbench connection → 409.
7. No caching: each call mints a new token.

### Grants for every repo run
- Today a grant secret exists only when the user has connected MCP servers. Change: every run whose cwd is a managed workspace gets a secret in grants, including fix-queue runs (pr-fixes.ts).
- Pass LEGOS_RUN_SECRET and LEGOS_URL (opts.selfUrl) to the Claude Code process via the Agent SDK `env` option. StartRequest gains `env?: Record<string, string>`; RunManager merges it over process.env.
- Grants are revoked on run end, as today.

### Workbench client
- Add `bitbucketCloneUrl(token, workspace, slug): Promise<string>` in server/workbench.ts, plus `tokenFromCloneUrl(url)` returning null when the shape is unexpected (the endpoint then answers 502).

### Fix queues
- FixQueues.prepare (server/app.ts) uses the same credential path (owner's workbench mints the clone token). Its run gets a grant and env like any repo run, so the agent can push to the PR branch.

## Web
- No new UI. When a clone fails with a 401/403 from Bitbucket, the error shown includes the hint "reconnect workbench in Settings (needs repository write access)" (substring match on git's auth-failure stderr).

## Tests (fail before, pass after)
- tokenFromCloneUrl: valid URL → token; other shapes → null.
- createWorkspace with a credential clones from a local bare repo (insteadOf or injected runner); the token never appears in .git/config; the run-time helper and author are written.
- Clone stderr containing `x-token-auth:SECRET@` is redacted in the thrown error.
- /git/credential: 403 for non-local host, unknown secret, run without repo, repo removed from My repos; 409 no workbench; 502 workbench error; 200 with the exact `username=…\npassword=…\n` body; mints only for the run's own repo.
- Every managed-workspace run gets a grant and env (LEGOS_RUN_SECRET, LEGOS_URL) even with zero MCP connections; local-folder runs get neither.
- With opts.gitUrl set, clone behavior is unchanged: existing workspace tests pass untouched.
- npm test, npm run typecheck, npm run build all green.

## Out of scope
Sandbox/container/hub runtimes; mirror or clone cache; GitHub/GitLab; detecting the missing repository:write scope up front.

## Known limitations
Pushes depend on workbench. An agent can call the helper endpoint and see a token, but only for its own repo and only for ≤2h — narrower than today's SSH key.
