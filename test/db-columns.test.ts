import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '../server/db.ts';

function seed(db: DatabaseSync) {
  db.exec(`
    insert into work_items (owner, ticket, created_at) values ('u1', 'PROJ-123', '2026-01-01');
    insert into work_item_repos (owner, ticket, repo_key, name, added_at)
      values ('u1', 'PROJ-123', 'acme/api', 'acme/api', '2026-01-01');
    insert into runs (run_id, owner, item, started_at, last_event_at)
      values ('r1', 'u1', '{}', '2026-01-01', '2026-01-01');
  `);
}

function checkColumns(db: DatabaseSync) {
  expect(db.prepare('pragma table_info(work_items)').all()).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'source', type: 'TEXT', notnull: 1, dflt_value: "'jira'" }),
    expect.objectContaining({ name: 'plan', type: 'TEXT', notnull: 0, dflt_value: null }),
  ]));
  expect(db.prepare('pragma table_info(work_item_repos)').all()).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'stage', type: 'TEXT', notnull: 1, dflt_value: "'building'" }),
    expect.objectContaining({ name: 'attempt', type: 'INTEGER', notnull: 1, dflt_value: '0' }),
  ]));
  expect(db.prepare('pragma table_info(runs)').all()).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'task', type: 'TEXT', notnull: 0, dflt_value: null }),
    expect.objectContaining({ name: 'persona', type: 'TEXT', notnull: 0, dflt_value: null }),
  ]));
  expect(db.prepare('select ticket, source, plan from work_items').get()).toEqual({ ticket: 'PROJ-123', source: 'jira', plan: null });
  expect(db.prepare('select repo_key, stage, attempt from work_item_repos').get()).toEqual({ repo_key: 'acme/api', stage: 'building', attempt: 0 });
  expect(db.prepare('select run_id, task, persona from runs').get()).toEqual({ run_id: 'r1', task: null, persona: null });

  db.exec(`
    update work_items set source = 'local', plan = '{"tasks":[],"error":null}';
    update work_item_repos set stage = 'spec_review', attempt = 2;
    update runs set task = 'T1', persona = 'builder';
  `);
  expect(db.prepare('select source, plan from work_items').get()).toEqual({ source: 'local', plan: '{"tasks":[],"error":null}' });
  expect(db.prepare('select stage, attempt from work_item_repos').get()).toEqual({ stage: 'spec_review', attempt: 2 });
  expect(db.prepare('select task, persona from runs').get()).toEqual({ task: 'T1', persona: 'builder' });
}

function foreignFamily(dir: string): string {
  const path = join(dir, 'factory.db');
  const foreign = new DatabaseSync(path);
  foreign.exec(`
    create table workspaces (workspace_id text primary key, name text not null);
    create table runs (
      workspace_id text not null, run_id text primary key, session_id text, item text not null,
      started_at text not null, last_event_at text not null);
    create table jobs (job_id text primary key, workspace_id text not null, state text not null);
  `);
  foreign.close();
  return path;
}

describe('database columns', () => {
  it('refuses a database created by a different schema family', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-db-foreign-'));
    try {
      const path = foreignFamily(dir);
      const attempt = () => openDb(path);
      expect(attempt).toThrow(/not a legos-factory database/);
      expect(attempt).toThrow(/move.*aside/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the file and the column that does not fit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-db-foreign-'));
    try {
      const path = foreignFamily(dir);
      const attempt = () => openDb(path);
      expect(attempt).toThrow(dir);
      expect(attempt).toThrow('"owner"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds the new columns to a fresh database', () => {
    const db = openDb(':memory:');
    try {
      seed(db);
      checkColumns(db);
    } finally {
      db.close();
    }
  });

  it('adds the new columns to a database created before them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-db-columns-'));
    const path = join(dir, 'factory.db');
    const old = new DatabaseSync(path);
    old.exec(`
      create table work_items (
        owner text not null, ticket text not null, created_at text not null,
        status text, done integer not null default 0, note text, note_at text, primary key (owner, ticket));
      create table work_item_repos (
        owner text not null, ticket text not null, repo_key text not null, name text not null,
        added_at text not null, primary key (owner, ticket, repo_key));
      create table runs (
        run_id text primary key, owner text not null, session_id text, item text not null,
        started_at text not null, last_event_at text not null);
    `);
    seed(old);
    old.close();
    const db = openDb(path);
    try {
      checkColumns(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
