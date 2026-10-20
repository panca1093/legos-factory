import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Everything legos-factory owns: users, workspaces and what belongs to them. Claude transcripts stay in
// Claude's own JSONL files; runs only point at them by session id.

export function factoryDbPath(): string {
  return process.env.LEGOS_DB ?? join(homedir(), '.legos-factory', 'factory.db');
}

export function openDb(path = factoryDbPath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  // holds PIN hashes, OAuth tokens and header secrets; secure_delete zeroes them out of freed pages
  if (path !== ':memory:') chmodSync(path, 0o600);
  renameTable(db, 'user_repos', 'workspace_repos');
  db.exec(`
    pragma secure_delete = on;
    create table if not exists meta (key text primary key, value text not null);
    create table if not exists users (
      id text primary key, kind text not null, name text not null, email text, ext_id text,
      salt text, hash text, created_at text not null);
    create unique index if not exists users_pin_name on users (name collate nocase) where kind = 'pin';
    create unique index if not exists users_ext on users (kind, ext_id) where ext_id is not null;
    create table if not exists workspaces (
      id text primary key, name text not null, kind text not null, created_at text not null);
    create table if not exists workspace_members (
      workspace_id text not null, user_id text not null, role text not null, primary key (workspace_id, user_id));
    create index if not exists workspace_members_user on workspace_members (user_id);
    create table if not exists connections (
      workspace_id text not null, name text not null, data text not null, primary key (workspace_id, name));
    create table if not exists runs (
      run_id text primary key, workspace_id text not null, session_id text, item text not null,
      started_at text not null, last_event_at text not null);
    create table if not exists workspace_repos (
      workspace_id text not null, repo_key text not null, name text not null, main_branch text,
      added_at text not null, jira_projects text not null default '', primary key (workspace_id, repo_key));
    create table if not exists work_items (
      workspace_id text not null, ticket text not null, created_at text not null,
      status text, done integer not null default 0, note text, note_at text, primary key (workspace_id, ticket));
    create table if not exists work_item_repos (
      workspace_id text not null, ticket text not null, repo_key text not null, name text not null,
      added_at text not null, primary key (workspace_id, ticket, repo_key));
    create table if not exists ticket_links (
      workspace_id text not null, ticket text not null, repo_key text not null, kind text not null,
      pr_id integer not null, branch text not null, title text not null, state text not null,
      run_id text, commented integer not null default 0, updated_at text not null,
      primary key (workspace_id, ticket, repo_key, pr_id));
    drop table if exists work_item_events;
    drop table if exists repo_projects;
  `);
  // a user's personal workspace is keyed by the user id, so rows written per user keep their owner
  for (const table of ['connections', 'runs', 'workspace_repos', 'work_items', 'work_item_repos', 'ticket_links']) renameColumn(db, table, 'owner', 'workspace_id');
  db.exec(`
    drop index if exists runs_owner;
    create index if not exists runs_workspace on runs (workspace_id, last_event_at);
  `);
  addColumn(db, 'users', 'active_workspace', 'text');
  // tables made before these columns existed
  addColumn(db, 'workspace_repos', 'jira_projects', `text not null default ''`);
  addColumn(db, 'work_items', 'note', 'text');
  addColumn(db, 'work_items', 'note_at', 'text');
  dropColumn(db, 'ticket_links', 'source');
  return db;
}

function addColumn(db: DatabaseSync, table: string, column: string, type: string) {
  const cols = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`alter table ${table} add column ${column} ${type}`);
}

function renameColumn(db: DatabaseSync, table: string, from: string, to: string) {
  const cols = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === from)) db.exec(`alter table ${table} rename column ${from} to ${to}`);
}

function renameTable(db: DatabaseSync, from: string, to: string) {
  const has = (name: string) => !!db.prepare(`select 1 from sqlite_master where type = 'table' and name = ?`).get(name);
  if (has(from) && !has(to)) db.exec(`alter table ${from} rename to ${to}`);
}

function dropColumn(db: DatabaseSync, table: string, column: string) {
  const cols = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) db.exec(`alter table ${table} drop column ${column}`);
}
