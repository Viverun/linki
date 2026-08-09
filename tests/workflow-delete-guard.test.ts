import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-wf-delete-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-wf-delete-tests";

const { default: wfHandler } = await import("@/pages/api/workflows/[id]/index");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

interface Captured { status: number; body: unknown }

function deleteWorkflow(id: string): Captured {
  const cap: Captured = { status: 200, body: undefined };
  const res = {
    status(c: number) { cap.status = c; return this; },
    json(b: unknown) { cap.body = b; return this; },
    end() { return this; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wfHandler({ method: "DELETE", query: { id } } as any, res as any);
  return cap;
}

let seq = 0;
function scenario(runStatus: string) {
  const n = ++seq;
  const ids = {
    wf: `w-${n}`, run: `r-${n}`, acct: `a-${n}`, target: `t-${n}`,
    profile: `p-${n}`, track: `tr-${n}`, log: `l-${n}`,
  };
  const db = getDb();
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare(
    `INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, message_position, ai_enabled)
     VALUES (?, ?, 1, 'linkedin', 'connect', 0, 1, 0)`
  ).run(`s-${n}`, ids.wf);
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES (?, ?, ?, 1)")
    .run(ids.acct, `Acct ${n}`, `a${n}@example.invalid`);
  db.prepare("INSERT INTO targets (id, full_name, linkedin_url) VALUES (?, 'Ada', ?)")
    .run(ids.target, `https://www.linkedin.com/in/ada-w-${n}/`);
  db.prepare("INSERT INTO runs (id, workflow_id, account_id, status) VALUES (?, ?, ?, ?)")
    .run(ids.run, ids.wf, ids.acct, runStatus);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)")
    .run(ids.profile, ids.run, ids.target);
  db.prepare(
    `INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step)
     VALUES (?, ?, 'linkedin', 'in_progress', 0)`
  ).run(ids.track, ids.profile);
  db.prepare("INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, ?, ?, 'info', 'seed')")
    .run(ids.log, ids.run, ids.target);
  db.prepare(
    `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, started_at)
     VALUES (?, ?, 'linkedin', 'pos:1', ?, 'message', 'confirmed', datetime('now'))`
  ).run(`se-${n}`, ids.profile, ids.target);
  return ids;
}

const counts = () => {
  const db = getDb();
  const c: Record<string, number> = {};
  for (const t of ["workflows", "workflow_steps", "runs", "run_profiles", "run_profile_tracks", "logs", "step_side_effects"]) {
    c[t] = (db.prepare("SELECT COUNT(*) c FROM " + t).get() as { c: number }).c;
  }
  return c;
};

// ─── N5 REPRODUCTION (must fail before the fix) ──────────────────────────────

test("N5 repro: deleting a workflow with a RUNNING run removes the run row", () => {
  const ids = scenario("running");
  const db = getDb();
  assert.equal((db.prepare("SELECT COUNT(*) c FROM runs WHERE id = ?").get(ids.run) as { c: number }).c, 1);

  const r = deleteWorkflow(ids.wf);

  assert.equal(r.status, 409, `expected 409 while a run is live, got ${r.status}`);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM runs WHERE id = ?").get(ids.run) as { c: number }).c, 1,
    "the live run must survive");
});

test("N5 repro: the claimed downstream consequence — log() after the run row is gone", () => {
  // The audit claims a mid-flight executeStep would then write a log for a
  // deleted run and violate logs.run_id → runs(id). Verify the CONSEQUENCE
  // directly rather than inferring it: if it does not reproduce, N5 is a
  // data-integrity issue, not a mid-flight-corruption one, and the severity
  // changes.
  const ids = scenario("running");
  const db = getDb();

  // Simulate the pre-fix delete exactly as it was written.
  db.prepare("DELETE FROM runs WHERE workflow_id = ?").run(ids.wf);

  // ...and now the in-flight step tries to log, exactly as runner.ts:262 does.
  let threw: unknown = null;
  try {
    db.prepare("INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, ?, ?, 'info', 'mid-flight')")
      .run("late-log", ids.run, ids.target);
  } catch (e) { threw = e; }

  assert.ok(threw, "a log write for a deleted run must violate the FK — this is the claimed consequence");
  assert.match(String((threw as { code?: string })?.code ?? threw), /FOREIGN/i);
});

