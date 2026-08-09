import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/db.ts resolves the DB path on first getDb(), so set it before loading.
const dbDir = mkdtempSync(join(tmpdir(), "linki-connect-idem-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-connect-idempotence-tests";

// ─── sandbox ─────────────────────────────────────────────────────────────────
// Every LinkedIn entry point the connect step can reach is replaced before the
// runner is loaded, so these tests can never open a browser or touch a real
// account. getLinkedinUrl short-circuits on a /in/ URL, so no other module is
// involved once these two are mocked.

// @types/node is pinned at v20, which still types mock.module's old
// `namedExports` option. Node 24 deprecates that in favour of `exports`, so
// call the runtime-correct shape through a locally narrowed type.
// Bound, not detached — mock.module reads private state off `mock`.
const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { exports: Record<string, unknown> }) => void;

const realConnect = await import("@/lib/linkedin/connect");
const { PendingInviteError, InviteNotSentError, SessionExpiredError, InviteUiError } = realConnect;

/** What sendConnectionRequest should do on the next call. */
let sendBehaviour: () => void | never = () => {};
let sendCalls = 0;

mockModule("@/lib/linkedin/connect", {
  exports: {
    ...realConnect,
    sendConnectionRequest: async () => { sendCalls++; sendBehaviour(); },
  },
});

const realSession = await import("@/lib/linkedin/session");
let pagesClosed = 0;
mockModule("@/lib/linkedin/session", {
  exports: {
    ...realSession,
    getSessionPage: async () => ({ close: async () => { pagesClosed++; } }),
    saveSessionState: async () => {},
  },
});

const { executeStep } = await import("@/lib/linkedin/runner");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened, or already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const CONNECT_STEP = {
  id: "step-connect",
  step_order: 1,
  track: "linkedin",
  step_type: "connect",
  template_id: null,
  delay_seconds: 0,
  connect_note: null,
  message_body: null,
  email_subject: null,
  email_body: null,
  ai_enabled: 0,
  ai_model: null,
  ai_prompt: null,
  ai_max_words: null,
  ai_language: null,
  email_position: 1,
  message_position: 1,
  email_signature: null,
};

// 24/7 window so enforceSchedule never reschedules and the step always runs.
const LIMITS = {
  active_hours_start: 0,
  active_hours_end: 24,
  timezone: "UTC",
  working_days: "1,2,3,4,5,6,7",
  daily_connection_limit: 20,
  daily_message_limit: 50,
  daily_inmail_limit: 15,
};

let seq = 0;
/** A full run/profile/track/target chain ready for the connect step. */
function scenario(opts: { connectionRequestedAt?: string | null } = {}) {
  const n = ++seq;
  const runId = `run-${n}`;
  const profileId = `profile-${n}`;
  const trackId = `track-${n}`;
  const targetId = `target-${n}`;
  const db = getDb();

  db.prepare("INSERT INTO runs (id, status) VALUES (?, 'running')").run(runId);
  db.prepare("INSERT INTO targets (id, linkedin_url, full_name, connection_requested_at) VALUES (?, ?, ?, ?)")
    .run(targetId, `https://www.linkedin.com/in/test-${n}/`, `Test Person ${n}`, opts.connectionRequestedAt ?? null);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(profileId, runId, targetId);
  db.prepare(
    `INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, next_step_at)
     VALUES (?, ?, 'linkedin', 'in_progress', 0, NULL)`
  ).run(trackId, profileId);

  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(targetId);
  const tr = {
    ...(db.prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(trackId) as object),
    run_id: runId,
    target_id: targetId,
    email_account_id: null,
    account_id: `account-${n}`,
    workflow_id: `workflow-${n}`,
    connection_requested_at: opts.connectionRequestedAt ?? null,
  };

  return { runId, trackId, targetId, tr, target };
}

const run = (s: ReturnType<typeof scenario>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeStep(getDb(), s.runId, s.tr as any, s.target as any, [CONNECT_STEP] as any, "account-x", LIMITS);

const trackOf = (id: string) =>
  getDb().prepare("SELECT state, current_step, next_step_at, error_message FROM run_profile_tracks WHERE id = ?").get(id) as
    { state: string; current_step: number; next_step_at: string | null; error_message: string | null };

const requestedAtOf = (id: string) =>
  (getDb().prepare("SELECT connection_requested_at FROM targets WHERE id = ?").get(id) as
    { connection_requested_at: string | null }).connection_requested_at;

/** Hours between now and an ISO timestamp. */
const hoursAhead = (iso: string) => (new Date(iso).getTime() - Date.now()) / 3600_000;

function reset(behaviour: () => void | never) {
  sendBehaviour = behaviour;
  sendCalls = 0;
  pagesClosed = 0;
}

// ─── (1) already requested → no invite attempted ─────────────────────────────

test("an already-requested connection is not re-sent, it just waits for the recheck", async () => {
  reset(() => { throw new Error("sendConnectionRequest must not be called"); });
  const requestedAt = new Date(Date.now() - 3600_000).toISOString();
  const s = scenario({ connectionRequestedAt: requestedAt });

  await run(s);

  assert.equal(sendCalls, 0, "no invitation may be attempted");
  assert.equal(requestedAtOf(s.targetId), requestedAt, "the original request time must be preserved");

  const tk = trackOf(s.trackId);
  assert.equal(tk.state, "in_progress", "must not be marked failed");
  assert.equal(tk.current_step, 0, "must not advance past the connect step");
  assert.ok(Math.abs(hoursAhead(tk.next_step_at!) - 6) < 0.1, "must wait the normal 6h recheck");
});

// ─── (2) PendingInviteError → treated as already requested ───────────────────

test("PendingInviteError is recovered as 'already requested', not retried or failed", async () => {
  // The lost-write crash window: LinkedIn already holds the invite but
  // connection_requested_at was never persisted.
  reset(() => { throw new PendingInviteError("invite already pending"); });
  const s = scenario({ connectionRequestedAt: null });

  await run(s);

  assert.equal(sendCalls, 1, "exactly one attempt — the error must not trigger a retry");

  const stamped = requestedAtOf(s.targetId);
  assert.ok(stamped, "the pending invite must now be recorded so the next pass is a no-op");

  const tk = trackOf(s.trackId);
  assert.equal(tk.state, "in_progress", "a pending invite is not a run failure");
  assert.equal(tk.error_message, null, "no error must be recorded");
  assert.equal(tk.current_step, 0, "must not advance past the connect step");
  assert.ok(Math.abs(hoursAhead(tk.next_step_at!) - 6) < 0.1, "must wait the normal 6h recheck");
});

test("recovering from PendingInviteError makes the next pass send nothing", async () => {
  // End-to-end idempotence: the second pass must take the already-requested
  // branch, which is the whole point of stamping the timestamp.
  reset(() => { throw new PendingInviteError("invite already pending"); });
  const s = scenario({ connectionRequestedAt: null });
  await run(s);
  const stampedAfterFirst = requestedAtOf(s.targetId);

  // Second pass, with the track re-read from the DB as the runner would.
  reset(() => { throw new Error("sendConnectionRequest must not be called on the retry"); });
  const s2 = { ...s, tr: { ...s.tr, connection_requested_at: stampedAfterFirst }, target: getDb().prepare("SELECT * FROM targets WHERE id = ?").get(s.targetId) };
  await run(s2 as ReturnType<typeof scenario>);

  assert.equal(sendCalls, 0, "no second invitation");
  assert.equal(requestedAtOf(s.targetId), stampedAfterFirst, "the original stamp must be kept");
});

test("PendingInviteError does not overwrite an existing connection_requested_at", async () => {
  const original = new Date(Date.now() - 5 * 3600_000).toISOString();
  reset(() => { throw new PendingInviteError("invite already pending"); });
  // Track says not-yet-requested (stale read) while the row already has a stamp —
  // the COALESCE must keep the true, earlier time.
  const s = scenario({ connectionRequestedAt: null });
  getDb().prepare("UPDATE targets SET connection_requested_at = ? WHERE id = ?").run(original, s.targetId);

  await run(s);

  assert.equal(requestedAtOf(s.targetId), original, "the earlier request time must survive");
});

// ─── (3) other errors still fail — no false success ──────────────────────────

for (const [label, make] of [
  ["InviteNotSentError", () => new InviteNotSentError("not sent")],
  ["SessionExpiredError", () => new SessionExpiredError("session gone")],
  ["InviteUiError", () => new InviteUiError("ui changed")],
  ["a generic Error", () => new Error("boom")],
] as const) {
  test(`${label} still fails the track and records no connection request`, async () => {
    reset(() => { throw make(); });
    const s = scenario({ connectionRequestedAt: null });

    await run(s);

    assert.equal(sendCalls, 1);
    assert.equal(requestedAtOf(s.targetId), null, "a failed send must NOT look like a sent invite");

    const tk = trackOf(s.trackId);
    assert.equal(tk.state, "failed", "the error must surface as a failure");
    assert.ok(tk.error_message, "the failure reason must be recorded");
  });
}

// ─── (4) the successful path is unchanged ────────────────────────────────────

test("a successful send still records the request and schedules the 6h recheck", async () => {
  reset(() => {});
  const s = scenario({ connectionRequestedAt: null });

  await run(s);

  assert.equal(sendCalls, 1);
  assert.equal(pagesClosed, 1, "the page must still be closed");

  const stamped = requestedAtOf(s.targetId);
  assert.ok(stamped, "connection_requested_at must be recorded");
  assert.ok(Math.abs(hoursAhead(stamped!) - 0) < 0.1, "stamped at send time");

  const tk = trackOf(s.trackId);
  assert.equal(tk.state, "in_progress");
  assert.equal(tk.current_step, 0, "connect waits for acceptance rather than advancing");
  assert.ok(Math.abs(hoursAhead(tk.next_step_at!) - 6) < 0.1, "6h recheck scheduled");
});

// ─── D4.3: F2's self-healing claim, verified rather than asserted ────────────
// Task 3 makes 'completed' terminal, which removes the PATCH→running→retry route
// the audit cited as F2's manual recovery. The remaining claim is that the
// divergence self-heals on RE-ENROLMENT. That is a claim about behaviour, so it
// gets a test rather than a paragraph. See docs/audit-corrections.md, F2.

test("F2 self-heal: a sent-but-unrecorded invitation is stamped on re-enrolment with zero clicks", async () => {
  // The exact F2 shape: LinkedIn holds a pending invitation, the DB does not
  // know (connection_requested_at IS NULL) because verifyInvitationSent threw
  // after the invite landed.
  const s = scenario({ connectionRequestedAt: null });
  assert.equal(requestedAtOf(s.targetId), null, "precondition: DB has no record of the invitation");

  sendBehaviour = () => { throw new PendingInviteError("Invitation already pending"); };
  const before = sendCalls;

  await run(s);

  assert.equal(sendCalls, before + 1, "the shipped guard path runs");
  const stamped = requestedAtOf(s.targetId);
  assert.ok(stamped, "connection_requested_at is stamped from LinkedIn's own pending state");
  assert.equal(trackOf(s.trackId).state, "in_progress", "the track survives — no dead end");

  // And the next pass sends nothing: the divergence is closed, not papered over.
  const after = sendCalls;
  sendBehaviour = () => {};
  await run(s);
  assert.equal(sendCalls, after, "zero further invitation attempts once the DB agrees with LinkedIn");
});
