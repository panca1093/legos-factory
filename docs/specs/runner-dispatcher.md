# Spec: Control plane, runners and the durable dispatcher

Status: implemented · builds on Workspaces

## Why
Runs lived in memory inside the process that executed them: a restart failed every unfinished run, and the agent could only run where the UI ran. A team needs one control plane and agents on any machine, the way CI has a server and runners.

## Decisions
1. Two roles in one codebase. The **control plane** (`server/app.ts`, `server/runs.ts`, `server/dispatcher.ts`) owns state and the queue. A **runner** (`server/runner.ts`) owns a `RunManager` and executes agents. The embedded runner is the same `Runner` with an in-process transport, so personal mode and team mode run the same code.
2. Runners pull. Everything a runner does is an outbound request: `POST /runner/poll` (heartbeat, claim, receive commands; long-polls up to `pollWaitMs`) and `POST /runner/report` (run state, timeline events, permission requests, end of run). Auth is a per-workspace bearer token (`lfr_…`, stored hashed); owners mint and revoke them with `/api/runners`.
3. Commands (send, interrupt, model, end, answer a permission request) are queued on the control plane per run and delivered in the next poll response. They are at-most-once and not persisted: after a control-plane restart the user repeats them.
4. A run's live picture (`Run`, events, pending permission requests) is a mirror on the control plane, fed by runner reports and streamed to the UI as before. Events are not persisted; transcripts stay in Claude's own JSONL on the runner.
5. Credentials: the hub never stores a Claude subscription; the runner uses its machine's login. Per run, at claim time, the control plane makes a secret and gives the runner the connections proxy URLs and the git credential endpoint (`LEGOS_RUN_SECRET`, `LEGOS_URL`); the secret is revoked when the run ends or is claimed again.
6. Runs that need a folder on the embedded runner's disk (`cwd`, Ask factory) are pinned to it. Repo runs carry a clone spec and any runner of the workspace may take them; with an embedded runner the clone is still made at launch so errors reach the caller.

## Data
```sql
jobs (run_id pk, workspace_id, priority, state 'queued'|'leased'|'done', request json, local, runner_id, lease_until, attempts, queued_at)
runners (id pk, workspace_id, name, token_hash unique, created_at, last_seen_at)
```

## Dispatcher
- Claim order: priority desc, then `queued_at`, then insertion order. Chats get priority 1, tasks 0.
- Capacity: a runner passes its capacity on every poll; the control plane grants `capacity - leased by that runner`.
- Lease: set at claim (`LEGOS_LEASE_MS`, 60 s), extended by every poll that lists the run. `expire` returns lapsed jobs to the queue (keeping their place) or, after `LEGOS_MAX_ATTEMPTS` claims (3), fails them.
- Reports for a run are accepted only from the runner that holds its lease.
- A reaper runs every 5 s on the control plane; revoking a runner expires its leases at once.

## Restart
On startup the control plane rebuilds the mirror from `jobs` and the persisted activity item, and treats the embedded runner's leases as lapsed (it died with the process):
- working run with a Claude session → queued again with `resume` and a note to continue; the clone, if kept, is reused;
- chat that was idle → ended as completed (Sessions can continue it);
- Ask factory runs (`recoverable: false`) → failed;
- activity items still marked running with no job (before this change) → failed.
Clones of runs that will not resume are deleted at process start (not when the app is built), and only directories carrying the factory's marker inside `.git`; the rest are kept. Runs that ended but whose end was not handled yet are replayed through the stage engine.

## Runner protocol
`PollRequest { capacity, running[] }` → `{ jobs[], commands[], lost[] }`; `lost` lists runs whose lease moved on, which the runner stops. Messages in a report are the existing stream messages plus `finished { runId, branch }` (sent after the runner read the clone's branch and deleted the clone, so the control plane can capture the PR) and `launch_failed { runId, error }`. A runner keeps unsent messages and retries; a lease stays alive until `finished` is delivered and the control plane has handled it (PR capture, stage engine). Each poll answer carries `leaseMs`; a runner that got no poll through for that long stops its runs and removes their clones, since the control plane hands the jobs to someone else. A poll with nothing running gives back jobs the runner never received, without costing an attempt. Reports change a run's progress only, never its repo, ticket, stage, folder, workspace or owner.

## Configuration
Control plane: `LEGOS_RUNNER=on|off` (default off when bound beyond loopback or behind `LEGOS_PUBLIC_URL`, where local-folder runs are refused too), `LEGOS_BIND`, `LEGOS_PUBLIC_URL` (its host is accepted next to localhost), `LEGOS_LEASE_MS`, `LEGOS_MAX_ATTEMPTS`. Runner: `LEGOS_CONTROL_URL`, `LEGOS_RUNNER_TOKEN`, `LEGOS_MAX_RUNS`, `LEGOS_WORKSPACES`, `LEGOS_GIT_URL`.

## Tests
Priority and FIFO; capacity; heartbeat and lease expiry; bounded attempts; scoping by workspace and local jobs; restart (resume, idle chat, non-recoverable, attempts); permission requests relayed both ways; a remote runner over HTTP that clones, takes commands and cleans up; token auth; host check.

## Out of scope
Events persisted on the control plane or streamed from a remote runner's transcript; Ask factory and `/api/models` on a control plane without an embedded runner; routing a run to a chosen runner; autoscaling.

## Known gaps
- A run receives every connection of its workspace through `/mcp/:name`, so a prompt-injected agent can act as the workspace owner there. Scoping connections per run is not done.
- The GitHub forge's `cloneToken` returns the whole deployment token, not one scoped to the repo.
- `server/hub.ts` and CORS handling were not part of the review.
- Claiming a finished sign-in needs a secret only the app that started it holds, which stops anyone who merely learns the attempt id. A person who is talked into opening a link the attacker started in the same window still signs in for the attacker: closing that needs a confirmation code shown in the app and typed at the provider's return page.
