import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/db.ts resolves the DB path on first getDb(), so set it before loading.
const dbDir = mkdtempSync(join(tmpdir(), "linki-retry-ledger-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-retry-ledger-tests";

// The retry route is a plain synchronous handler with no browser or network
// dependency, so it is driven directly against a real temp SQLite database.
// The audit found ZERO existing tests for this route; these are the only
// tripwire between it and a duplicate message.
const { default: retryHandler } = await import("@/pages/api/runs/[id]/retry");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

// ─── harness ─────────────────────────────────────────────────────────────────

interface Captured { status: number; body: unknown }

function callRetry(runId: string, body: unknown): Captured {
  const captured: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return this; },
    json(payload: unknown) { captured.body = payload; return this; },
    end() { return this; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retryHandler({ method: "POST", query: { id: runId }, body } as any, res as any);
  return captured;
}

let seq = 0;

interface Spec {
  runStatus?: string;
  stepType?: "message" | "connect";
  trackState?: string;
  ledger?: { stepRef: string; status: string } | null;
}

function scenario(spec: Spec = {}) {
  const n = ++seq;
  const ids = { run: `r-${n}`, wf: `w-${n}`, profile: `p-${n}`, track: `t-${n}`, target: `tg-${n}` };
  const db = getDb();

  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare(
    `INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, message_body, message_position, ai_enabled)
     VALUES (?, ?, 1, 'linkedin', ?, 0, 'body', 1, 0)`
  ).run(`s-${n}`, ids.wf, spec.stepType ?? "message");
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, ?)").run(ids.run, ids.wf, spec.runStatus ?? "running");
  db.prepare("INSERT INTO targets (id, full_name, linkedin_url) VALUES (?, 'Ada', ?)").run(ids.target, `https://www.linkedin.com/in/ada-r-${n}/`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  db.prepare(
    `INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, error_message)
     VALUES (?, ?, 'linkedin', ?, 0, 'boom')`
  ).run(ids.track, ids.profile, spec.trackState ?? "failed");

  if (spec.ledger) {
    db.prepare(
      `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, started_at)
       VALUES (?, ?, 'linkedin', ?, ?, 'message', ?, datetime('now'))`
    ).run(`se-${n}`, ids.profile, spec.ledger.stepRef, ids.target, spec.ledger.status);
  }
  return ids;
}

const trackOf = (id: string) =>
  getDb().prepare("SELECT state, current_step, error_message FROM run_profile_tracks WHERE id = ?").get(id) as
    { state: string; current_step: number; error_message: string | null };

// ─── 8: in_flight is blocked ─────────────────────────────────────────────────

test("8 a failed track whose message is in_flight is NOT re-armed", () => {
  const ids = scenario({ ledger: { stepRef: "pos:1", status: "in_flight" } });

  const r = callRetry(ids.run, { target_ids: [ids.target] });

  assert.equal(r.status, 200);
  const body = r.body as { retried: number; outcomes: Array<{ outcome: string; reason?: string }> };
  assert.equal(body.retried, 0, "nothing was re-armed");
  assert.equal(body.outcomes[0].outcome, "blocked");
  assert.match(body.outcomes[0].reason ?? "", /may already have been delivered/);
  assert.equal(trackOf(ids.track).state, "failed", "the track must stay failed so the next tick sends nothing");
});

test("8b resolve:'resend' re-arms an in_flight track only on explicit opt-in", () => {
  const ids = scenario({ ledger: { stepRef: "pos:1", status: "in_flight" } });

  const r = callRetry(ids.run, { target_ids: [ids.target], resolve: "resend" });

  const body = r.body as { retried: number; outcomes: Array<{ outcome: string; reason?: string }> };
  assert.equal(body.retried, 1);
  assert.equal(body.outcomes[0].outcome, "rearmed");
  assert.match(body.outcomes[0].reason ?? "", /forced resend/);
  assert.equal(trackOf(ids.track).state, "in_progress");
});

test("8c a confirmed message advances past the step instead of re-sending it", () => {
  const ids = scenario({ ledger: { stepRef: "pos:1", status: "confirmed" } });

  const r = callRetry(ids.run, { target_ids: [ids.target] });

  const body = r.body as { outcomes: Array<{ outcome: string }> };
  assert.equal(body.outcomes[0].outcome, "advanced");
  const t = trackOf(ids.track);
  assert.equal(t.state, "in_progress");
  assert.equal(t.current_step, 1, "moved past the delivered message so retry cannot re-send it");
});

// ─── 9: run-state guard ──────────────────────────────────────────────────────

test("9 retrying a completed run returns 409 and mutates nothing", () => {
  const ids = scenario({ runStatus: "completed" });

  const r = callRetry(ids.run, { target_ids: [ids.target] });

  assert.equal(r.status, 409);
  assert.equal(trackOf(ids.track).state, "failed", "no mutation");
  assert.equal(trackOf(ids.track).error_message, "boom", "error_message untouched");
});

test("9b a missing run returns 404", () => {
  const r = callRetry("does-not-exist", { target_ids: ["x"] });
  assert.equal(r.status, 404);
});

test("9c an invalid resolve value returns 400 before any mutation", () => {
  const ids = scenario({ ledger: { stepRef: "pos:1", status: "in_flight" } });

  const r = callRetry(ids.run, { target_ids: [ids.target], resolve: "nuke" });

  assert.equal(r.status, 400);
  assert.equal(trackOf(ids.track).state, "failed");
});

// ─── 10: F2 recovery path preserved ──────────────────────────────────────────

test("10 a failed CONNECT track with no ledger row still re-arms (F2 recovery preserved)", () => {
  const ids = scenario({ stepType: "connect" });

  const r = callRetry(ids.run, { target_ids: [ids.target] });

  const body = r.body as { retried: number; outcomes: Array<{ outcome: string }> };
  assert.equal(body.outcomes[0].outcome, "rearmed");
  assert.equal(body.retried, 1);
  const t = trackOf(ids.track);
  assert.equal(t.state, "in_progress");
  assert.equal(t.current_step, 0, "connect must re-enter at the SAME step so PendingInviteError can stamp");
  assert.equal(t.error_message, null);
});

test("10c a failed CONNECT re-arms even when a colliding pos:1 message ledger row exists", () => {
  // Every step carries message_position=1 by default, so stepRefOf(connectStep)
  // is "pos:1" — the SAME step_ref as the first message step in the track. If
  // retry consulted the ledger for non-message steps, a delivered message would
  // silently advance a failed connect past its own step and destroy the
  // PendingInviteError recovery that F2 depends on. This test pins the exemption.
  const ids = scenario({ stepType: "connect", ledger: { stepRef: "pos:1", status: "confirmed" } });

  const r = callRetry(ids.run, { target_ids: [ids.target] });

  const body = r.body as { outcomes: Array<{ outcome: string }> };
  assert.equal(body.outcomes[0].outcome, "rearmed", "connect is not ledger-governed");
  assert.equal(trackOf(ids.track).current_step, 0, "must re-enter at the SAME step, not be advanced past it");
});

test("10b the success response keeps its original `ok` and `retried` fields", () => {
  const ids = scenario({ stepType: "connect" });

  const body = callRetry(ids.run, { target_ids: [ids.target] }).body as Record<string, unknown>;

  assert.equal(body.ok, true, "existing field preserved");
  assert.equal(typeof body.retried, "number", "existing field preserved with its original type");
  assert.ok(Array.isArray(body.outcomes), "new field is additive");
});

// ─── 11–12: migration quality ────────────────────────────────────────────────

test("11 the migration is idempotent — running it twice adds nothing and throws nothing", () => {
  const db = getDb();
  const objectsBefore = db.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE '%step_side_effects%' ORDER BY name"
  ).all() as Array<{ name: string }>;
  const rowsBefore = db.prepare("SELECT COUNT(*) c FROM step_side_effects").get() as { c: number };

  assert.doesNotThrow(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS step_side_effects (
      id TEXT PRIMARY KEY, run_profile_id TEXT NOT NULL REFERENCES run_profiles(id) ON DELETE CASCADE,
      track TEXT NOT NULL, step_ref TEXT NOT NULL, target_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('message', 'inmail')),
      status TEXT NOT NULL CHECK(status IN ('in_flight', 'confirmed', 'abandoned')),
      body_fingerprint TEXT, attempt_count INTEGER NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL, confirmed_at TEXT, error_message TEXT)`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_step_side_effects ON step_side_effects(run_profile_id, track, step_ref, action)");
    db.exec("CREATE INDEX IF NOT EXISTS ix_step_side_effects_fingerprint ON step_side_effects(run_profile_id, target_id, body_fingerprint)");
  });

  const objectsAfter = db.prepare(
    "SELECT name FROM sqlite_master WHERE name LIKE '%step_side_effects%' ORDER BY name"
  ).all() as Array<{ name: string }>;
  assert.deepEqual(objectsAfter, objectsBefore, "no duplicate table or index");
  assert.equal((db.prepare("SELECT COUNT(*) c FROM step_side_effects").get() as { c: number }).c, rowsBefore.c, "no data change");
});

test("11b the unique index actually prevents a duplicate ledger row", () => {
  const ids = scenario({ ledger: { stepRef: "pos:1", status: "in_flight" } });
  const db = getDb();

  assert.throws(() => {
    db.prepare(
      `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, started_at)
       VALUES (?, ?, 'linkedin', 'pos:1', ?, 'message', 'in_flight', datetime('now'))`
    ).run("dupe", ids.profile, ids.target);
  }, /UNIQUE|constraint/i);
});

test("12 deleting a run leaves zero orphaned step_side_effects rows", () => {
  const ids = scenario({ ledger: { stepRef: "pos:1", status: "confirmed" } });
  const db = getDb();
  assert.equal((db.prepare("SELECT COUNT(*) c FROM step_side_effects WHERE run_profile_id = ?").get(ids.profile) as { c: number }).c, 1);

  db.prepare("DELETE FROM runs WHERE id = ?").run(ids.run);

  assert.equal((db.prepare("SELECT COUNT(*) c FROM step_side_effects WHERE run_profile_id = ?").get(ids.profile) as { c: number }).c, 0,
    "cascade chain runs → run_profiles → step_side_effects");
  const orphans = db.prepare(
    "SELECT COUNT(*) c FROM step_side_effects se LEFT JOIN run_profiles rp ON rp.id = se.run_profile_id WHERE rp.id IS NULL"
  ).get() as { c: number };
  assert.equal(orphans.c, 0, "no orphans anywhere in the table");
});
