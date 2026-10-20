import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Tokens that let a runner on another machine pull a workspace's jobs. Only a hash is stored.

export type RunnerInfo = { id: string; name: string; createdAt: string; lastSeenAt: string | null };

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class RunnerRegistry {
  constructor(private db: DatabaseSync) {}

  create(workspaceId: string, name: string): RunnerInfo & { token: string } {
    const token = `lfr_${randomBytes(32).toString('base64url')}`;
    const info = { id: randomUUID(), name, createdAt: new Date().toISOString(), lastSeenAt: null };
    this.db.prepare(`insert into runners (id, workspace_id, name, token_hash, created_at) values (?, ?, ?, ?, ?)`).run(info.id, workspaceId, name, hash(token), info.createdAt);
    return { ...info, token };
  }

  list(workspaceId: string): RunnerInfo[] {
    return this.db
      .prepare(`select id, name, created_at as createdAt, last_seen_at as lastSeenAt from runners where workspace_id = ? order by created_at`)
      .all(workspaceId) as RunnerInfo[];
  }

  revoke(workspaceId: string, id: string): boolean {
    return Number(this.db.prepare(`delete from runners where id = ? and workspace_id = ?`).run(id, workspaceId).changes) > 0;
  }

  authenticate(token: string | undefined): { id: string; workspaceId: string } | null {
    if (!token) return null;
    const row = this.db.prepare(`select id, workspace_id as workspaceId from runners where token_hash = ?`).get(hash(token)) as { id: string; workspaceId: string } | undefined;
    if (row) this.db.prepare(`update runners set last_seen_at = ? where id = ?`).run(new Date().toISOString(), row.id);
    return row ?? null;
  }
}
