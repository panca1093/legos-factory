import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Everything legos-factory owns: users, their connections and their runs. Claude transcripts stay in
// Claude's own JSONL files; runs only point at them by session id.

export function factoryDbPath(): string {
  return process.env.LEGOS_DB ?? join(homedir(), '.legos-factory', 'factory.db');
}

export function openDb(path = factoryDbPath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  // holds PIN hashes, OAuth tokens and header secrets; secure_delete zeroes them out of freed pages
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec(`
    pragma secure_delete = on;
    create table if not exists meta (key text primary key, value text not null);
    create table if not exists users (
      id text primary key, kind text not null, name text not null, email text, ext_id text,
      salt text, hash text, created_at text not null);
    create unique index if not exists users_pin_name on users (name collate nocase) where kind = 'pin';
    create unique index if not exists users_ext on users (kind, ext_id) where ext_id is not null;
    create table if not exists connections (
      owner text not null, name text not null, data text not null, primary key (owner, name));
    create table if not exists runs (
      run_id text primary key, owner text not null, session_id text, item text not null,
      started_at text not null, last_event_at text not null);
    create index if not exists runs_owner on runs (owner, last_event_at);
    create table if not exists user_repos (
      owner text not null, repo_key text not null, name text not null, main_branch text,
      added_at text not null, primary key (owner, repo_key));
  `);
  return db;
}
