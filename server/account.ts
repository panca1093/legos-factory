import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

// The local account guarding this app: one name + 6-digit PIN. Sessions are stateless HMAC-signed
// cookies; changing the signing secret signs every browser out.

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const PIN_RE = /^\d{6}$/;
const SESSION_MS = 30 * 24 * 3600_000;
const FREE_TRIES = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;

type Stored = { name: string; salt: string; hash: string; secret: string };

export type LoginResult = { ok: true; cookie: string } | { ok: false; retryAfterMs: number | null };

export function accountPath(): string {
  return process.env.LEGOS_ACCOUNT ?? join(homedir(), '.legos-factory', 'account.json');
}

export class Account {
  private stored: Stored | null = null;
  private loaded = false;
  private failures = 0;
  private lockedUntil = 0;

  constructor(
    private path = accountPath(),
    private now = () => Date.now(),
  ) {}

  private async load(): Promise<Stored | null> {
    if (this.loaded) return this.stored;
    try {
      this.stored = JSON.parse(await readFile(this.path, 'utf8'));
    } catch {
      this.stored = null;
    }
    this.loaded = true;
    return this.stored;
  }

  private async save(s: Stored) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
    this.stored = s;
  }

  async name(): Promise<string | null> {
    return (await this.load())?.name ?? null;
  }

  // First run only: there is no way to overwrite an existing account from the API.
  async setup(name: string, pin: string): Promise<string> {
    if (await this.load()) throw new Error('account already exists');
    if (!PIN_RE.test(pin)) throw new Error('PIN must be 6 digits');
    const salt = randomBytes(16);
    const hash = await scryptAsync(pin, salt, 32, SCRYPT);
    await this.save({ name, salt: salt.toString('base64'), hash: hash.toString('base64'), secret: randomBytes(32).toString('base64') });
    return this.issue();
  }

  // A 6-digit PIN is only 1e6 guesses: after FREE_TRIES misses each further try doubles the lockout.
  async login(pin: string): Promise<LoginResult> {
    const s = await this.load();
    if (!s) return { ok: false, retryAfterMs: null };
    const wait = this.lockedUntil - this.now();
    if (wait > 0) return { ok: false, retryAfterMs: wait };
    const hash = PIN_RE.test(pin) ? await scryptAsync(pin, Buffer.from(s.salt, 'base64'), 32, SCRYPT) : Buffer.alloc(32);
    if (PIN_RE.test(pin) && timingSafeEqual(hash, Buffer.from(s.hash, 'base64'))) {
      this.failures = 0;
      this.lockedUntil = 0;
      return { ok: true, cookie: this.issue() };
    }
    this.failures++;
    if (this.failures >= FREE_TRIES) {
      this.lockedUntil = this.now() + Math.min(BASE_LOCK_MS * 2 ** (this.failures - FREE_TRIES), MAX_LOCK_MS);
      return { ok: false, retryAfterMs: this.lockedUntil - this.now() };
    }
    return { ok: false, retryAfterMs: null };
  }

  private sign(payload: string): string {
    return createHmac('sha256', Buffer.from(this.stored!.secret, 'base64')).update(payload).digest('base64url');
  }

  private issue(): string {
    const payload = `v1.${this.now() + SESSION_MS}`;
    return `${payload}.${this.sign(payload)}`;
  }

  async verify(cookie: string | undefined): Promise<boolean> {
    if (!cookie || !(await this.load())) return false;
    const m = cookie.match(/^(v1\.(\d+))\.([\w-]+)$/);
    if (!m || Number(m[2]) < this.now()) return false;
    const want = Buffer.from(this.sign(m[1]));
    const got = Buffer.from(m[3]);
    return want.length === got.length && timingSafeEqual(want, got);
  }
}
