import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-reply-policy-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-reply-policy-tests";

const { getDb } = await import("@/lib/db");
const { decideReplyOpenCore, retryUndecidedReplies, extractDateCandidates, parseReturnDate } = await import("@/lib/email/reply-policy");
const { getReplyOooThreshold, setReplyOooThreshold } = await import("@/lib/email/reply-settings");
const { encryptSecret } = await import("@/lib/crypto");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

type Judgment = { pOoo: number; model: string; returnDate: { chosen: string | null; confidence: number } | null };
const judgeReturning = (j: Judgment) => async () => j;
const judgeThrowing = () => async () => { throw new Error("synthetic judge failure"); };

let seq = 0;
function scenario(opts: { body?: string; nextStepAt?: string | null } = {}) {
  const n = ++seq; const db = getDb();
  const ids = { run: `run-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, track: `track-${n}`, target: `target-${n}`, reply: `reply-${n}` };
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(ids.run, ids.wf);
  db.prepare("INSERT INTO targets (id, full_name, linkedin_url, email) VALUES (?, 'Ada', ?, ?)").run(ids.target, `https://www.linkedin.com/in/ada-${n}/`, `ada-${n}@fixture.test`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, next_step_at, last_email_subject, last_email_body) VALUES (?, ?, 'email', 'in_progress', 1, ?, 'Our subject', 'Our body')").run(ids.track, ids.profile, opts.nextStepAt ?? null);
  db.prepare("INSERT INTO email_replies (id, target_id, run_id, from_email, subject, body_text, received_at) VALUES (?, ?, ?, ?, 'Re: Our subject', ?, datetime('now'))")
    .run(ids.reply, ids.target, ids.run, `ada-${n}@fixture.test`, opts.body ?? "I am out of the office until 2 October 2026 with limited access to email.");
  return ids;
}
const reply = (id: string) => getDb().prepare("SELECT dispatched_at, dispatch_result_json, classification_json, classification_error, open_core_attempts FROM email_replies WHERE id = ?").get(id) as
  { dispatched_at: string | null; dispatch_result_json: string | null; classification_json: string | null; classification_error: string | null; open_core_attempts: number };
const target = (id: string) => getDb().prepare("SELECT email_replied_at FROM targets WHERE id = ?").get(id) as { email_replied_at: string | null };
const track = (id: string) => getDb().prepare("SELECT next_step_at, state FROM run_profile_tracks WHERE id = ?").get(id) as { next_step_at: string | null; state: string };
const withKey = () => getDb().prepare("INSERT INTO integrations (key, api_key) VALUES ('typesafe', ?) ON CONFLICT(key) DO UPDATE SET api_key = excluded.api_key").run(encryptSecret("synthetic-key"));

test("P1 high-probability OOO continues: decision recorded, no stamp, track rescheduled after the return date", async () => {
  withKey(); const s = scenario({ nextStepAt: null });
  const d = await decideReplyOpenCore(getDb(), s.reply, judgeReturning({ pOoo: 0.97, model: "jev-test", returnDate: { chosen: "2 October 2026", confidence: 0.9 } }));
  assert.equal(d, "ooo_continue");
  const r = reply(s.reply);
  assert.ok(r.dispatched_at);
  assert.deepEqual(JSON.parse(r.dispatch_result_json!), { source: "open-core", decision: "ooo_continue", p_ooo: 0.97, threshold: 0.9, model: "jev-test", return_date: "2026-10-02", attempts: 1 });
  assert.deepEqual(JSON.parse(r.classification_json!), { kind: "out_of_office", summary: "Automatic out-of-office reply (p=0.97); back 2026-10-02" });
  assert.equal(target(s.target).email_replied_at, null);
  assert.equal(track(s.track).next_step_at, "2026-10-03T09:00:00.000Z");
  const act = getDb().prepare("SELECT body FROM activity_logs WHERE target_id = ? ORDER BY rowid DESC LIMIT 1").get(s.target) as { body: string };
  assert.match(act.body, /Out-of-office reply — follow-up continues after 2026-10-03/);
});

test("P2 return date never moves next_step_at earlier", async () => {
  withKey(); const s = scenario({ nextStepAt: "2026-12-01T00:00:00.000Z" });
  await decideReplyOpenCore(getDb(), s.reply, judgeReturning({ pOoo: 0.97, model: "jev-test", returnDate: { chosen: "2 October 2026", confidence: 0.9 } }));
  assert.equal(track(s.track).next_step_at, "2026-12-01T00:00:00.000Z");
});

test("P3 low-confidence or missing return date leaves the schedule alone", async () => {
  withKey(); const s = scenario({ nextStepAt: null });
  await decideReplyOpenCore(getDb(), s.reply, judgeReturning({ pOoo: 0.95, model: "jev-test", returnDate: { chosen: "2 October 2026", confidence: 0.4 } }));
  assert.equal(track(s.track).next_step_at, null);
  assert.equal(JSON.parse(reply(s.reply).dispatch_result_json!).return_date, null);
});

test("P4 below threshold is a human reply: stamp email_replied_at, decision recorded, tracks untouched here", async () => {
  withKey(); const s = scenario({ body: "Not interested, please stop emailing me." });
  const d = await decideReplyOpenCore(getDb(), s.reply, judgeReturning({ pOoo: 0.12, model: "jev-test", returnDate: null }));
  assert.equal(d, "human_reply");
  assert.ok(target(s.target).email_replied_at);
  assert.equal(JSON.parse(reply(s.reply).dispatch_result_json!).decision, "human_reply");
  assert.equal(JSON.parse(reply(s.reply).classification_json!).kind, "human_reply");
  assert.equal(track(s.track).state, "in_progress", "the runner, not the policy, converts the stamp into a skip");
});

test("P5 a judge failure leaves the reply undecided with the error and attempts=1", async () => {
  withKey(); const s = scenario();
  const d = await decideReplyOpenCore(getDb(), s.reply, judgeThrowing());
  assert.equal(d, "undecided");
  const r = reply(s.reply);
  assert.equal(r.dispatched_at, null);
  assert.match(r.classification_error ?? "", /synthetic judge failure/);
  assert.equal(r.open_core_attempts, 1);
  assert.equal(target(s.target).email_replied_at, null);
});

test("P6 third failure fails closed as human_reply with a reason", async () => {
  withKey(); const s = scenario();
  await decideReplyOpenCore(getDb(), s.reply, judgeThrowing());
  await decideReplyOpenCore(getDb(), s.reply, judgeThrowing());
  const d = await decideReplyOpenCore(getDb(), s.reply, judgeThrowing());
  assert.equal(d, "human_reply");
  const j = JSON.parse(reply(s.reply).dispatch_result_json!);
  assert.equal(j.reason, "judgment failed 3 times — failing closed");
  assert.equal(j.attempts, 3);
  assert.ok(target(s.target).email_replied_at);
});

test("P7 missing API key behaves like a judge failure (undecided)", async () => {
  getDb().prepare("DELETE FROM integrations WHERE key = 'typesafe'").run();
  const s = scenario();
  const d = await decideReplyOpenCore(getDb(), s.reply); // real judge, no key
  assert.equal(d, "undecided");
  assert.match(reply(s.reply).classification_error ?? "", /TypeSafe API key/);
  withKey();
});

test("P8 an already-decided reply is a no-op (operator decisions win)", async () => {
  withKey(); const s = scenario();
  getDb().prepare("UPDATE email_replies SET dispatched_at = datetime('now'), dispatch_result_json = '{\"source\":\"open-core\",\"decision\":\"operator_continue\"}' WHERE id = ?").run(s.reply);
  const d = await decideReplyOpenCore(getDb(), s.reply, judgeReturning({ pOoo: 0.1, model: "jev-test", returnDate: null }));
  assert.equal(d, "operator_continue");
  assert.equal(target(s.target).email_replied_at, null);
});

test("P9 threshold comes from app_settings and is clamped", async () => {
  withKey();
  assert.equal(getReplyOooThreshold(getDb()), 0.9);
  setReplyOooThreshold(getDb(), 0.6);
  assert.equal(getReplyOooThreshold(getDb()), 0.6);
  const s = scenario();
  const d = await decideReplyOpenCore(getDb(), s.reply, judgeReturning({ pOoo: 0.7, model: "jev-test", returnDate: null }));
  assert.equal(d, "ooo_continue");
  assert.throws(() => setReplyOooThreshold(getDb(), 0.3), RangeError);
  assert.throws(() => setReplyOooThreshold(getDb(), 1), RangeError);
  setReplyOooThreshold(getDb(), 0.9);
});

test("P10 retryUndecidedReplies decides only undecided rows and reports the count", async () => {
  // All tests in this file share one db (P5/P7 intentionally leave undecided rows behind);
  // this test owns its precondition by neutrally closing out anything left over before it runs.
  getDb().prepare("UPDATE email_replies SET dispatched_at = datetime('now'), dispatch_result_json = '{\"source\":\"test\",\"decision\":\"operator_continue\"}' WHERE dispatched_at IS NULL").run();
  withKey(); const a = scenario(); const b = scenario();
  getDb().prepare("UPDATE email_replies SET dispatched_at = datetime('now') WHERE id = ?").run(b.reply);
  const n = await retryUndecidedReplies(getDb(), judgeReturning({ pOoo: 0.99, model: "jev-test", returnDate: null }));
  assert.equal(n, 1);
  assert.ok(reply(a.reply).dispatched_at);
});

test("D1 extractDateCandidates finds common forms, caps at 8", () => {
  const c = extractDateCandidates("Back on 2 October 2026, or October 3rd, 2026, or 2026-10-04, or 05/10/2026. Monday 6th at the latest.");
  assert.ok(c.includes("2 October 2026"));
  assert.ok(c.includes("October 3rd, 2026"));
  assert.ok(c.includes("2026-10-04"));
  assert.ok(c.includes("05/10/2026"));
  assert.ok(c.length <= 8);
  assert.equal(extractDateCandidates("no dates here").length, 0);
});

test("D2 parseReturnDate resolves relative to today and rejects junk", () => {
  const today = new Date("2026-09-18T00:00:00Z");
  assert.equal(parseReturnDate("2 October 2026", today)?.toISOString(), "2026-10-02T00:00:00.000Z");
  assert.equal(parseReturnDate("2026-10-04", today)?.toISOString(), "2026-10-04T00:00:00.000Z");
  assert.equal(parseReturnDate("October 3rd, 2026", today)?.toISOString(), "2026-10-03T00:00:00.000Z");
  assert.equal(parseReturnDate("2 October", today)?.toISOString(), "2026-10-02T00:00:00.000Z", "year-less date resolves to the next occurrence");
  assert.equal(parseReturnDate("none", today), null);
  assert.equal(parseReturnDate("31 February 2026", today), null);
});
