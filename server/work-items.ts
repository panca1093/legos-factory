import type { DatabaseSync } from 'node:sqlite';
import type { TicketLink, WorkItemNote } from '../shared/types.ts';

const keyOf = (repo: string) => repo.trim().toLowerCase();
const now = () => new Date().toISOString();

type LinkRow = Omit<TicketLink, 'commented' | 'updatedAt'>;

const LINK_COLS = `name as repo, l.kind, l.pr_id as prId, l.branch, l.title, l.state, l.run_id as runId, l.commented, l.updated_at as updatedAt`;

// Per workspace: a ticket, the repos it touches, the PRs linked to it and what the Jira sync did.
export class WorkItems {
  constructor(private db: DatabaseSync) {}

  get(workspaceId: string, ticket: string): { status: string | null; done: boolean; note: WorkItemNote | null } | null {
    const row = this.db.prepare(`select status, done, note, note_at from work_items where workspace_id = ? and ticket = ?`).get(workspaceId, ticket) as
      | { status: string | null; done: number; note: string | null; note_at: string | null }
      | undefined;
    return row ? { status: row.status, done: !!row.done, note: row.note ? { text: row.note, at: row.note_at! } : null } : null;
  }

  setNote(workspaceId: string, ticket: string, text: string | null) {
    this.db.prepare(`update work_items set note = ?, note_at = ? where workspace_id = ? and ticket = ?`).run(text, text ? now() : null, workspaceId, ticket);
  }

  list(workspaceId: string): string[] {
    return (this.db.prepare(`select ticket from work_items where workspace_id = ? order by created_at desc`).all(workspaceId) as { ticket: string }[]).map((r) => r.ticket);
  }

  // every workspace's items the factory hasn't finished with
  pending(): { workspaceId: string; ticket: string }[] {
    return this.db.prepare(`select workspace_id as workspaceId, ticket from work_items where done = 0 order by workspace_id, ticket`).all() as { workspaceId: string; ticket: string }[];
  }

  create(workspaceId: string, ticket: string) {
    this.db.prepare(`insert into work_items (workspace_id, ticket, created_at) values (?, ?, ?) on conflict do nothing`).run(workspaceId, ticket, now());
  }

  setStatus(workspaceId: string, ticket: string, status: string | null, done: boolean) {
    this.db.prepare(`update work_items set status = ?, done = ? where workspace_id = ? and ticket = ?`).run(status, done ? 1 : 0, workspaceId, ticket);
  }

  repos(workspaceId: string, ticket: string): { name: string; addedAt: string }[] {
    return this.db.prepare(`select name, added_at as addedAt from work_item_repos where workspace_id = ? and ticket = ? order by repo_key`).all(workspaceId, ticket) as { name: string; addedAt: string }[];
  }

  hasRepo(workspaceId: string, ticket: string, repo: string): boolean {
    return !!this.db.prepare(`select 1 from work_item_repos where workspace_id = ? and ticket = ? and repo_key = ?`).get(workspaceId, ticket, keyOf(repo));
  }

  addRepo(workspaceId: string, ticket: string, name: string) {
    this.db
      .prepare(`insert into work_item_repos (workspace_id, ticket, repo_key, name, added_at) values (?, ?, ?, ?, ?) on conflict do nothing`)
      .run(workspaceId, ticket, keyOf(name), name, now());
  }

  removeRepo(workspaceId: string, ticket: string, repo: string) {
    this.db.prepare(`delete from work_item_repos where workspace_id = ? and ticket = ? and repo_key = ?`).run(workspaceId, ticket, keyOf(repo));
  }

  links(workspaceId: string, ticket: string): TicketLink[] {
    const rows = this.db
      .prepare(
        `select ${LINK_COLS} from ticket_links l join work_item_repos r using (workspace_id, ticket, repo_key)
         where l.workspace_id = ? and l.ticket = ? order by l.repo_key, l.kind desc, l.pr_id`,
      )
      .all(workspaceId, ticket) as (Omit<TicketLink, 'commented'> & { commented: number })[];
    return rows.map((r) => ({ ...r, commented: !!r.commented }));
  }

  // commented = true marks a PR linked by hand: it is never announced on Jira. Re-linking keeps the stored flag.
  link(workspaceId: string, ticket: string, l: LinkRow, commented = false) {
    this.db
      .prepare(
        `insert into ticket_links (workspace_id, ticket, repo_key, kind, pr_id, branch, title, state, run_id, updated_at, commented) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict do update set kind = excluded.kind, run_id = excluded.run_id, branch = excluded.branch, title = excluded.title, state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(workspaceId, ticket, keyOf(l.repo), l.kind, l.prId, l.branch, l.title, l.state, l.runId, now(), Number(commented));
  }

  update(workspaceId: string, ticket: string, repo: string, prId: number, set: { state?: string; title?: string; commented?: boolean }) {
    this.db
      .prepare(
        `update ticket_links set state = coalesce(?, state), title = coalesce(?, title), commented = coalesce(?, commented), updated_at = ?
         where workspace_id = ? and ticket = ? and repo_key = ? and pr_id = ?`,
      )
      .run(set.state ?? null, set.title ?? null, set.commented === undefined ? null : Number(set.commented), now(), workspaceId, ticket, keyOf(repo), prId);
  }

  ticketForPr(workspaceId: string, repo: string, prId: number): string | null {
    const row = this.db.prepare(`select ticket from ticket_links where workspace_id = ? and repo_key = ? and pr_id = ? limit 1`).get(workspaceId, keyOf(repo), prId) as { ticket: string } | undefined;
    return row?.ticket ?? null;
  }
}
