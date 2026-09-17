import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-retry-identity-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-retry-identity-tests";

const { default: retryHandler } = await import("@/pages/api/runs/[id]/retry");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

function callRetry(runId: string, body: unknown) {
  const captured = { status: 200, body: undefined as unknown };
  const res = { status(c: number) { captured.status = c; return this; }, json(p: unknown) { captured.body = p; return this; }, end() { return this; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retryHandler({ method: "POST", query: { id: runId }, body } as any, res as any);
  return captured.body as { outcomes: Array<{ outcome: string; reason?: string }> };
}

let seq = 0;
/** Three connect steps A,B,C; track failed on B (index 1). */
function scenario(opts: { pinnedId?: string | null; index?: number } = {}) {
  const n = ++seq; const db = getDb();
  const ids = { run: `run-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, track: `track-${n}`, target: `target-${n}`, A: `A-${n}`, B: `B-${n}`, C: `C-${n}` };
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  for (const [id, order] of [[ids.A, 1], [ids.B, 2], [ids.C, 3]] as const) {
    db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, ai_enabled) VALUES (?, ?, ?, 'linkedin', 'connect', 0, 0)").run(id, ids.wf, order);
  }
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(ids.run, ids.wf);
  db.prepare("INSERT INTO targets (id, full_name, linkedin_url) VALUES (?, 'Ada', ?)").run(ids.target, `https://www.linkedin.com/in/ada-${n}/`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, current_step_id, error_message) VALUES (?, ?, 'linkedin', 'failed', ?, ?, 'boom')")
    .run(ids.track, ids.profile, opts.index ?? 1, opts.pinnedId === undefined ? ids.B : opts.pinnedId);
  return ids;
}
const trackOf = (id: string) => getDb().prepare("SELECT state, current_step, current_step_id FROM run_profile_tracks WHERE id = ?").get(id) as { state: string; current_step: number; current_step_id: string | null };
const reorder = (wf: string, order: string[]) => order.forEach((id, i) => getDb().prepare("UPDATE workflow_steps SET step_order = ? WHERE id = ? AND workflow_id = ?").run(i + 1, id, wf));

test("I1 pinned step reordered: retry resolves by id and keeps the pin", () => {
  const s = scenario();
  reorder(s.wf, [s.B, s.A, s.C]); // B now index 0, stored index says 1 (= A)
  const { outcomes } = callRetry(s.run, { target_ids: [s.target] });
  assert.equal(outcomes[0].outcome, "rearmed");
  const t = trackOf(s.track);
  assert.equal(t.state, "in_progress");
  assert.equal(t.current_step_id, s.B);
  assert.equal(t.current_step, 0, "index is re-synced to where the pinned step now lives");
});

test("I2 pinned step deleted: retry blocks and touches nothing", () => {
  const s = scenario();
  getDb().prepare("DELETE FROM workflow_steps WHERE id = ?").run(s.B);
  const { outcomes } = callRetry(s.run, { target_ids: [s.target] });
  assert.equal(outcomes[0].outcome, "blocked");
  assert.match(outcomes[0].reason ?? "", /no longer exists/);
  assert.equal(trackOf(s.track).state, "failed");
});

test("I3 legacy track with no pin resolves by index and is pinned on re-arm", () => {
  const s = scenario({ pinnedId: null, index: 1 });
  const { outcomes } = callRetry(s.run, { target_ids: [s.target] });
  assert.equal(outcomes[0].outcome, "rearmed");
  assert.equal(trackOf(s.track).current_step_id, s.B);
});

test("I4 legacy track past the end blocks explicitly", () => {
  const s = scenario({ pinnedId: null, index: 7 });
  const { outcomes } = callRetry(s.run, { target_ids: [s.target] });
  assert.equal(outcomes[0].outcome, "blocked");
  assert.match(outcomes[0].reason ?? "", /past the last step/);
});

test("I5 a confirmed message ledger row advances from the RESOLVED index after a reorder", () => {
  const s = scenario();
  getDb().prepare("UPDATE workflow_steps SET step_type = 'message', message_body = 'hi', message_position = 1 WHERE id = ?").run(s.B);
  getDb().prepare(
    `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, started_at, confirmed_at)
     VALUES ('se-i5', ?, 'linkedin', ?, ?, 'message', 'confirmed', datetime('now'), datetime('now'))`
  ).run(s.profile, `stepid:${s.B}`, s.target);
  reorder(s.wf, [s.B, s.A, s.C]); // B → index 0, so "advance" must land on A (index 1), not C
  const { outcomes } = callRetry(s.run, { target_ids: [s.target] });
  assert.equal(outcomes[0].outcome, "advanced");
  const t = trackOf(s.track);
  assert.equal(t.current_step, 1);
  assert.equal(t.current_step_id, s.A);
});
