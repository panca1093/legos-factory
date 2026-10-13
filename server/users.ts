import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

// Who may use this app. Two separate kinds of user: local ones (name + 6-digit PIN) and ones that
// signed in with workbench. Sessions are stateless HMAC-signed cookies naming the user.

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const PIN_RE = /^\d{6}$/;
const SESSION_MS = 30 * 24 * 3600_000;
const FREE_TRIES = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
const COOKIE_RE = /^(v2\.([0-9a-f-]{36})\.(\d+))\.([\w-]+)$/;

export type UserKind = 'pin' | 'workbench';
export type User = { id: string; kind: UserKind; name: string; email: string | null };
export type LoginResult = { ok: true; cookie: string } | { ok: false; retryAfterMs: number | null };

type Row = User & { salt: string | null; hash: string | null };

export class Users {
  private secret: Buffer;
  private misses = new Map<string, { failures: number; lockedUntil: number }>();

  constructor(
    private db: DatabaseSync,
    private now = () => Date.now(),
  ) {
    const row = db.prepare(`select value from meta where key = 'session_secret'`).get() as { value: string } | undefined;
    if (row) this.secret = Buffer.from(row.value, 'base64');
    else {
      this.secret = randomBytes(32);
      db.prepare(`insert into meta (key, value) values ('session_secret', ?)`).run(this.secret.toString('base64'));
    }
  }

  private row(where: string, ...args: string[]): Row | null {
    return (this.db.prepare(`select id, kind, name, email, salt, hash from users where ${where}`).get(...args) as Row | undefined) ?? null;
  }

  private toUser(r: Row): User {
    return { id: r.id, kind: r.kind, name: r.name, email: r.email };
  }

  // Names on the PIN sign-in screen; this is a local app, so they are not secret.
  pinNames(): string[] {
    return (this.db.prepare(`select name from users where kind = 'pin' order by name collate nocase`).all() as { name: string }[]).map((r) => r.name);
  }

  get(id: string): User | null {
    const r = this.row('id = ?', id);
    return r && this.toUser(r);
  }

  async createPin(name: string, pin: string): Promise<{ user: User; cookie: string }> {
    if (!PIN_RE.test(pin)) throw new Error('PIN must be 6 digits');
    if (this.row(`kind = 'pin' and name = ? collate nocase`, name)) throw new Error(`a user named ${name} already exists`);
    const salt = randomBytes(16);
    const hash = await scryptAsync(pin, salt, 32, SCRYPT);
    const user: User = { id: randomUUID(), kind: 'pin', name, email: null };
    this.db
      .prepare(`insert into users (id, kind, name, salt, hash, created_at) values (?, 'pin', ?, ?, ?, ?)`)
      .run(user.id, name, salt.toString('base64'), hash.toString('base64'), new Date(this.now()).toISOString());
    return { user, cookie: this.issue(user.id) };
  }

  // A 6-digit PIN is only 1e6 guesses: after FREE_TRIES misses on a name each further try doubles its lockout.
  async loginPin(name: string, pin: string): Promise<LoginResult> {
    const key = name.toLowerCase();
    const m = this.misses.get(key) ?? { failures: 0, lockedUntil: 0 };
    const wait = m.lockedUntil - this.now();
    if (wait > 0) return { ok: false, retryAfterMs: wait };
    const r = this.row(`kind = 'pin' and name = ? collate nocase`, name);
    // unknown names cost the same scrypt and count misses too, so they look like wrong PINs
    const salt = r?.salt ? Buffer.from(r.salt, 'base64') : Buffer.alloc(16);
    const hash = await scryptAsync(PIN_RE.test(pin) ? pin : '', salt, 32, SCRYPT);
    if (r?.hash && PIN_RE.test(pin) && timingSafeEqual(hash, Buffer.from(r.hash, 'base64'))) {
      this.misses.delete(key);
      return { ok: true, cookie: this.issue(r.id) };
    }
    m.failures++;
    this.misses.set(key, m);
    if (m.failures < FREE_TRIES) return { ok: false, retryAfterMs: null };
    m.lockedUntil = this.now() + Math.min(BASE_LOCK_MS * 2 ** (m.failures - FREE_TRIES), MAX_LOCK_MS);
    return { ok: false, retryAfterMs: m.lockedUntil - this.now() };
  }

  // Signed in elsewhere (workbench): one user per external id, name and email kept current.
  upsertExternal(kind: Exclude<UserKind, 'pin'>, extId: string, name: string, email: string | null): User {
    const r = this.row('kind = ? and ext_id = ?', kind, extId);
    if (r) {
      this.db.prepare(`update users set name = ?, email = ? where id = ?`).run(name, email, r.id);
      return { ...this.toUser(r), name, email };
    }
    const user: User = { id: randomUUID(), kind, name, email };
    this.db
      .prepare(`insert into users (id, kind, name, email, ext_id, created_at) values (?, ?, ?, ?, ?, ?)`)
      .run(user.id, kind, name, email, extId, new Date(this.now()).toISOString());
    return user;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issue(userId: string): string {
    const payload = `v2.${userId}.${this.now() + SESSION_MS}`;
    return `${payload}.${this.sign(payload)}`;
  }

  verify(cookie: string | undefined): User | null {
    const m = cookie?.match(COOKIE_RE);
    if (!m || Number(m[3]) < this.now()) return null;
    const want = Buffer.from(this.sign(m[1]));
    const got = Buffer.from(m[4]);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    return this.get(m[2]);
  }
}
