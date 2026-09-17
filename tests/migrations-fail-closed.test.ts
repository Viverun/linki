import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// One temp DB per PROCESS: lib/db.ts caches the connection on first getDb().
// Each scenario that needs a different starting schema runs in a child process.
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "linki-migrations-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const LEGACY_LEDGER_DDL = `CREATE TABLE step_side_effects (
  id TEXT PRIMARY KEY,
  run_profile_id TEXT NOT NULL REFERENCES run_profiles(id) ON DELETE CASCADE,
  track TEXT NOT NULL,
  step_ref TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('message', 'inmail')),
  status TEXT NOT NULL CHECK(status IN ('in_flight', 'confirmed', 'abandoned')),
  body_fingerprint TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  confirmed_at TEXT,
  error_message TEXT
)`;

/** Runs `script` (ESM source) in a fresh Node process against `dbPath`; returns stdout or throws with stderr. */
function child(dbPath: string, script: string): string {
  return execFileSync(process.execPath, [
    "--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning",
    "--import", "./scripts/test-setup.mjs", "--input-type=module", "-e", script,
  ], { env: { ...process.env, LINKI_DB_PATH: dbPath, NEXTAUTH_SECRET: "x" }, encoding: "utf8", stdio: "pipe", timeout: 30_000 });
}

const OPEN_AND_REPORT = `
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='step_side_effects'").get().sql;
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='step_side_effects' ORDER BY name").all().map(r => r.name);
  const rows = db.prepare("SELECT COUNT(*) AS c FROM step_side_effects").get().c;
  console.log(JSON.stringify({ hasEmail: sql.includes("'email'"), idx, rows }));
`;

test("fresh database: ledger accepts 'email' and both indexes exist", () => {
  const out = JSON.parse(child(join(dir, "fresh.db"), OPEN_AND_REPORT));
  assert.equal(out.hasEmail, true);
  assert.deepEqual(out.idx, ["ix_step_side_effects_fingerprint", "sqlite_autoindex_step_side_effects_1", "ux_step_side_effects"]);
});

test("legacy database: ledger is rebuilt with 'email', rows and indexes preserved", () => {
  const dbPath = join(dir, "legacy.db");
  // First boot builds the current schema; then we regress the ledger to the old CHECK by hand.
  child(dbPath, OPEN_AND_REPORT);
  const raw = new Database(dbPath);
  raw.exec("DROP TABLE step_side_effects");
  raw.exec(LEGACY_LEDGER_DDL);
  raw.exec("INSERT INTO run_profiles (id, run_id, target_id) VALUES ('rp1', NULL, NULL)");
  raw.exec("INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, started_at) VALUES ('se1','rp1','linkedin','stepid:s1','t1','message','confirmed','2026-01-01')");
  raw.close();

  const out = JSON.parse(child(dbPath, OPEN_AND_REPORT));
  assert.equal(out.hasEmail, true);
  assert.equal(out.rows, 1);
  assert.deepEqual(out.idx, ["ix_step_side_effects_fingerprint", "sqlite_autoindex_step_side_effects_1", "ux_step_side_effects"]);

  // and an email row is now insertable
  const check = new Database(dbPath);
  check.exec("INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, started_at) VALUES ('se2','rp1','email','stepid:s2','t1','email','in_flight','2026-01-01')");
  check.close();
});

test("a legacy ledger missing a column makes startup fail loudly, and a later boot succeeds once fixed", () => {
  const dbPath = join(dir, "broken.db");
  child(dbPath, OPEN_AND_REPORT);
  const raw = new Database(dbPath);
  raw.exec("DROP TABLE step_side_effects");
  raw.exec(LEGACY_LEDGER_DDL.replace("  attempt_count INTEGER NOT NULL DEFAULT 1,\n", ""));
  raw.close();

  // Boot 1: rebuild's INSERT ... SELECT hits "no such column: attempt_count" → getDb throws, nothing published.
  const script = `
    const { getDb } = await import("@/lib/db");
    let first = null; try { getDb(); } catch (e) { first = e.message; }
    let second = null; try { getDb(); } catch (e) { second = e.message; }
    console.log(JSON.stringify({ first, second }));
  `;
  const out = JSON.parse(child(dbPath, script));
  assert.match(out.first, /no such column: attempt_count/);
  assert.match(out.second, /no such column: attempt_count/, "second call must re-run initialisation, not return a cached half-built handle");

  // Old table must still be intact (transaction rolled back), no *_new leftover.
  const inspect = new Database(dbPath);
  const names = (inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'step_side_effects%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(names, ["step_side_effects"]);
  inspect.exec("ALTER TABLE step_side_effects ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1");
  inspect.close();

  // Boot 2: converges.
  const fixed = JSON.parse(child(dbPath, OPEN_AND_REPORT));
  assert.equal(fixed.hasEmail, true);
});

test("a write lock held by another connection fails startup instead of being swallowed", () => {
  const dbPath = join(dir, "locked.db");
  child(dbPath, OPEN_AND_REPORT);
  // Regress the ledger so a rebuild (a real write) is required on next boot.
  const raw = new Database(dbPath);
  raw.exec("DROP TABLE step_side_effects");
  raw.exec(LEGACY_LEDGER_DDL);
  raw.exec("BEGIN IMMEDIATE"); // hold the write lock for the whole child run
  try {
    const script = `
      const { getDb } = await import("@/lib/db");
      try { getDb(); console.log(JSON.stringify({ ok: true })); } catch (e) { console.log(JSON.stringify({ ok: false, message: e.message })); }
    `;
    const out = JSON.parse(child(dbPath, script));
    assert.equal(out.ok, false);
    assert.match(out.message, /database is locked|SQLITE_BUSY/);
  } finally {
    raw.exec("ROLLBACK");
    raw.close();
  }
  const out = JSON.parse(child(dbPath, OPEN_AND_REPORT));
  assert.equal(out.hasEmail, true);
});

test("a column that already exists is tolerated (duplicate column name)", () => {
  const dbPath = join(dir, "dup.db");
  child(dbPath, OPEN_AND_REPORT);
  // targets.phone is added by migrations[]; on re-boot it is a duplicate → must be tolerated.
  const out = JSON.parse(child(dbPath, OPEN_AND_REPORT));
  assert.equal(out.hasEmail, true);
});
