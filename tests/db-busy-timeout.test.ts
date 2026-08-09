import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dbDir = mkdtempSync(join(tmpdir(), "linki-busy-test-"));
after(() => rmSync(dbDir, { recursive: true, force: true }));

// NOTE ON WHAT THESE TESTS ACTUALLY ESTABLISH
//
// The Phase 1 audit recorded F3 as "SQLite has no busy_timeout", inferred from a
// repo-wide grep for the pragma. That inference is WRONG: better-sqlite3 applies
// `busy_timeout` from its `timeout` constructor option, which defaults to 5000ms
// (node_modules/better-sqlite3/lib/database.js:34). Every connection in this
// repo — including read-only ones — has therefore always had a 5s busy timeout.
//
// The explicit pragma in lib/db.ts is consequently a no-op for behaviour. It is
// kept as a guard: it pins the value at the point of use, so a future
// `{ timeout: 0 }`, a library default change, or a connection opened elsewhere
// cannot silently remove the protection the runner's bookkeeping relies on.
// These tests assert that reality rather than the audit's claim.

function open(path: string, opts: { timeout?: number } = {}) {
  const db = new Database(path, opts);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

test("better-sqlite3 already defaults busy_timeout to 5000 — the audit's F3 premise was wrong", () => {
  const path = join(dbDir, "default.db");
  const db = new Database(path);
  assert.equal(db.pragma("busy_timeout", { simple: true }), 5000,
    "a bare `new Database()` is already protected; F3 as written does not reproduce");
  db.close();

  const off = new Database(path, { timeout: 0 });
  assert.equal(off.pragma("busy_timeout", { simple: true }), 0,
    "and it CAN be turned off via the constructor — which is what the explicit pragma guards against");
  off.close();
});

test("lib/db.ts sets busy_timeout explicitly, BEFORE initDb and runMigrations", async () => {
  // Ordering is the part that matters even though the value is unchanged: the
  // migration loop swallows every error (`try { db.exec(sql) } catch {}`), so a
  // lock error raised inside CREATE TABLE would be discarded and the app would
  // boot with step_side_effects missing and the duplicate-message guard absent.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile("lib/db.ts", "utf8");
  const busyAt = src.indexOf("busy_timeout");
  const initAt = src.indexOf("initDb(db);");
  const migrateAt = src.indexOf("runMigrations(db);");
  assert.ok(busyAt > 0, "pragma present");
  assert.ok(busyAt < initAt, "precedes initDb");
  assert.ok(busyAt < migrateAt, "precedes runMigrations");
});

test("THE GUARD: the shared connection's EFFECTIVE busy_timeout equals BUSY_TIMEOUT_MS", async () => {
  // This is the test with teeth. The two lock tests below are documentation;
  // this one fails if anyone opens the shared connection with { timeout: 0 },
  // lowers the pragma, or a library bump changes the default out from under us.
  // It reads the effective value off the live connection, not the source.
  const prev = process.env.LINKI_DB_PATH;
  process.env.LINKI_DB_PATH = join(dbDir, "real.db");
  const { getDb, BUSY_TIMEOUT_MS } = await import("@/lib/db");
  const db = getDb();

  assert.equal(BUSY_TIMEOUT_MS, 5000, "pinned to the library default so it stays a no-op");
  assert.equal(db.pragma("busy_timeout", { simple: true }), BUSY_TIMEOUT_MS,
    "effective timeout on the real connection must equal the constant");
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);

  if (prev === undefined) delete process.env.LINKI_DB_PATH; else process.env.LINKI_DB_PATH = prev;
});

test("a lock held LONGER than the timeout still surfaces a clean SQLITE_BUSY", () => {
  // The protection is a wait, not immunity. Contention beyond the window must
  // still raise cleanly rather than hang or corrupt — this is the case the
  // runner's post-send bookkeeping can still hit, and why that region is
  // wrapped so a delivered message is never recorded as a failure.
  const path = join(dbDir, "exceed.db");
  const setup = open(path);
  setup.exec("CREATE TABLE t (v TEXT)");
  setup.close();

  const holder = open(path);
  holder.exec("BEGIN IMMEDIATE");
  holder.prepare("INSERT INTO t (v) VALUES (?)").run("holder");

  const writer = open(path, { timeout: 100 });
  const start = Date.now();
  assert.throws(
    () => writer.prepare("INSERT INTO t (v) VALUES (?)").run("second"),
    /SQLITE_BUSY|database is locked/i
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 90, `must have waited out the timeout before raising, waited ${elapsed}ms`);

  holder.exec("ROLLBACK"); holder.close(); writer.close();
});

test("with the timeout disabled, the same contention throws immediately — the control", () => {
  // Proves the lock in the test above is genuinely held. Without this, an
  // assertion that a writer 'waited' could pass simply because nothing blocked.
  const path = join(dbDir, "control.db");
  const setup = open(path);
  setup.exec("CREATE TABLE t (v TEXT)");
  setup.close();

  const holder = open(path);
  holder.exec("BEGIN IMMEDIATE");
  holder.prepare("INSERT INTO t (v) VALUES (?)").run("holder");

  const writer = open(path, { timeout: 0 });
  const start = Date.now();
  assert.throws(() => writer.prepare("INSERT INTO t (v) VALUES (?)").run("second"), /SQLITE_BUSY|locked/i);
  assert.ok(Date.now() - start < 500, "with timeout 0 it rejects on contact");

  holder.exec("ROLLBACK"); holder.close(); writer.close();
});

test("migrations complete on a connection carrying the timeout", () => {
  const path = join(dbDir, "migrate.db");
  const migrator = open(path, { timeout: 5000 });
  assert.equal(migrator.pragma("busy_timeout", { simple: true }), 5000);
  assert.doesNotThrow(() => {
    migrator.exec(`CREATE TABLE IF NOT EXISTS step_side_effects (
      id TEXT PRIMARY KEY, run_profile_id TEXT NOT NULL, track TEXT NOT NULL,
      step_ref TEXT NOT NULL, target_id TEXT NOT NULL, action TEXT NOT NULL,
      status TEXT NOT NULL, body_fingerprint TEXT, attempt_count INTEGER NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL, confirmed_at TEXT, error_message TEXT)`);
  });
  assert.equal(
    (migrator.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'step_side_effects'").get() as { c: number }).c,
    1, "a swallowed migration would leave this at 0");
  migrator.close();
});

test("read-only connections carry the same default and are unaffected", () => {
  const path = join(dbDir, "ro.db");
  const setup = open(path);
  setup.exec("CREATE TABLE t (v TEXT)");
  setup.prepare("INSERT INTO t (v) VALUES ('x')").run();
  setup.close();

  const ro = new Database(path, { readonly: true });
  assert.equal(ro.pragma("busy_timeout", { simple: true }), 5000);
  assert.equal((ro.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c, 1);
  ro.close();
});
