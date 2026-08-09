import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-run-status-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-run-status-tests";

const { default: runHandler } = await import("@/pages/api/runs/[id]/index");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

interface Captured { status: number; body: unknown }

function patchStatus(runId: string, body: unknown): Captured {
  const cap: Captured = { status: 200, body: undefined };
  const res = {
    status(c: number) { cap.status = c; return this; },
    json(b: unknown) { cap.body = b; return this; },
    end() { return this; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runHandler({ method: "PATCH", query: { id: runId }, body } as any, res as any);
  return cap;
}

let seq = 0;
function makeRun(status: string) {
  const n = ++seq;
  const ids = { run: `r-${n}`, wf: `w-${n}`, acct: `a-${n}` };
  const db = getDb();
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES (?, ?, ?, 1)")
    .run(ids.acct, `Acct ${n}`, `a${n}@example.invalid`);
  db.prepare("INSERT INTO runs (id, workflow_id, account_id, status) VALUES (?, ?, ?, ?)")
    .run(ids.run, ids.wf, ids.acct, status);
  return ids;
}

const statusOf = (id: string) =>
  (getDb().prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string }).status;

/** tick()'s own active-run query, verbatim from lib/linkedin/runner.ts:1085-1092. */
const tickWouldSelect = (runId: string) =>
  getDb().prepare(`
    SELECT r.id as run_id FROM runs r JOIN accounts a ON a.id = r.account_id
    WHERE r.status = 'running' AND a.is_authenticated = 1 AND r.id = ?`).all(runId).length > 0;

// ─── N4 REPRODUCTION (must fail before the fix) ──────────────────────────────

test("N4 repro: PATCH accepts an arbitrary garbage status", () => {
  const ids = makeRun("running");

  const r = patchStatus(ids.run, { status: "banana" });

  assert.equal(r.status, 400, `expected 400 for a non-allow-listed status, got ${r.status}`);
  assert.equal(statusOf(ids.run), "running", "the run's status must be unchanged");
});

test("N4 repro: PATCH resurrects a completed run back to running", () => {
  const ids = makeRun("completed");

  const r = patchStatus(ids.run, { status: "running" });

  assert.equal(r.status, 409, `expected 409 for completed → running, got ${r.status}`);
  assert.equal(statusOf(ids.run), "completed", "a finished campaign must not restart");
});

test("N4 repro: a resurrected run is actually picked up by tick()'s own query", () => {
  // Severity check. If the resurrected run were inert (as re-arming a completed
  // run's track turned out to be), N4 would be a data-integrity issue rather
  // than an automation-restart issue.
  const ids = makeRun("completed");
  assert.equal(tickWouldSelect(ids.run), false, "precondition: a completed run is not selected");

  patchStatus(ids.run, { status: "running" });

  assert.equal(tickWouldSelect(ids.run), false,
    "after the fix the run stays completed, so tick still cannot select it");
});

test("N4 repro: an unknown status makes the run invisible to BOTH tick and auto-complete", () => {
  const ids = makeRun("running");

  patchStatus(ids.run, { status: "paused-ish" });

  assert.notEqual(statusOf(ids.run), "paused-ish",
    "a garbage status would orphan the run: tick ignores it and auto-complete never finalises it");
});

// ─── after the fix: every legal transition still works ───────────────────────

test("every legal transition succeeds and returns the ORIGINAL success shape", () => {
  const legal: Array<[string, string]> = [
    ["running", "paused"], ["running", "completed"],
    ["paused", "running"], ["paused", "completed"],
  ];
  for (const [from, to] of legal) {
    const ids = makeRun(from);
    const r = patchStatus(ids.run, { status: to });
    assert.equal(r.status, 200, `${from} → ${to} must be allowed`);
    assert.deepEqual(r.body, { ok: true }, "success shape unchanged — callers read { ok: true }");
    assert.equal(statusOf(ids.run), to);
  }
});

test("the UI's real pause / stop sequence still works end to end", () => {
  // pauseRun() sends {status:"paused"}; stopRun() sends {status:"completed"};
  // resume uses POST /start, not this route. Anything that breaks these breaks
  // the buttons, which is a worse outcome than N4 itself.
  const ids = makeRun("running");
  assert.equal(patchStatus(ids.run, { status: "paused" }).status, 200, "pause");
  assert.equal(statusOf(ids.run), "paused");
  assert.equal(patchStatus(ids.run, { status: "completed" }).status, 200, "stop from paused");
  assert.equal(statusOf(ids.run), "completed");
});

test("re-sending the current status is an idempotent no-op, not a 409", () => {
  const ids = makeRun("paused");
  const r = patchStatus(ids.run, { status: "paused" });
  assert.equal(r.status, 200, "a double-click on pause must not error");
  assert.equal(statusOf(ids.run), "paused");
});

test("hostile inputs are all rejected with 400 and zero writes", () => {
  for (const bad of ["", "RUNNING", "deleted", "'; DROP TABLE runs; --", null, 42, {}, "x".repeat(10_000)]) {
    const ids = makeRun("running");
    const r = patchStatus(ids.run, { status: bad });
    assert.equal(r.status, 400, `input ${JSON.stringify(bad)?.slice(0, 30)} must be rejected`);
    assert.equal(statusOf(ids.run), "running", "no write");
  }
  // The table still exists — proving the injection string was bound, not executed.
  assert.ok((getDb().prepare("SELECT COUNT(*) c FROM runs").get() as { c: number }).c > 0);
});

test("a missing run returns 404 without writing", () => {
  const r = patchStatus("no-such-run", { status: "paused" });
  assert.equal(r.status, 404);
});

test("the 409 for a completed run names the alternative instead of just refusing", () => {
  // D4.2: a dead end the operator cannot reason about is how people end up
  // editing the database by hand.
  const ids = makeRun("completed");

  const r = patchStatus(ids.run, { status: "running" });

  assert.equal(r.status, 409);
  const body = r.body as { error: string; from: string; to: string };
  assert.equal(body.from, "completed");
  assert.equal(body.to, "running");
  assert.match(body.error, /enrol them in a new run/i, "names the supported route forward");
  assert.match(body.error, /pending invitation is detected rather than re-sent/i,
    "and explains why re-enrolling is safe");
});
