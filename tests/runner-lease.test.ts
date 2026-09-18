import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-runner-lease-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-runner-lease-tests";

const lease = await import("@/lib/linkedin/lease");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

// Same @/lib/db mock as runner-watchdog.test.ts: a revived loop must land in its
// unref'd recovery backoff, never in a real tick() with a non-unref'd sleep — or
// the watchdog/verb tests below (which exercise revive paths) would hang the run.
const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { namedExports: Record<string, unknown> }) => void;
const realDb = await import("@/lib/db");
const dbThrows = true;
mockModule("@/lib/db", {
  namedExports: {
    ...realDb,
    getDb: () => { if (dbThrows) throw new Error("SQLITE_CANTOPEN"); return realDb.getDb(); },
  },
});

const clear = () => getDb().prepare("DELETE FROM app_settings WHERE key = 'runner_lease'").run();
const T0 = Date.parse("2026-09-18T10:00:00Z");

test("L1 RUNNER_OWNER has the host:pid:hex shape", () => {
  assert.match(lease.RUNNER_OWNER, /^[^:]+:\d+:[0-9a-f]{8}$/);
});

test("L2 first acquire succeeds and records owner + expiry", () => {
  clear();
  assert.equal(lease.acquireRunnerLease(getDb(), "A", 120_000, T0), true);
  assert.deepEqual(lease.readRunnerLease(getDb()), { owner: "A", expires_at: new Date(T0 + 120_000).toISOString() });
});

test("L3 a second owner is refused while the lease is fresh; the holder can renew", () => {
  clear();
  lease.acquireRunnerLease(getDb(), "A", 120_000, T0);
  assert.equal(lease.acquireRunnerLease(getDb(), "B", 120_000, T0 + 60_000), false);
  assert.equal(lease.acquireRunnerLease(getDb(), "A", 120_000, T0 + 60_000), true, "renewal");
  assert.equal(lease.readRunnerLease(getDb())!.expires_at, new Date(T0 + 180_000).toISOString());
});

test("L4 an expired lease is handed over", () => {
  clear();
  lease.acquireRunnerLease(getDb(), "A", 120_000, T0);
  assert.equal(lease.acquireRunnerLease(getDb(), "B", 120_000, T0 + 120_001), true);
  assert.equal(lease.readRunnerLease(getDb())!.owner, "B");
  assert.equal(lease.holdsRunnerLease(getDb(), "A", T0 + 120_001), false);
  assert.equal(lease.holdsRunnerLease(getDb(), "B", T0 + 120_001), true);
});

test("L5 withLease runs fn for the holder and throws LeaseLostError (no write) for anyone else", () => {
  clear();
  lease.acquireRunnerLease(getDb(), "A", 120_000);
  getDb().exec("CREATE TABLE IF NOT EXISTS lease_probe (n INTEGER)");
  let ran = 0;
  assert.equal(lease.withLease(getDb(), () => { ran++; getDb().prepare("INSERT INTO lease_probe (n) VALUES (1)").run(); return 42; }, "A"), 42);
  assert.throws(() => lease.withLease(getDb(), () => { ran++; getDb().prepare("INSERT INTO lease_probe (n) VALUES (2)").run(); }, "B"), lease.LeaseLostError);
  assert.equal(ran, 1, "fn must not run for a non-holder");
  assert.equal((getDb().prepare("SELECT COUNT(*) c FROM lease_probe").get() as { c: number }).c, 1);
});

test("L6 release only clears the holder's own lease", () => {
  clear();
  lease.acquireRunnerLease(getDb(), "A", 120_000);
  lease.releaseRunnerLease(getDb(), "B");
  assert.equal(lease.readRunnerLease(getDb())!.owner, "A");
  lease.releaseRunnerLease(getDb(), "A");
  assert.equal(lease.readRunnerLease(getDb()), null);
});

test("L7 a malformed stored value is treated as absent", () => {
  getDb().prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('runner_lease', 'not-json', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  assert.equal(lease.readRunnerLease(getDb()), null);
  assert.equal(lease.acquireRunnerLease(getDb(), "A", 120_000), true);
});

// ── watchdog + verbs (runner loaded with browser modules mocked, as in runner-watchdog.test.ts)
const runner = await import("@/lib/linkedin/runner");
const setMarker = (iso: string) => getDb().prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('runner_progress_at', ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(iso);
const stale = () => new Date(Date.now() - 11 * 60_000).toISOString();

test("L8 the watchdog does not revive while another owner holds a fresh lease", () => {
  clear(); setMarker(stale());
  lease.acquireRunnerLease(getDb(), "other-process", 120_000);
  assert.equal(runner.runnerWatchdogTick(getDb()), false);
  assert.equal(runner.runnerState().running, false);
});

test("L9 trClaim under a foreign lease throws LeaseLostError and claims nothing", () => {
  clear();
  lease.acquireRunnerLease(getDb(), "other-process", 120_000);
  const db = getDb();
  db.prepare("INSERT INTO workflows (id, name) VALUES ('wf-l9', 'x')").run();
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES ('run-l9', 'wf-l9', 'running')").run();
  db.prepare("INSERT INTO targets (id, linkedin_url) VALUES ('t-l9', 'https://www.linkedin.com/in/l9/')").run();
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES ('rp-l9', 'run-l9', 't-l9')").run();
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES ('tr-l9', 'rp-l9', 'linkedin', 'in_progress', 0)").run();
  assert.throws(() => runner.trClaim(db, "tr-l9"), lease.LeaseLostError);
  assert.equal((db.prepare("SELECT next_step_at FROM run_profile_tracks WHERE id = 'tr-l9'").get() as { next_step_at: string | null }).next_step_at, null);
  lease.acquireRunnerLease(getDb(), lease.RUNNER_OWNER, 120_000, Date.now() + 200_000); // hand over (expired) so later tests can claim
  assert.equal(runner.trClaim(db, "tr-l9"), true);
});
