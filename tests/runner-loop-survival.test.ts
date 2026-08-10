import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-loop-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-loop-tests";

// F8 REPRODUCTION — measured, not inferred from reading `.catch()`.
//
// The audit claimed globalLoop()'s outer .catch() logs and stops the runner
// forever. That is true of the mechanism; the question D3 forces is whether it
// is REACHABLE, because two findings have already fallen to "the code looks
// like X" without measurement.

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { exports: Record<string, unknown> }) => void;

const realDb = await import("@/lib/db");

/** Flip to make getDb() throw — the one call inside globalLoop that is NOT
 *  wrapped in a try/catch (runner.ts:1275, before the while loop). */
let dbThrows = false;
let getDbCalls = 0;

mockModule("@/lib/db", {
  exports: {
    ...realDb,
    getDb: () => {
      getDbCalls++;
      if (dbThrows) throw new Error("SQLITE_CANTOPEN: unable to open database file");
      return realDb.getDb();
    },
  },
});

const runner = await import("@/lib/linkedin/runner");

after(() => {
  try { realDb.getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

test("F8 repro: every await INSIDE the loop body is already guarded", async () => {
  // Structural half of the reproduction, stated precisely so the behavioural
  // half below is interpreted correctly. In runner.ts's while(true):
  //   await tick(db)                    -> wrapped in try/catch
  //   await import + processScheduled.. -> wrapped in try/catch
  //   await sleep(POLL_INTERVAL_MS)     -> a setTimeout promise; cannot reject
  // So a throw from inside tick does NOT stop the loop.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile("lib/linkedin/runner.ts", "utf8");
  const loop = src.slice(src.indexOf("async function globalLoop"), src.indexOf("async function tick"));
  const awaits = (loop.match(/await /g) ?? []).length;
  assert.ok(awaits >= 3, `expected the loop body to contain awaits, found ${awaits}`);
  assert.match(loop, /try\s*{\s*await tick\(db\)/, "tick is guarded");
  assert.match(loop, /catch \(err\) {[\s\S]{0,120}console\.error\("\[runner\] Tick error:/,
    "tick errors are swallowed and the loop continues");
  assert.match(loop, /recordProgress\(db, "loop"\)/, "liveness marker at iteration start");
  assert.match(loop, /recordTickOutcome\(db, err\)/, "tick failures are counted (NF-4)");
});

test("D10: after the fix, a fatal failure no longer latches — the runner is revivable", async () => {
  // The behavioural half. getDb() at runner.ts:1275 sits inside globalLoop but
  // OUTSIDE the while loop's try/catch, so it is the reachable fatal path —
  // a corrupt/unreadable DB file, or a missing NEXTAUTH_SECRET surfacing while
  // migrating stored secrets. Once it throws, the promise rejects into the
  // outer .catch(), the loop never begins, and the module-level guard stays
  // true so nothing can ever start it again in this process.
  // Before D10 this test asserted the opposite: the boolean guard was set BEFORE
  // getDb() threw and never reset, so ensureGlobalRunnerStarted() became a
  // permanent no-op and only a process restart could revive the runner. The
  // reproduction is preserved in git history and in docs/audit-corrections.md.
  assert.equal(runner.runnerState().running, false, "precondition: not running");

  dbThrows = true;
  const before = getDbCalls;
  runner.ensureGlobalRunnerStarted();
  await new Promise(r => setTimeout(r, 60));

  assert.ok(getDbCalls > before, "the loop tried to open the DB and failed");
  assert.equal(runner.runnerState().running, true, "it is retrying, not dead — the promise is held");
  assert.ok(runner.runnerState().attempts >= 1, "the failure is counted for backoff");
});

test("D10: concurrent revive attempts produce exactly ONE loop", async () => {
  // The promise is the mutex. A self-heal retry in flight plus any number of
  // concurrent ensureGlobalRunnerStarted() calls must not spawn a second loop.
  const before = getDbCalls;
  dbThrows = true;
  for (let i = 0; i < 25; i++) runner.ensureGlobalRunnerStarted();
  await new Promise(r => setTimeout(r, 60));

  // A second loop would have attempted its own getDb() immediately. Backoff is
  // 30s, so within this window exactly one acquisition can have occurred.
  assert.ok(getDbCalls - before <= 1,
    `exactly one loop may exist; observed ${getDbCalls - before} DB acquisitions`);
  assert.equal(runner.runnerState().running, true);
});

// ─── D14: the tick-failure counter itself (not just health's reading of it) ──
// The health tests seed app_settings directly, so they never exercise
// recordTickOutcome. Without this, a mutation removing the reset survives —
// the M8/M16 multi-site lesson applied to a second module.

test("D14: recordTickOutcome increments on failure and RESETS on a clean tick", () => {
  const db = realDb.getDb();
  const read = () => parseInt(
    (db.prepare("SELECT value FROM app_settings WHERE key = 'runner_tick_failures'").get() as { value: string } | undefined)?.value ?? "0", 10);
  const errClass = () =>
    (db.prepare("SELECT value FROM app_settings WHERE key = 'runner_last_error_class'").get() as { value: string } | undefined)?.value ?? "";

  db.prepare("DELETE FROM app_settings WHERE key IN ('runner_tick_failures','runner_last_error_class')").run();

  runner.recordTickOutcome(db, new TypeError("boom"));
  assert.equal(read(), 1, "first failure counted");
  assert.equal(errClass(), "TypeError", "error CLASS recorded");

  runner.recordTickOutcome(db, new RangeError("boom"));
  runner.recordTickOutcome(db, new RangeError("boom"));
  assert.equal(read(), 3, "consecutive failures accumulate");

  runner.recordTickOutcome(db, null);
  assert.equal(read(), 0, "a clean tick RESETS the counter — otherwise every runner eventually reads degraded");
  assert.equal(errClass(), "", "and clears the stale error class");
});

test("D14/I9: only the error class is stored, never the message", () => {
  const db = realDb.getDb();
  runner.recordTickOutcome(db, new Error("failed for https://www.linkedin.com/in/someone-123/"));
  const v = (db.prepare("SELECT value FROM app_settings WHERE key = 'runner_last_error_class'").get() as { value: string }).value;
  assert.equal(v, "Error");
  assert.ok(!v.includes("linkedin.com"), "a profile URL must never reach a settings row");
  runner.recordTickOutcome(db, null);
});

test("D13: recordProgress never throws, even against a broken handle", () => {
  // A bookkeeping write must not be able to stop the work it observes.
  const broken = { prepare: () => { throw new Error("db gone"); } } as unknown as ReturnType<typeof realDb.getDb>;
  assert.doesNotThrow(() => runner.recordProgress(broken, "loop"));
  assert.doesNotThrow(() => runner.recordTickOutcome(broken, new Error("x")));
});
