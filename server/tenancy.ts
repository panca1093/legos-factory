import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Role, WorkspaceInfo, WorkspaceMember } from '../shared/types.ts';

// The tenancy unit: every user has a personal workspace and may belong to team ones. What a workspace
// holds (connections, repos, runs, work items) is reachable only by its members, per role.

const ROLES: Role[] = ['owner', 'member', 'viewer'];
export const isRole = (r: unknown): r is Role => ROLES.includes(r as Role);

// Workspace settings and credentials are for owners; members run work; viewers only read.
const OWNER_ONLY = [/^\/api\/connections(\/|$)/, /^\/api\/my-repos(\/|$)/, /^\/api\/workbench\/connect$/, /^\/api\/runners(\/|$)/];
const ANY_ROLE = /^\/api\/workspaces(\/|$)/;

export function allowed(role: Role, method: string, path: string): boolean {
  if (ANY_ROLE.test(path)) return true;
  if (method === 'GET') return true;
  if (role === 'viewer') return false;
  return role === 'owner' || !OWNER_ONLY.some((re) => re.test(path));
}

export class Workspaces {
  constructor(private db: DatabaseSync) {}

  // A personal workspace shares its user's id, so rows written before workspaces existed stay reachable.
  ensurePersonal(userId: string, name: string): string {
    const exists = this.db.prepare(`select 1 from workspaces where id = ?`).get(userId);
    if (!exists) {
      this.db.prepare(`insert into workspaces (id, name, kind, created_at) values (?, ?, 'personal', ?)`).run(userId, name, new Date().toISOString());
      this.db.prepare(`insert into workspace_members (workspace_id, user_id, role) values (?, ?, 'owner')`).run(userId, userId);
    }
    return userId;
  }

  create(name: string, ownerId: string): WorkspaceInfo {
    const id = randomUUID();
    this.db.prepare(`insert into workspaces (id, name, kind, created_at) values (?, ?, 'team', ?)`).run(id, name, new Date().toISOString());
    this.db.prepare(`insert into workspace_members (workspace_id, user_id, role) values (?, ?, 'owner')`).run(id, ownerId);
    return { id, name, kind: 'team', role: 'owner' };
  }

  list(userId: string): WorkspaceInfo[] {
    return this.db
      .prepare(
        `select w.id, w.name, w.kind, m.role from workspaces w join workspace_members m on m.workspace_id = w.id
         where m.user_id = ? order by w.kind, w.name collate nocase`,
      )
      .all(userId) as WorkspaceInfo[];
  }

  get(id: string): { id: string; name: string; kind: 'personal' | 'team' } | null {
    return (this.db.prepare(`select id, name, kind from workspaces where id = ?`).get(id) as { id: string; name: string; kind: 'personal' | 'team' } | undefined) ?? null;
  }

  roleOf(workspaceId: string, userId: string): Role | null {
    const row = this.db.prepare(`select role from workspace_members where workspace_id = ? and user_id = ?`).get(workspaceId, userId) as { role: Role } | undefined;
    return row?.role ?? null;
  }

  // The workspace the user switched to, or their personal one when that membership is gone.
  active(userId: string): { id: string; role: Role } {
    const row = this.db.prepare(`select active_workspace as id from users where id = ?`).get(userId) as { id: string | null } | undefined;
    const role = row?.id ? this.roleOf(row.id, userId) : null;
    return row?.id && role ? { id: row.id, role } : { id: userId, role: this.roleOf(userId, userId) ?? 'owner' };
  }

  setActive(userId: string, workspaceId: string): boolean {
    if (!this.roleOf(workspaceId, userId)) return false;
    this.db.prepare(`update users set active_workspace = ? where id = ?`).run(workspaceId, userId);
    return true;
  }

  members(workspaceId: string): WorkspaceMember[] {
    return this.db
      .prepare(
        `select m.user_id as userId, coalesce(u.name, m.user_id) as name, u.email, m.role from workspace_members m
         left join users u on u.id = m.user_id where m.workspace_id = ? order by m.role, name collate nocase`,
      )
      .all(workspaceId) as WorkspaceMember[];
  }

  private owners(workspaceId: string): number {
    return (this.db.prepare(`select count(*) as n from workspace_members where workspace_id = ? and role = 'owner'`).get(workspaceId) as { n: number }).n;
  }

  // false when the change would leave the workspace without an owner
  setMember(workspaceId: string, userId: string, role: Role): boolean {
    if (role !== 'owner' && this.roleOf(workspaceId, userId) === 'owner' && this.owners(workspaceId) === 1) return false;
    this.db
      .prepare(`insert into workspace_members (workspace_id, user_id, role) values (?, ?, ?) on conflict do update set role = excluded.role`)
      .run(workspaceId, userId, role);
    return true;
  }

  removeMember(workspaceId: string, userId: string): boolean {
    if (this.roleOf(workspaceId, userId) === 'owner' && this.owners(workspaceId) === 1) return false;
    this.db.prepare(`delete from workspace_members where workspace_id = ? and user_id = ?`).run(workspaceId, userId);
    return true;
  }
}