test("N5 repro: the two-statement delete is not atomic", () => {
  // If the second statement fails, the runs are already gone and the workflow
  // remains — a state no retry can reconcile.
  const ids = scenario("completed");
  const db = getDb();
  const before = counts();

  // Force the workflow delete to fail after the runs delete has happened, the
  // way a locked row or a constraint would.
  const originalPrepare = db.prepare.bind(db);
  let armed = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = (sql: string) => {
    if (armed && /DELETE FROM workflows/i.test(sql)) {
      armed = false;
      return { run: () => { throw new Error("simulated failure on the final statement"); } };
    }
    return originalPrepare(sql);
  };

  try { deleteWorkflow(ids.wf); } catch { /* the handler may propagate */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = originalPrepare;

  const after = counts();
  assert.equal(after.runs, before.runs, "a failed delete must roll back the run deletion");
  assert.equal(after.workflows, before.workflows, "and leave the workflow intact");
});

// ─── after the fix ───────────────────────────────────────────────────────────

test("a PAUSED run also blocks deletion", () => {
  const ids = scenario("paused");
  const before = counts();

  const r = deleteWorkflow(ids.wf);

  assert.equal(r.status, 409);
  assert.deepEqual(counts(), before, "nothing at all was deleted");
  const body = r.body as { active_runs: number };
  assert.equal(body.active_runs, 1, "the count is reported so the operator knows what to stop");
});

test("a workflow whose runs are all completed deletes cleanly, with zero orphans", () => {
  const ids = scenario("completed");
  const db = getDb();

  const r = deleteWorkflow(ids.wf);

  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true }, "success shape unchanged");

  // Every table in the cascade chain must be clear for this workflow.
  const q = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { c: number }).c;
  assert.equal(q("SELECT COUNT(*) c FROM workflows WHERE id = ?", ids.wf), 0, "workflow");
  assert.equal(q("SELECT COUNT(*) c FROM workflow_steps WHERE workflow_id = ?", ids.wf), 0, "steps (cascade)");
  assert.equal(q("SELECT COUNT(*) c FROM runs WHERE id = ?", ids.run), 0, "run");
  assert.equal(q("SELECT COUNT(*) c FROM run_profiles WHERE id = ?", ids.profile), 0, "run_profiles (cascade)");
  assert.equal(q("SELECT COUNT(*) c FROM run_profile_tracks WHERE id = ?", ids.track), 0, "tracks (cascade)");
  assert.equal(q("SELECT COUNT(*) c FROM logs WHERE run_id = ?", ids.run), 0, "logs (cascade)");
  assert.equal(q("SELECT COUNT(*) c FROM step_side_effects WHERE run_profile_id = ?", ids.profile), 0, "ledger (cascade)");

  // And nothing is orphaned anywhere in the database.
  assert.equal(q(`SELECT COUNT(*) c FROM run_profiles rp LEFT JOIN runs r ON r.id = rp.run_id WHERE r.id IS NULL`), 0);
  assert.equal(q(`SELECT COUNT(*) c FROM run_profile_tracks t LEFT JOIN run_profiles rp ON rp.id = t.run_profile_id WHERE rp.id IS NULL`), 0);
  assert.equal(q(`SELECT COUNT(*) c FROM step_side_effects se LEFT JOIN run_profiles rp ON rp.id = se.run_profile_id WHERE rp.id IS NULL`), 0);
  assert.equal(getDb().prepare("PRAGMA foreign_key_check").all().length, 0, "no FK violations anywhere");
});

test("a workflow with no runs at all deletes cleanly", () => {
  const db = getDb();
  db.prepare("INSERT INTO workflows (id, name) VALUES ('lonely', 'Lonely')").run();

  assert.equal(deleteWorkflow("lonely").status, 200);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM workflows WHERE id = 'lonely'").get() as { c: number }).c, 0);
});
