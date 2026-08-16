import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-health-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-health-tests";

const { default: healthHandler } = await import("@/pages/api/health");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

interface Cap { status: number; body: any }   // eslint-disable-line @typescript-eslint/no-explicit-any
function call(method = "GET"): Cap {
  const cap: Cap = { status: 200, body: undefined };
  const res = {
    status(c: number) { cap.status = c; return this; },
    json(b: unknown) { cap.body = b; return this; },
    end() { return this; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  healthHandler({ method, query: {} } as any, res as any);
  return cap;
}

const setKey = (k: string, v: string) =>
  getDb().prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(k, v);

const fresh = () => new Date().toISOString();
const stale = () => new Date(Date.now() - 11 * 60_000).toISOString();   // 11 min > 600s

test("healthy: fresh marker, no failures → 200", () => {
  setKey("runner_progress_at", fresh());
  setKey("runner_tick_failures", "0");
  const r = call();
  assert.equal(r.status, 200);
  assert.equal(r.body.runner.state, "healthy");
  assert.equal(r.body.schema, "ok");
});

test("dead: stale marker → 503", () => {
  setKey("runner_progress_at", stale());
  setKey("runner_tick_failures", "0");
  const r = call();
  assert.equal(r.status, 503);
  assert.equal(r.body.runner.state, "dead");
  assert.ok(r.body.runner.seconds_since_progress > 600);
});

test("degraded (NF-4): fresh marker + 5 consecutive tick failures → 200 with the flag", () => {
  setKey("runner_progress_at", fresh());
  setKey("runner_tick_failures", "5");
  setKey("runner_last_error_class", "SqliteError");
  const r = call();
  assert.equal(r.status, 200, "degraded must NOT be 503 — a restart does not fix a deterministic tick failure");
  assert.equal(r.body.runner.state, "degraded");
  assert.equal(r.body.runner.consecutive_tick_failures, 5);
  assert.equal(r.body.runner.last_error_class, "SqliteError");
});

test("a single tick failure is not degraded", () => {
  setKey("runner_progress_at", fresh());
  setKey("runner_tick_failures", "1");
  const r = call();
  assert.equal(r.body.runner.state, "healthy");
  assert.equal(r.body.runner.last_error_class, null, "error class is only surfaced when degraded");
});

test("absent marker → 503 (the loop never started)", () => {
  getDb().prepare("DELETE FROM app_settings WHERE key = 'runner_progress_at'").run();
  const r = call();
  assert.equal(r.status, 503);
  assert.equal(r.body.runner.state, "dead");
  assert.equal(r.body.runner.seconds_since_progress, null);
});

test("A2.4: a missing step_side_effects table → 503, not a silent pass", () => {
  const db = getDb();
  setKey("runner_progress_at", fresh());
  db.exec("ALTER TABLE step_side_effects RENAME TO step_side_effects_backup");
  try {
    const r = call();
    assert.equal(r.status, 503);
    assert.equal(r.body.reason, "step_side_effects_missing");
  } finally {
    db.exec("ALTER TABLE step_side_effects_backup RENAME TO step_side_effects");
  }
});

test("non-GET → 405", () => {
  for (const m of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal(call(m).status, 405);
});

test("T5.2: a health call performs ZERO writes", () => {
  const db = getDb();
  setKey("runner_progress_at", fresh());
  const before = db.prepare("SELECT key, value, updated_at FROM app_settings ORDER BY key").all();
  const walBefore = statSync(join(dbDir, "test.db-wal")).size;

  for (let i = 0; i < 10; i++) call();

  assert.deepEqual(db.prepare("SELECT key, value, updated_at FROM app_settings ORDER BY key").all(), before,
    "app_settings untouched — an unauthenticated endpoint must not be able to write");
  assert.equal(statSync(join(dbDir, "test.db-wal")).size, walBefore, "WAL did not grow");
});

test("I9: the payload leaks no counts, identifiers, env values or error messages", () => {
  setKey("runner_progress_at", fresh());
  setKey("runner_tick_failures", "9");
  setKey("runner_last_error_class", "SqliteError");
  const json = JSON.stringify(call().body);
  for (const f of ["NEXTAUTH", "li_at", "cookie", "password", "urn:li", "/in/"]) {
    assert.ok(!json.includes(f), `payload must not contain ${f}`);
  }
  assert.ok(!/targets|accounts|logs/.test(json), "no table names or counts");
});

// ─── P2-1 Part B: restart_will_help, and the probe that consumes it ─────────
// Three of the four 503 reasons repeat identically after a restart, and every
// restart kills in-flight LinkedIn work. A supervisor acting on the raw status
// would restart-loop forever.

/** The exact predicate the Dockerfile/compose probe evaluates. */
const probeExitsNonZero = (body: any) =>   // eslint-disable-line @typescript-eslint/no-explicit-any
  !!(body.runner && body.runner.state === "dead" && body.restart_will_help === true);

test("P2-1: restart_will_help is TRUE only for a dead runner on a healthy DB", () => {
  setKey("runner_progress_at", stale());
  setKey("runner_tick_failures", "0");
  const r = call();
  assert.equal(r.status, 503);
  assert.equal(r.body.runner.state, "dead");
  assert.equal(r.body.restart_will_help, true);
  assert.equal(probeExitsNonZero(r.body), true, "the probe must act on this one");
});

test("P2-1: restart_will_help is FALSE for a missing ledger table — a restart loops forever", () => {
  const db = getDb();
  setKey("runner_progress_at", stale());     // also dead, to prove schema wins
  db.exec("ALTER TABLE step_side_effects RENAME TO step_side_effects_backup");
  try {
    const r = call();
    assert.equal(r.status, 503, "a human must still see it");
    assert.equal(r.body.restart_will_help, false);
    assert.equal(probeExitsNonZero(r.body), false, "but the supervisor must NOT act");
  } finally {
    db.exec("ALTER TABLE step_side_effects_backup RENAME TO step_side_effects");
  }
});

test("P2-1: a degraded runner never triggers a restart", () => {
  setKey("runner_progress_at", fresh());
  setKey("runner_tick_failures", "9");
  const r = call();
  assert.equal(r.status, 200);
  assert.equal(r.body.runner.state, "degraded");
  assert.equal(r.body.restart_will_help, false);
  assert.equal(probeExitsNonZero(r.body), false,
    "D14: a deterministic tick failure is not fixed by a restart, and the restart kills work");
});

test("P2-1: a healthy runner never triggers a restart", () => {
  setKey("runner_progress_at", fresh());
  setKey("runner_tick_failures", "0");
  assert.equal(probeExitsNonZero(call().body), false);
});

test("P2-1: revivals are surfaced so repeated automatic recoveries are not silent", () => {
  setKey("runner_progress_at", fresh());
  setKey("runner_tick_failures", "0");
  setKey("runner_revivals", "4");
  const r = call();
  assert.equal(r.body.runner.revivals, 4, "visible even while currently healthy");
});

test("P2-1: both probes delegate to the shared predicate rather than inlining it", async () => {
  // The predicate now lives in scripts/health-predicate.js so the Docker probe
  // and the host watchdog cannot drift. Its BEHAVIOUR is covered by
  // tests/health-predicate.test.ts, which executes it as a real process; this
  // only asserts the delegation.
  const { readFile } = await import("node:fs/promises");
  for (const f of ["Dockerfile", "docker-compose.yml"]) {
    const src = await readFile(f, "utf8");
    assert.match(src, /health-predicate\.js/, `${f}: calls the shared predicate`);
    assert.doesNotMatch(src, /restart_will_help===?true/, `${f}: no inline copy to drift`);
  }
});

// NF-12 (health side): the same threshold, the same missing side. "dead: stale
// marker → 503" pins the firing side with an absolute 11 minutes, but nothing
// pinned the other: a NARROWED threshold would report a working runner dead and
// hand the supervisor a restart loop. `fresh()` is ~0s old and survives almost
// any narrowing, so this uses an absolute age just under the real boundary.
test("NF-12: a marker just under the liveness threshold is still healthy", () => {
  setKey("runner_progress_at", new Date(Date.now() - 9 * 60_000).toISOString());
  setKey("runner_tick_failures", "0");
  const r = call();
  assert.equal(r.status, 200, "9 minutes without progress is within budget, not dead");
  assert.equal(r.body.runner.state, "healthy");
  assert.equal(r.body.restart_will_help, false, "and nothing should be restarting it");
});
