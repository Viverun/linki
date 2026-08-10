import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-watchdog-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-watchdog-tests";

// P2-1 REPRODUCTION, then the fix.
//
// F8's fatal path is getDb() at the top of globalLoop, outside the while. Phase 1
// made that self-retry, but nothing POLLS liveness: if the loop exits for any
// other reason, ensureGlobalRunnerStarted() has exactly two callers
// (instrumentation at boot, runs/[id]/start on operator action) and neither runs
// on a timer. NF-6.

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { exports: Record<string, unknown> }) => void;

const realDb = await import("@/lib/db");
let dbThrows = false;
let getDbCalls = 0;
mockModule("@/lib/db", {
  exports: {
    ...realDb,
    getDb: () => { getDbCalls++; if (dbThrows) throw new Error("SQLITE_CANTOPEN"); return realDb.getDb(); },
  },
});

const runner = await import("@/lib/linkedin/runner");

after(() => {
  try { realDb.getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

const db = realDb.getDb();
const setMarker = (iso: string | null) => {
  if (iso === null) { db.prepare("DELETE FROM app_settings WHERE key = 'runner_progress_at'").run(); return; }
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('runner_progress_at', ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(iso);
};
const fresh = () => new Date().toISOString();
const stale = () => new Date(Date.now() - 11 * 60_000).toISOString();
const revivals = () =>
  parseInt((db.prepare("SELECT value FROM app_settings WHERE key = 'runner_revivals'").get() as { value: string } | undefined)?.value ?? "0", 10);

// ─── reproduction ────────────────────────────────────────────────────────────

test("P2-1 repro: nothing polls liveness — a stale marker triggers no revive on its own", () => {
  // The whole of Phase 1's liveness machinery is observational. Prove it: with a
  // marker 11 minutes old and no loop running, no code path in the process acts.
  setMarker(stale());
  const before = getDbCalls;

  // Simulate the passage of time with no external actor: nothing to call.
  // If a watchdog existed, this is where it would have fired.
  assert.equal(getDbCalls, before, "no in-process actor polls the marker");
  assert.equal(typeof (runner as Record<string, unknown>).startRunnerWatchdog, "function",
    "a watchdog must exist and be registerable independently of the loop");
});

// ─── after the fix ───────────────────────────────────────────────────────────
// Ordering is deliberate. Once a revive succeeds the loop is running, and the
// watchdog must then refuse to start a second one — so the "does not fire"
// cases run first, and the one revive that does happen is asserted last.
// dbThrows keeps that loop in its recovery path, whose backoff sleep is unref'd,
// so a live test loop can never hold the process open.

test("P2-1: the watchdog NEVER fires while work is progressing", () => {
  // The load-bearing invariant: a fresh progress marker means a step is
  // advancing, because markers are written at every executeStep boundary. So a
  // stale marker cannot mean "busy" — the watchdog never races live LinkedIn
  // work. If this ever fires on a busy instance it is a P0.
  setMarker(fresh());
  const before = revivals();
  assert.equal(runner.runnerWatchdogTick(db), false, "a busy runner must never be revived");
  assert.equal(revivals(), before, "and no intervention is recorded");
});

test("P2-1: a marker just inside the threshold does not fire", () => {
  setMarker(new Date(Date.now() - (runner.WATCHDOG_STALE_MS - 5_000)).toISOString());
  assert.equal(runner.runnerWatchdogTick(db), false, "9m55s is still alive");
});

test("P2-1: a watchdog failure can never propagate", () => {
  const broken = { prepare: () => { throw new Error("db gone"); } } as unknown as typeof db;
  assert.doesNotThrow(() => runner.runnerWatchdogTick(broken));
});

test("P2-1: an absent marker counts as dead and revives, counting the intervention", () => {
  dbThrows = true;                    // keep the revived loop in its unref'd retry path
  setMarker(null);
  const before = revivals();
  assert.equal(runner.runnerWatchdogTick(db), true, "no marker at all = the loop never started");
  assert.equal(revivals(), before + 1, "the intervention is counted, not silent");
  assert.equal(runner.runnerState().running, true, "a loop is now up");
});

test("P2-1: with a loop already running, a stale marker does NOT start a second", () => {
  assert.equal(runner.runnerState().running, true, "precondition: from the previous test");
  setMarker(stale());
  const before = revivals();
  assert.equal(runner.runnerWatchdogTick(db), false, "the running guard wins over staleness");
  assert.equal(revivals(), before, "no phantom intervention recorded");
});

test("P2-1: concurrent watchdog + start.ts revive attempts produce exactly ONE loop", async () => {
  setMarker(stale());
  const before = getDbCalls;
  for (let i = 0; i < 10; i++) { runner.runnerWatchdogTick(db); runner.ensureGlobalRunnerStarted(); }
  await new Promise(r => setTimeout(r, 50));
  assert.ok(getDbCalls - before <= 1, `exactly one loop may exist; saw ${getDbCalls - before} acquisitions`);
});
