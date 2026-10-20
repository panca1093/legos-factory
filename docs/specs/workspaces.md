# Spec: Workspaces

Status: implemented · builds on My repos and Work items

## Why
Ownership was one user id on every row, so a team could not share connections, repos, runs or work items. The workspace is the tenancy unit: one person is a team of one, and a self-hosted team is one team workspace with several members.

## Decisions
1. Every user has a personal workspace whose id is the user id, created on first request. Rows written before workspaces existed therefore stay reachable; `openDb` renames `owner` to `workspace_id` (and `user_repos` to `workspace_repos`) in place.
2. A team workspace has a random id and members with a role. Personal workspaces have exactly one member and no member management.
3. Roles are enforced server-side by one table (`allowed` in `server/tenancy.ts`), applied to every `/api` call:
   - `viewer`: GET only.
   - `member`: everything except workspace configuration.
   - `owner`: also connections, repos and members.
4. The active workspace is stored on the user (`users.active_workspace`) and falls back to the personal one when the membership is gone. No per-request workspace header: a switch applies to every tab.
5. `Run.owner` stays as the user who launched a run (git author); scoping uses `Run.workspaceId`.

## Data
```sql
workspaces (id text primary key, name text not null, kind text not null, created_at text not null)
workspace_members (workspace_id text, user_id text, role text, primary key (workspace_id, user_id))
-- users.active_workspace; owner columns renamed to workspace_id on connections, runs, workspace_repos, work_items, work_item_repos, ticket_links
```

## API
- `GET /api/workspaces` → `{ active, workspaces: [{ id, name, kind, role }] }`
- `POST /api/workspaces { name }` → new team workspace, caller is owner
- `POST /api/workspaces/active { id }` → switch (404 when not a member)
- `GET /api/workspaces/:id/members`, `PUT /api/workspaces/:id/members { user, role }` (add or change role; `user` is an id, e-mail or local name), `DELETE /api/workspaces/:id/members/:userId` (an owner removes anyone; anyone leaves)
- A workspace always keeps at least one owner (409 otherwise). Workspaces you are not in answer 404.

## Tests
Cross-workspace reads and writes denied; roles per method and path; last-owner rule; switching and leaving; upgrade of a pre-workspace database.

## Out of scope
Invitations by e-mail, per-resource ACLs, a workspace-level audit log.
