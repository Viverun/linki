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

const g = globalThis as typeof globalThis & { __linkiGlobalRunnerStarted?: boolean };

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
  assert.match(loop, /catch \(err\) {\s*console\.error\("\[runner\] Tick error:/, "tick errors are swallowed and the loop continues");
});

test("F8 repro: getDb() throwing kills the loop permanently AND blocks any restart", async () => {
  // The behavioural half. getDb() at runner.ts:1275 sits inside globalLoop but
  // OUTSIDE the while loop's try/catch, so it is the reachable fatal path —
  // a corrupt/unreadable DB file, or a missing NEXTAUTH_SECRET surfacing while
  // migrating stored secrets. Once it throws, the promise rejects into the
  // outer .catch(), the loop never begins, and the module-level guard stays
  // true so nothing can ever start it again in this process.
  assert.notEqual(g.__linkiGlobalRunnerStarted, true, "precondition: no loop started yet");

  dbThrows = true;
  const before = getDbCalls;
  runner.ensureGlobalRunnerStarted();
  await new Promise(r => setTimeout(r, 50));   // let the rejection settle

  assert.ok(getDbCalls > before, "the loop tried to open the DB");
  assert.equal(g.__linkiGlobalRunnerStarted, true, "the guard was set BEFORE the failure");

  // The decisive assertion: the runner is now permanently dead in this process.
  dbThrows = false;
  const afterDeath = getDbCalls;
  runner.ensureGlobalRunnerStarted();          // an operator/route trying to revive it
  await new Promise(r => setTimeout(r, 50));

  assert.equal(getDbCalls, afterDeath,
    "ensureGlobalRunnerStarted is a no-op forever after: the guard is never reset, " +
    "so a crashed loop cannot be restarted without restarting the process");
});
