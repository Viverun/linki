import type Database from "better-sqlite3";
import { RUNNER_OWNER, parseRunnerLease } from "@/lib/runner-identity";

// RUNNER_OWNER lives in lib/runner-identity.ts — a dependency-free leaf that
// pages/api/health.ts can import without reaching into lib/linkedin/ (see the
// ISOLATION INVARIANT in tests/health-isolation.test.ts). Re-exported here so
// every existing `import { RUNNER_OWNER } from "@/lib/linkedin/lease"` keeps working.
export { RUNNER_OWNER };

/**
 * Runner lease (C2-B1 / PR-09).
 *
 * The loop guard, the watchdog and the import flag are per-process globals, so a
 * second process (replica, PM2 cluster, a second container on the same volume)
 * silently yields two runners driving one LinkedIn account. This lease lives in
 * the database and is the only thing that decides who the runner is. Every
 * track-state write goes through withLease(), so a process that lost the lease
 * mid-step cannot write stale state either.
 */
export const LEASE_KEY = "runner_lease";
/**
 * Matches WATCHDOG_STALE_MS / LIVENESS_THRESHOLD_MS's worst-single-step budget
 * (docs/phase1-baseline.md: ~345s worst step + ~20s randomDelay margin, 600s
 * threshold). A tick can run many tracks back to back and only renews the lease
 * (see withLease below) between steps, so the TTL must outlast the single
 * longest step a tick can be mid-way through, not just the poll interval —
 * 120_000 was short enough that a healthy solo process could lose its own
 * lease mid-step and start refusing its own writes.
 */
export const LEASE_TTL_MS = 600_000;

export class LeaseLostError extends Error {
  constructor(owner: string, holder: string | null) {
    super(`runner lease not held by ${owner} (holder: ${holder ?? "none"})`);
  }
}

export function readRunnerLease(db: Database.Database): { owner: string; expires_at: string } | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(LEASE_KEY) as { value: string } | undefined;
  return parseRunnerLease(row?.value);
}

function write(db: Database.Database, owner: string, expiresAtMs: number) {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(LEASE_KEY, JSON.stringify({ owner, expires_at: new Date(expiresAtMs).toISOString() }));
}

/** Take the lease if absent, expired, or already ours. One IMMEDIATE transaction. */
export function acquireRunnerLease(db: Database.Database, owner = RUNNER_OWNER, ttlMs = LEASE_TTL_MS, now = Date.now()): boolean {
  return db.transaction(() => {
    const current = readRunnerLease(db);
    if (current && current.owner !== owner && Date.parse(current.expires_at) > now) return false;
    write(db, owner, now + ttlMs);
    return true;
  }).immediate();
}

export function holdsRunnerLease(db: Database.Database, owner = RUNNER_OWNER, now = Date.now()): boolean {
  const current = readRunnerLease(db);
  return !!current && current.owner === owner && Date.parse(current.expires_at) > now;
}

/**
 * Runs fn inside an IMMEDIATE transaction only if the lease is held; otherwise
 * throws before fn. Renews the lease (extends expires_at to now + LEASE_TTL_MS)
 * before running fn, so every fenced write doubles as a heartbeat — a tick that
 * keeps writing never lets its own lease lapse mid-step (R4).
 */
export function withLease<T>(db: Database.Database, fn: () => T, owner = RUNNER_OWNER, now = Date.now()): T {
  return db.transaction(() => {
    if (!holdsRunnerLease(db, owner, now)) throw new LeaseLostError(owner, readRunnerLease(db)?.owner ?? null);
    write(db, owner, now + LEASE_TTL_MS);
    return fn();
  }).immediate();
}

export function releaseRunnerLease(db: Database.Database, owner = RUNNER_OWNER): void {
  db.transaction(() => {
    const current = readRunnerLease(db);
    if (current?.owner === owner) db.prepare("DELETE FROM app_settings WHERE key = ?").run(LEASE_KEY);
  }).immediate();
}
