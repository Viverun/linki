import test, { after } from "node:test";
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
