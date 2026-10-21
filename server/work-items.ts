import type { DatabaseSync } from 'node:sqlite';
import type { PipelineStage, Plan, TicketLink, WorkItem, WorkItemNote } from '../shared/types.ts';

const keyOf = (repo: string) => repo.trim().toLowerCase();
const now = () => new Date().toISOString();

type LinkRow = Omit<TicketLink, 'commented' | 'updatedAt'>;

const LINK_COLS = `name as repo, l.kind, l.pr_id as prId, l.branch, l.title, l.state, l.run_id as runId, l.commented, l.updated_at as updatedAt`;

// Per owner: a ticket, the repos it touches, the PRs linked to it and what the Jira sync did.
export class WorkItems {
  constructor(private db: DatabaseSync) {}

  get(owner: string, ticket: string): (Pick<WorkItem, 'source' | 'plan'> & { status: string | null; done: boolean; note: WorkItemNote | null }) | null {
    const row = this.db.prepare(`select status, done, note, note_at, source, plan from work_items where owner = ? and ticket = ?`).get(owner, ticket) as
      | { status: string | null; done: number; note: string | null; note_at: string | null; source: WorkItem['source']; plan: string | null }
      | undefined;
    let plan: Plan | null = null;
    if (row?.plan !== null && row?.plan !== undefined) {
      try { plan = JSON.parse(row.plan); }
      catch { plan = { tasks: [], error: 'stored plan is unreadable' }; }
    }
    return row ? { source: row.source, plan, status: row.status, done: !!row.done, note: row.note ? { text: row.note, at: row.note_at! } : null } : null;
  }

  setPlan(owner: string, ticket: string, plan: Plan) {
    this.db.prepare(`update work_items set plan = ? where owner = ? and ticket = ?`).run(JSON.stringify(plan), owner, ticket);
  }

  setStage(owner: string, ticket: string, repo: string, stage: PipelineStage, attempt = 0) {
    this.db.prepare(`update work_item_repos set stage = ?, attempt = ? where owner = ? and ticket = ? and repo_key = ?`).run(stage, attempt, owner, ticket, keyOf(repo));
  }

  backfillStages() {
    this.db.exec(`update work_item_repos as r set stage = case
      when exists (select 1 from ticket_links l where l.owner = r.owner and l.ticket = r.ticket and l.repo_key = r.repo_key and l.kind = 'impl' and l.state = 'MERGED') then 'done'
      when exists (select 1 from ticket_links l where l.owner = r.owner and l.ticket = r.ticket and l.repo_key = r.repo_key and l.kind = 'impl' and l.state = 'OPEN') then 'pr_review'
      when exists (select 1 from ticket_links l where l.owner = r.owner and l.ticket = r.ticket and l.repo_key = r.repo_key and l.kind = 'spec' and l.state = 'OPEN') then 'spec_review'
      else stage end
      where stage = 'building' and attempt = 0 and not exists (
        select 1 from runs where runs.owner = r.owner and json_extract(item, '$.ticket') = r.ticket
        and lower(json_extract(item, '$.repo')) = r.repo_key and (task is not null or persona is not null))`);
  }

  setNote(owner: string, ticket: string, text: string | null) {
    this.db.prepare(`update work_items set note = ?, note_at = ? where owner = ? and ticket = ?`).run(text, text ? now() : null, owner, ticket);
  }

  list(owner: string): string[] {
    return (this.db.prepare(`select ticket from work_items where owner = ? order by created_at desc`).all(owner) as { ticket: string }[]).map((r) => r.ticket);
  }

  // every owner's items the factory hasn't finished with
  pending(): { owner: string; ticket: string }[] {
    return this.db.prepare(`select owner, ticket from work_items where done = 0 order by owner, ticket`).all() as { owner: string; ticket: string }[];
  }

  create(owner: string, ticket: string) {
    this.db.prepare(`insert into work_items (owner, ticket, created_at) values (?, ?, ?) on conflict do nothing`).run(owner, ticket, now());
  }

  setStatus(owner: string, ticket: string, status: string | null, done: boolean) {
    this.db.prepare(`update work_items set status = ?, done = ? where owner = ? and ticket = ?`).run(status, done ? 1 : 0, owner, ticket);
  }

  repos(owner: string, ticket: string): WorkItem['repos'] {
    return this.db.prepare(`select name, added_at as addedAt, stage, attempt from work_item_repos where owner = ? and ticket = ? order by repo_key`).all(owner, ticket) as WorkItem['repos'];
  }

  hasRepo(owner: string, ticket: string, repo: string): boolean {
    return !!this.db.prepare(`select 1 from work_item_repos where owner = ? and ticket = ? and repo_key = ?`).get(owner, ticket, keyOf(repo));
  }

  addRepo(owner: string, ticket: string, name: string) {
    this.db
      .prepare(`insert into work_item_repos (owner, ticket, repo_key, name, added_at) values (?, ?, ?, ?, ?) on conflict do nothing`)
      .run(owner, ticket, keyOf(name), name, now());
  }

  removeRepo(owner: string, ticket: string, repo: string) {
    this.db.prepare(`delete from work_item_repos where owner = ? and ticket = ? and repo_key = ?`).run(owner, ticket, keyOf(repo));
  }

  links(owner: string, ticket: string): TicketLink[] {
    const rows = this.db
      .prepare(
        `select ${LINK_COLS} from ticket_links l join work_item_repos r using (owner, ticket, repo_key)
         where l.owner = ? and l.ticket = ? order by l.repo_key, l.kind desc, l.pr_id`,
      )
      .all(owner, ticket) as (Omit<TicketLink, 'commented'> & { commented: number })[];
    return rows.map((r) => ({ ...r, commented: !!r.commented }));
  }

  // commented = true marks a PR linked by hand: it is never announced on Jira. Re-linking keeps the stored flag.
  link(owner: string, ticket: string, l: LinkRow, commented = false) {
    this.db
      .prepare(
        `insert into ticket_links (owner, ticket, repo_key, kind, pr_id, branch, title, state, run_id, updated_at, commented) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict do update set kind = excluded.kind, run_id = excluded.run_id, branch = excluded.branch, title = excluded.title, state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(owner, ticket, keyOf(l.repo), l.kind, l.prId, l.branch, l.title, l.state, l.runId, now(), Number(commented));
  }

  update(owner: string, ticket: string, repo: string, prId: number, set: { state?: string; title?: string; commented?: boolean }) {
    this.db
      .prepare(
        `update ticket_links set state = coalesce(?, state), title = coalesce(?, title), commented = coalesce(?, commented), updated_at = ?
         where owner = ? and ticket = ? and repo_key = ? and pr_id = ?`,
      )
      .run(set.state ?? null, set.title ?? null, set.commented === undefined ? null : Number(set.commented), now(), owner, ticket, keyOf(repo), prId);
  }

  ticketForPr(owner: string, repo: string, prId: number): string | null {
    const row = this.db.prepare(`select ticket from ticket_links where owner = ? and repo_key = ? and pr_id = ? limit 1`).get(owner, keyOf(repo), prId) as { ticket: string } | undefined;
    return row?.ticket ?? null;
  }
}
