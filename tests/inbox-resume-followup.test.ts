import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-resume-followup-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-resume-followup-tests";

const { default: handler } = await import("@/pages/api/inbox/[replyId]/resume-followup");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

function post(replyId: string) {
  const captured = { status: 200, body: undefined as unknown };
  const res = { status(c: number) { captured.status = c; return this; }, json(p: unknown) { captured.body = p; return this; }, end() { return this; }, setHeader() { return this; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler({ method: "POST", query: { replyId } } as any, res as any);
  return captured;
}
let seq = 0;
function scenario() {
  const n = ++seq; const db = getDb();
  const ids = { run: `run-${n}`, other: `other-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, otherProfile: `oprofile-${n}`, email: `tr-e-${n}`, linkedin: `tr-l-${n}`, otherTrack: `tr-o-${n}`, target: `target-${n}`, reply: `reply-${n}` };
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(ids.run, ids.wf);
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(ids.other, ids.wf);
  db.prepare("INSERT INTO targets (id, full_name, linkedin_url, email, email_replied_at) VALUES (?, 'Ada', ?, ?, datetime('now'))").run(ids.target, `https://www.linkedin.com/in/ada-${n}/`, `ada-${n}@fixture.test`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.otherProfile, ids.other, ids.target);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, error_message, next_step_at) VALUES (?, ?, 'email', 'skipped', 1, 'Lead replied', '2026-01-01T00:00:00.000Z')").run(ids.email, ids.profile);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, error_message) VALUES (?, ?, 'linkedin', 'skipped', 0, 'Lead replied')").run(ids.linkedin, ids.profile);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, error_message) VALUES (?, ?, 'email', 'skipped', 0, 'Lead replied')").run(ids.otherTrack, ids.otherProfile);
  db.prepare("INSERT INTO email_replies (id, target_id, run_id, from_email, subject, body_text, received_at, dispatched_at, dispatch_result_json) VALUES (?, ?, ?, 'a@b.test', 'Re', 'no thanks', datetime('now'), datetime('now'), '{\"source\":\"open-core\",\"decision\":\"human_reply\",\"p_ooo\":0.12}')").run(ids.reply, ids.target, ids.run);
  return ids;
}
const track = (id: string) => getDb().prepare("SELECT state, next_step_at, error_message FROM run_profile_tracks WHERE id = ?").get(id) as { state: string; next_step_at: string | null; error_message: string | null };

test("R1 unknown reply → 404", () => {
  const r = post("nope");
  assert.equal(r.status, 404);
});

test("R2 resume clears the stamp, re-arms only this run's 'Lead replied' tracks, records operator_continue", () => {
  const s = scenario();
  const r = post(s.reply);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, rearmed: 2 });
  const db = getDb();
  assert.equal((db.prepare("SELECT email_replied_at FROM targets WHERE id = ?").get(s.target) as { email_replied_at: string | null }).email_replied_at, null);
  assert.deepEqual(track(s.email), { state: "in_progress", next_step_at: null, error_message: null });
  assert.equal(track(s.linkedin).state, "in_progress");
  assert.equal(track(s.otherTrack).state, "skipped", "another run's track is not touched");
  const rep = db.prepare("SELECT dispatch_result_json FROM email_replies WHERE id = ?").get(s.reply) as { dispatch_result_json: string };
  const parsed = JSON.parse(rep.dispatch_result_json);
  assert.equal(parsed.decision, "operator_continue");
  assert.equal(parsed.p_ooo, 0.12, "resume merges onto the prior JSON — the model's audit trail survives");
  assert.ok(parsed.resumed_at, "resume stamps when the operator override happened");
  const act = db.prepare("SELECT body FROM activity_logs WHERE target_id = ? ORDER BY rowid DESC LIMIT 1").get(s.target) as { body: string };
  assert.equal(act.body, "Follow-ups resumed from inbox");
});

test("R3 second resume is idempotent", () => {
  const s = scenario();
  post(s.reply);
  const r = post(s.reply);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, rearmed: 0 });
});

test("R4 an undecided reply is also decided by resume", () => {
  const s = scenario();
  getDb().prepare("UPDATE email_replies SET dispatched_at = NULL, dispatch_result_json = NULL WHERE id = ?").run(s.reply);
  post(s.reply);
  const rep = getDb().prepare("SELECT dispatched_at, dispatch_result_json FROM email_replies WHERE id = ?").get(s.reply) as { dispatched_at: string | null; dispatch_result_json: string };
  assert.ok(rep.dispatched_at);
  assert.equal(JSON.parse(rep.dispatch_result_json).decision, "operator_continue");
});

test("R5 resume re-arms a track cancelled from the inbox, not just one skipped with 'Lead replied'", () => {
  const s = scenario();
  const db = getDb();
  db.prepare("UPDATE run_profile_tracks SET error_message = 'Follow-up cancelled from inbox' WHERE id = ?").run(s.email);
  const r = post(s.reply);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, rearmed: 2 });
  assert.equal(track(s.email).state, "in_progress");
});
