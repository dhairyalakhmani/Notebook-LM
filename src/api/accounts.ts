import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import * as config from "../config.ts";
import { isSafeUsername } from "./paths.ts";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// scrypt needs 128 * N * r bytes, which at N=2^15, r=8 is exactly 32 MiB - and
// Node's default maxmem cap is 32 MiB, so it refuses with "memory limit
// exceeded" unless the ceiling is raised explicitly.
function maxmemFor(n: number, r: number): number {
  return Math.max(32 * 1024 * 1024, 256 * n * r);
}

// Memory-hard parameters, so a stolen database is expensive to attack. N is
// the cost knob; 2^15 costs ~32 MB and ~50-100ms per hash, which is
// imperceptible on a login and painful in bulk.
const SCRYPT = { N: 32768, r: 8, p: 1 };
const KEY_BYTES = 64;
const SALT_BYTES = 16;

const DB_FILENAME = "accounts.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  name        TEXT PRIMARY KEY,
  password    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user        TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user);
`;

export const SESSION_COOKIE = "notebook_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface Session {
  user: string;
  createdAt: string;
}

/** Stored as scrypt$N$r$p$salt$key, so the cost can change without a migration. */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES, {
    ...SCRYPT,
    maxmem: maxmemFor(SCRYPT.N, SCRYPT.r),
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, key] = parts;
  const expected = Buffer.from(key!, "base64");
  let actual: Buffer;
  try {
    // Cost parameters come from the stored hash, so raising them later does
    // not invalidate existing passwords.
    actual = await scrypt(password, Buffer.from(salt!, "base64"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: maxmemFor(Number(n), Number(r)),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Only the hash of a token is stored, so reading the database does not hand
// anyone a usable session.
function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class AccountStore {
  private db: DatabaseSync;

  constructor(storageDir: string = config.STORAGE_DIR) {
    mkdirSync(storageDir, { recursive: true });
    this.db = new DatabaseSync(join(storageDir, DB_FILENAME));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return row.n;
  }

  exists(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM users WHERE name = ?").get(name) !== undefined;
  }

  async create(name: string, password: string): Promise<void> {
    const password_hash = await hashPassword(password);
    this.db
      .prepare("INSERT INTO users (name, password, created_at) VALUES (?, ?, ?)")
      .run(name, password_hash, new Date().toISOString());
  }

  /**
   * Verifies a password. Runs the hash even for an unknown user, so the reply
   * takes the same time either way and cannot be used to enumerate accounts.
   */
  async verify(name: string, password: string): Promise<boolean> {
    const row = this.db.prepare("SELECT password FROM users WHERE name = ?").get(name) as
      { password: string } | undefined;
    if (!row) {
      await hashPassword(password);
      return false;
    }
    return verifyPassword(password, row.password);
  }

  issueSession(name: string, now: number = Date.now()): string {
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash, user, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        tokenHash(token),
        name,
        new Date(now).toISOString(),
        new Date(now + SESSION_TTL_MS).toISOString(),
      );
    return token;
  }

  resolveSession(token: string, now: number = Date.now()): Session | null {
    const row = this.db
      .prepare("SELECT user, created_at, expires_at FROM sessions WHERE token_hash = ?")
      .get(tokenHash(token)) as
      { user: string; created_at: string; expires_at: string } | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= now) {
      this.revokeSession(token);
      return null;
    }
    return { user: row.user, createdAt: row.created_at };
  }

  revokeSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  /** Every session for one account: what "log out everywhere" would use. */
  revokeAllFor(name: string): number {
    const result = this.db.prepare("DELETE FROM sessions WHERE user = ?").run(name);
    return Number(result.changes);
  }

  sweepSessions(now: number = Date.now()): number {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE expires_at <= ?")
      .run(new Date(now).toISOString());
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Login throttling, in memory and per account name.
 *
 * A public login form is the one route an attacker can hammer, and hashing is
 * deliberately slow, so unlimited attempts are both a guessing risk and a way
 * to exhaust the CPU. Delay grows with consecutive failures and resets on
 * success.
 */
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const failures = new Map<string, { count: number; first: number; until: number }>();

export function throttleFor(key: string, now: number = Date.now()): number {
  const record = failures.get(key);
  if (!record) return 0;
  if (now - record.first > FAILURE_WINDOW_MS) {
    failures.delete(key);
    return 0;
  }
  return Math.max(0, record.until - now);
}

export function recordFailure(key: string, now: number = Date.now()): void {
  const record = failures.get(key);
  if (!record || now - record.first > FAILURE_WINDOW_MS) {
    failures.set(key, { count: 1, first: now, until: 0 });
    return;
  }
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    // 2s, 4s, 8s ... capped at five minutes.
    const penalty = Math.min(300_000, 2000 * 2 ** (record.count - MAX_ATTEMPTS));
    record.until = now + penalty;
  }
}

export function clearFailures(key: string): void {
  failures.delete(key);
}

export function resetThrottle(): void {
  failures.clear();
}

export { hashPassword, verifyPassword, isSafeUsername };
