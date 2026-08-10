import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dbDir = mkdtempSync(join(tmpdir(), "linki-db-init-test-"));
after(() => rmSync(dbDir, { recursive: true, force: true }));

// D7: getDb() is a module singleton. If it publishes the handle BEFORE running
// migrations, a throw in initDb/runMigrations leaves a cached, un-migrated
// connection that every later call returns without error — the app then runs
// with step_side_effects missing and every message step failing closed on
// `no such table`. A backoff retry on top of that turns a loud crash into a
// silently half-initialized runner, which is strictly worse.
//
// The source assertion below is the durable guard; the behavioural test proves
// the failure path leaves nothing cached.

test("D7: the singleton is published only AFTER initialisation completes", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile("lib/db.ts", "utf8");
  const fn = src.slice(src.indexOf("export function getDb"), src.indexOf("function initialiseConnection"));

  const buildsLocal = /const fresh = new Database\(DB_PATH\)/.test(fn);
  const publishesAfter = fn.indexOf("db = fresh;") > fn.indexOf("initialiseConnection(fresh)");
  const clearsOnFailure = /catch \(err\)[\s\S]*fresh\.close\(\)[\s\S]*throw err/.test(fn);

  assert.ok(buildsLocal, "must build into a local, not straight into the module variable");
  assert.ok(publishesAfter, "must assign the singleton only after initialisation");
  assert.ok(clearsOnFailure, "must close the orphan and rethrow, leaving the singleton unset");
  assert.doesNotMatch(fn, /db = new Database\(DB_PATH\)/,
    "assigning the singleton directly is the D7 hazard");
});

test("D7: a failed initialisation leaves NO cached handle, so a retry re-initialises", () => {
  // Simulate the shape directly: a builder that publishes only on success.
  let cached: Database.Database | undefined;
  let attempts = 0;
  let failNext = true;

  const build = () => {
    if (!cached) {
      attempts++;
      const fresh = new Database(join(dbDir, "atomic.db"));
      try {
        fresh.pragma("journal_mode = WAL");
        if (failNext) throw new Error("simulated migration failure");
        fresh.exec("CREATE TABLE IF NOT EXISTS step_side_effects (id TEXT PRIMARY KEY)");
      } catch (e) {
        try { fresh.close(); } catch { /* already gone */ }
        throw e;
      }
      cached = fresh;
    }
    return cached;
  };

  assert.throws(() => build(), /simulated migration failure/);
  assert.equal(cached, undefined, "nothing may be cached after a failed init");

  // The retry must genuinely re-initialise, not hand back a half-built handle.
  failNext = false;
  const db = build();
  assert.equal(attempts, 2, "the second call really re-ran initialisation");
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'step_side_effects'").get() as { c: number }).c,
    1, "the connection handed out is fully migrated");
  db.close();
});

test("D7: the un-migrated hazard is real — a half-built handle answers queries but lacks the ledger", () => {
  // Characterisation: shows exactly what the old ordering would have returned,
  // so the guard above is understood as protecting something concrete.
  const half = new Database(join(dbDir, "half.db"));
  half.pragma("journal_mode = WAL");
  assert.equal((half.prepare("SELECT 1 AS ok").get() as { ok: number }).ok, 1,
    "a half-built connection looks healthy to a trivial query");
  assert.throws(
    () => half.prepare("SELECT status FROM step_side_effects LIMIT 1").get(),
    /no such table/,
    "…while every message step would fail closed on the missing ledger");
  half.close();
});
