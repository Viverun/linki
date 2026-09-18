import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-cancel-followup-decides-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-cancel-followup-decides-tests";

const { default: handler } = await import("@/pages/api/inbox/[replyId]/cancel-followup");
const { getDb } = await import("@/lib/db");
const { retryUndecidedReplies } = await import("@/lib/email/reply-policy");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

type Judgment = { pOoo: number; model: string; returnDate: { chosen: string | null; confidence: number } | null };
const judgeReturning = (j: Judgment) => async () => j;

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
  const ids = { run: `run-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, track: `track-${n}`, target: `target-${n}`, reply: `reply-${n}` };
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(ids.run, ids.wf);
  db.prepare("INSERT INTO targets (id, full_name, linkedin_url, email) VALUES (?, 'Ada', ?, ?)").run(ids.target, `https://www.linkedin.com/in/ada-${n}/`, `ada-${n}@fixture.test`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, next_step_at) VALUES (?, ?, 'email', 'in_progress', 1, '2026-01-01T00:00:00.000Z')").run(ids.track, ids.profile);
  // Undecided: dispatched_at IS NULL, as a captured but not-yet-judged open-core reply.
  db.prepare("INSERT INTO email_replies (id, target_id, run_id, from_email, subject, body_text, received_at) VALUES (?, ?, ?, ?, 'Re: hi', 'no thanks', datetime('now'))")
    .run(ids.reply, ids.target, ids.run, `ada-${n}@fixture.test`);
  return ids;
}

test("cancelling an undecided reply stamps dispatched_at, so it cannot be re-judged by the open-core sweep afterwards", async () => {
  const s = scenario();
  const db = getDb();

  const before = db.prepare("SELECT dispatched_at FROM email_replies WHERE id = ?").get(s.reply) as { dispatched_at: string | null };
  assert.equal(before.dispatched_at, null, "sanity: reply starts undecided");

  const r = post(s.reply);
  assert.equal(r.status, 200);

  const afterCancel = db.prepare("SELECT dispatched_at, dispatch_result_json FROM email_replies WHERE id = ?").get(s.reply) as
    { dispatched_at: string | null; dispatch_result_json: string | null };
  assert.ok(afterCancel.dispatched_at, "cancel is a decision — it must stamp dispatched_at");
  assert.deepEqual(JSON.parse(afterCancel.dispatch_result_json!), { kind: "cancelled", notes: "Follow-up cancelled from inbox" });

  // The open-core sweep must now skip this reply entirely — it is no longer undecided —
  // even though a judge that would decide "not OOO" (p_ooo high) is available.
  const decided = await retryUndecidedReplies(getDb(), judgeReturning({ pOoo: 0.99, model: "jev-test", returnDate: null }));
  assert.equal(decided, 0, "the cancelled reply is not among the undecided rows the sweep picks up");

  const afterSweep = db.prepare("SELECT dispatched_at, dispatch_result_json FROM email_replies WHERE id = ?").get(s.reply) as
    { dispatched_at: string | null; dispatch_result_json: string | null };
  assert.equal(afterSweep.dispatched_at, afterCancel.dispatched_at, "the sweep must not touch a decided row's timestamp");
  assert.match(afterSweep.dispatch_result_json!, /cancelled/, "the operator's cancel decision must survive the sweep untouched");
});
