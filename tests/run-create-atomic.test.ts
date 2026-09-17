import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-run-create-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-run-create-tests";

const { default: runsHandler } = await import("@/pages/api/runs/index");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

function post(body: unknown) {
  const captured = { status: 200, body: undefined as unknown };
  const res = { status(c: number) { captured.status = c; return this; }, json(p: unknown) { captured.body = p; return this; }, end() { return this; } };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runsHandler({ method: "POST", body } as any, res as any);
  } catch (err) {
    captured.status = 500; captured.body = { error: err instanceof Error ? err.message : String(err) };
  }
  return captured;
}
const counts = () => {
  const db = getDb();
  const c = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  return { runs: c("runs"), profiles: c("run_profiles"), tracks: c("run_profile_tracks") };
};

let seq = 0;
function fixture(targetCount = 3) {
  const n = ++seq; const db = getDb();
  const ids = { wf: `wf-${n}`, list: `list-${n}`, acct: `acct-${n}`, targets: [] as string[] };
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, ai_enabled) VALUES (?, ?, 1, 'linkedin', 'connect', 0, 0)").run(`s-${n}`, ids.wf);
  db.prepare("INSERT INTO lists (id, name) VALUES (?, ?)").run(ids.list, `List ${n}`);
  db.prepare("INSERT INTO accounts (id, name, email) VALUES (?, ?, ?)").run(ids.acct, `Acct ${n}`, `acct-${n}@fixture.test`);
  for (let i = 0; i < targetCount; i++) {
    const t = `t-${n}-${i}`; ids.targets.push(t);
    db.prepare("INSERT INTO targets (id, full_name, linkedin_url) VALUES (?, ?, ?)").run(t, `T ${i}`, `https://www.linkedin.com/in/t-${n}-${i}/`);
    db.prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(ids.list, t);
  }
  return ids;
}

test("A1 success creates exactly one run, N profiles, N tracks", () => {
  const f = fixture(3); const before = counts();
  const r = post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct });
  assert.equal(r.status, 201);
  const after_ = counts();
  assert.deepEqual({ runs: after_.runs - before.runs, profiles: after_.profiles - before.profiles, tracks: after_.tracks - before.tracks }, { runs: 1, profiles: 3, tracks: 3 });
});

test("A2 unknown target id → 400 and zero rows", () => {
  const f = fixture(2); const before = counts();
  const r = post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct, target_ids: [f.targets[0], "nope"] });
  assert.equal(r.status, 400);
  assert.deepEqual(counts(), before);
});

test("A3 all targets already enrolled → 400 and zero rows", () => {
  const f = fixture(2);
  assert.equal(post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct }).status, 201);
  getDb().prepare("UPDATE runs SET status = 'completed' WHERE workflow_id = ?").run(f.wf);
  const before = counts();
  const r = post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct });
  assert.equal(r.status, 400);
  assert.equal((r.body as { error: string }).error, "all_already_enrolled");
  assert.deepEqual(counts(), before);
});

test("A4 injected child-write failure rolls back the parent too", () => {
  const f = fixture(3); const before = counts(); const db = getDb();
  // Fires on the FIRST track insert — after the run and first profile rows are already in the transaction.
  db.exec("CREATE TRIGGER a4_fail BEFORE INSERT ON run_profile_tracks BEGIN SELECT RAISE(ABORT, 'injected child failure'); END");
  try {
    const r = post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct });
    assert.equal(r.status, 500);
    assert.match((r.body as { error: string }).error, /injected child failure/);
  } finally { db.exec("DROP TRIGGER a4_fail"); }
  assert.deepEqual(counts(), before, "no run, profile or track may survive a failed child write");
});

test("A5 second create for an active workflow → 409 and zero rows", () => {
  const f = fixture(2);
  assert.equal(post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct }).status, 201);
  getDb().prepare("UPDATE runs SET status = 'running' WHERE workflow_id = ?").run(f.wf);
  const before = counts();
  const r = post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct });
  assert.equal(r.status, 409);
  assert.deepEqual(counts(), before);
});
