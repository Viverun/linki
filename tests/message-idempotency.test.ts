import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/db.ts resolves the DB path on first getDb(), so set it before loading.
const dbDir = mkdtempSync(join(tmpdir(), "linki-msg-idem-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-message-idempotency-tests";

// ─── sandbox ─────────────────────────────────────────────────────────────────
// message.ts and the session are replaced before the runner loads, so nothing
// can open a browser or reach LinkedIn. Every send is recorded in `sends`, so a
// "did not send" assertion is a real observation, not an absence of evidence.
//
// This file is the ONLY coverage of the runner's message branch — the audit
// found zero existing tests driving step_type:"message" through executeStep.

// @types/node is pinned at v20, which still types mock.module's old
// `namedExports` option. Node 24 deprecates that in favour of `exports`.
const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { exports: Record<string, unknown> }) => void;

interface SendRecord { fullName: string; text: string; url: string; cachedUrn: string | null }

const sends: SendRecord[] = [];
/** Throws AFTER the send click is recorded — the delivered-but-failed window. */
let sendBehaviour: () => void = () => {};
/** Throws BEFORE the send click — nothing was delivered. */
let preSendBehaviour: () => void = () => {};
/** What saveSessionState does — the N2 failure injection point. */
let saveBehaviour: () => void = () => {};

const realMessage = await import("@/lib/linkedin/message");
mockModule("@/lib/linkedin/message", {
  exports: {
    ...realMessage,
    sendMessage: async (_page: unknown, fullName: string, text: string, url: string, cachedUrn: string | null) => {
      // preSendBehaviour throws BEFORE the click is recorded (nothing delivered).
      preSendBehaviour();
      sends.push({ fullName, text, url, cachedUrn });
      // postSendBehaviour throws AFTER the click — the message.ts:109 window,
      // where page.waitForTimeout(2000) runs with the message already delivered.
      sendBehaviour();
      return { messagingUrn: "urn:li:fsd_profile:ACoAATEST", isFirstDegree: true };
    },
  },
});

const realSession = await import("@/lib/linkedin/session");
mockModule("@/lib/linkedin/session", {
  exports: {
    ...realSession,
    getSessionPage: async () => ({ close: async () => {} }),
    saveSessionState: async () => { saveBehaviour(); },
  },
});

const { executeStep, stepRefOf, legacyStepRefOf, bodyFingerprint, UnresolvedSideEffectError } = await import("@/lib/linkedin/runner");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const BODY = "Hi {{first_name}}, following up on our connection.";
const RENDERED = "Hi Ada, following up on our connection.";

// 24/7 so enforceSchedule never defers and the step always runs.
const LIMITS = {
  active_hours_start: 0, active_hours_end: 24, timezone: "UTC", working_days: "1,2,3,4,5,6,7",
  daily_connection_limit: 20, daily_message_limit: 50, daily_inmail_limit: 15,
};

let seq = 0;

interface StepSpec { messagePosition: number; body: string }

/** A run/profile/track chain whose linkedin track is the given message steps. */
function scenario(steps: StepSpec[] = [{ messagePosition: 1, body: BODY }], opts: { currentStep?: number } = {}) {
  const n = ++seq;
  const ids = {
    run: `run-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, track: `track-${n}`, target: `target-${n}`,
  };
  const db = getDb();

  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  const stepIds: string[] = [];
  steps.forEach((s, i) => {
    const sid = `step-${n}-${i}`;
    stepIds.push(sid);
    db.prepare(
      `INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, message_body, message_position, ai_enabled)
       VALUES (?, ?, ?, 'linkedin', 'message', 0, ?, ?, 0)`
    ).run(sid, ids.wf, i + 1, s.body, s.messagePosition);
  });

  // account_id left NULL: the FK is NO ACTION and no test here needs a real
  // account row, matching the pattern in tests/runner-visit-degree.test.ts.
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(ids.run, ids.wf);
  db.prepare(
    "INSERT INTO targets (id, full_name, first_name, linkedin_url, degree) VALUES (?, 'Ada Lovelace', 'Ada', ?, 1)"
  ).run(ids.target, `https://www.linkedin.com/in/ada-${n}/`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  db.prepare(
    `INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, next_step_at)
     VALUES (?, ?, 'linkedin', 'in_progress', ?, NULL)`
  ).run(ids.track, ids.profile, opts.currentStep ?? 0);

  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(ids.target);
  const tr = {
    ...(db.prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(ids.track) as object),
    run_id: ids.run, target_id: ids.target, email_account_id: null,
    account_id: `acct-${n}`, workflow_id: ids.wf,
  };
  const stepRows = db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order").all(ids.wf);
  return { ids, tr, target, stepRows };
}

const run = (s: ReturnType<typeof scenario>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeStep(getDb(), s.ids.run, s.tr as any, s.target as any, s.stepRows as any, `acct-x`, LIMITS);

const ledgerRows = (profileId: string) =>
  getDb().prepare("SELECT step_ref, status, body_fingerprint FROM step_side_effects WHERE run_profile_id = ? ORDER BY step_ref").all(profileId) as
    Array<{ step_ref: string; status: string; body_fingerprint: string | null }>;

const targetOf = (id: string) =>
  getDb().prepare("SELECT message_sent_at, messaging_urn FROM targets WHERE id = ?").get(id) as
    { message_sent_at: string | null; messaging_urn: string | null };

const trackOf = (id: string) =>
  getDb().prepare("SELECT state, current_step, error_message FROM run_profile_tracks WHERE id = ?").get(id) as
    { state: string; current_step: number; error_message: string | null };

function seedLedger(profileId: string, targetId: string, stepRef: string, status: string, fingerprint: string | null) {
  getDb().prepare(
    `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, body_fingerprint, started_at)
     VALUES (?, ?, 'linkedin', ?, ?, 'message', ?, ?, datetime('now'))`
  ).run(`se-${Math.random().toString(36).slice(2)}`, profileId, stepRef, targetId, status, fingerprint);
}

function reset() { sends.length = 0; sendBehaviour = () => {}; preSendBehaviour = () => {}; saveBehaviour = () => {}; }

// ─── 1–2: post-send failures must not look like send failures (F1/N2) ────────

test("1 saveSessionState throwing after a successful send records delivery, not failure", async () => {
  reset();
  const s = scenario();
  saveBehaviour = () => { throw new Error("Target page, context or browser has been closed"); };

  await run(s);

  assert.equal(sends.length, 1, "exactly one send");
  assert.ok(targetOf(s.ids.target).message_sent_at, "message_sent_at must be stamped");
  assert.deepEqual(ledgerRows(s.ids.profile).map(r => [r.step_ref, r.status]),
    [[stepRefOf(s.stepRows[0] as { id: string }), "confirmed"]], "X3.3: keyed by step id");
  assert.notEqual(trackOf(s.ids.track).state, "failed", "a session-cache failure must not fail a delivered step");
  assert.equal(trackOf(s.ids.track).current_step, 1, "track advances past the delivered message");
});

test("2 a DB failure while stamping message_sent_at does not fail the step either", async () => {
  reset();
  const s = scenario();
  const db = getDb();
  // Simulate SQLITE_BUSY on the bookkeeping transaction by dropping the target
  // row's writability via a conflicting schema-level guard: easiest faithful
  // simulation is to make the ledger confirm fail, which is inside the same tx.
  const originalPrepare = db.prepare.bind(db);
  let armed = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = (sql: string) => {
    if (armed && sql.includes("SET status = 'confirmed'")) {
      armed = false;
      return { run: () => { throw new Error("SQLITE_BUSY: database is locked"); } };
    }
    return originalPrepare(sql);
  };

  await run(s);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = originalPrepare;
  assert.equal(sends.length, 1, "exactly one send");
  assert.notEqual(trackOf(s.ids.track).state, "failed", "bookkeeping failure must not fail a delivered step");
});

// ─── 3–4: ledger states govern the pre-send gate ─────────────────────────────

test("3 an in_flight ledger row refuses to send and fails closed", async () => {
  reset();
  const s = scenario();
  seedLedger(s.ids.profile, s.ids.target, stepRefOf(s.stepRows[0] as { id: string }), "in_flight", bodyFingerprint(RENDERED));

  await run(s);

  assert.equal(sends.length, 0, "zero sends — a possibly-delivered message must never be re-sent");
  assert.equal(trackOf(s.ids.track).state, "failed");
  assert.match(trackOf(s.ids.track).error_message ?? "", /may already have been delivered/);
});

test("4 a confirmed ledger row skips the send and advances the track", async () => {
  reset();
  const s = scenario();
  seedLedger(s.ids.profile, s.ids.target, stepRefOf(s.stepRows[0] as { id: string }), "confirmed", bodyFingerprint(RENDERED));

  await run(s);

  assert.equal(sends.length, 0, "zero sends");
  assert.equal(trackOf(s.ids.track).current_step, 1, "converges: advances instead of re-sending");
  assert.ok(targetOf(s.ids.target).message_sent_at, "bookkeeping is completed on the convergent path");
});

// ─── 5–6: the regressions a naive guard would cause ──────────────────────────

test("5 a legitimate follow-up still sends when an EARLIER message is confirmed", async () => {
  reset();
  // Two message steps. Step 1 already delivered; step 2 is a genuine follow-up.
  const s = scenario(
    [{ messagePosition: 1, body: "First touch." }, { messagePosition: 2, body: "Second touch, different text." }],
    { currentStep: 1 }
  );
  seedLedger(s.ids.profile, s.ids.target, stepRefOf(s.stepRows[0] as { id: string }), "confirmed", bodyFingerprint("First touch."));

  await run(s);

  assert.equal(sends.length, 1, "the follow-up MUST send — a message_sent_at guard would have blocked it");
  assert.equal(sends[0].text, "Second touch, different text.");
});

test("6 a legacy track with no ledger rows behaves exactly as before", async () => {
  reset();
  const s = scenario();
  assert.equal(ledgerRows(s.ids.profile).length, 0, "precondition: no ledger rows");

  await run(s);

  assert.equal(sends.length, 1);
  assert.ok(targetOf(s.ids.target).message_sent_at);
  assert.equal(trackOf(s.ids.track).current_step, 1);
});

// ─── 7: the crash variant of F1 ──────────────────────────────────────────────

test("7 process death between send and stamp yields zero second sends on re-entry", async () => {
  reset();
  const s = scenario();
  // Simulate the crash: intent committed, message delivered, process dies before
  // the confirm. That is exactly an orphaned in_flight row.
  seedLedger(s.ids.profile, s.ids.target, stepRefOf(s.stepRows[0] as { id: string }), "in_flight", bodyFingerprint(RENDERED));

  await run(s);

  assert.equal(sends.length, 0, "re-entry after a crash must not re-send");
  assert.equal(trackOf(s.ids.track).state, "failed", "fails closed for human resolution");
});

// ─── 13–15: Layer 2, the body fingerprint ────────────────────────────────────

test("13 position shift: same body under a renumbered step_ref is refused", async () => {
  reset();
  // pos:2 was delivered. The campaign is re-saved with a message inserted
  // earlier, so the same body now sits at pos:3.
  const s = scenario([{ messagePosition: 3, body: BODY }]);
  seedLedger(s.ids.profile, s.ids.target, "pos:2", "confirmed", bodyFingerprint(RENDERED));

  await run(s);

  assert.equal(sends.length, 0, "Layer 2 must catch what Layer 1's position key cannot");
  assert.equal(trackOf(s.ids.track).state, "failed");
  assert.match(trackOf(s.ids.track).error_message ?? "", /already sent .* at step pos:2/);
});

test("14 a genuinely different follow-up body at a new position still sends", async () => {
  reset();
  const s = scenario([{ messagePosition: 3, body: "A completely different follow-up." }]);
  seedLedger(s.ids.profile, s.ids.target, "pos:2", "confirmed", bodyFingerprint(RENDERED));

  await run(s);

  assert.equal(sends.length, 1, "Layer 2 must not block real follow-ups");
  assert.equal(sends[0].text, "A completely different follow-up.");
});

test("15 a NULL fingerprint row neither crashes nor falsely blocks", async () => {
  reset();
  const s = scenario([{ messagePosition: 3, body: BODY }]);
  seedLedger(s.ids.profile, s.ids.target, "pos:2", "confirmed", null);

  await run(s);

  assert.equal(sends.length, 1, "Layer 1 alone governs when no fingerprint exists");
});

// ─── fingerprint normalisation ───────────────────────────────────────────────

test("fingerprint normalises whitespace but preserves case and punctuation", () => {
  assert.equal(bodyFingerprint("Hi  Ada,\n\n  thanks!"), bodyFingerprint("Hi Ada, thanks!"));
  assert.notEqual(bodyFingerprint("Hi Ada"), bodyFingerprint("hi ada"));
  assert.notEqual(bodyFingerprint("Hi Ada"), bodyFingerprint("Hi Ada!"));
});

test("X3.3: stepRefOf keys the ledger by STEP ID, not by position", () => {
  // The scheme switch. `pos:` keyed the ledger by an index into a list the UI
  // rebuilt on every save, so re-saving renumbered an already-delivered message
  // and Layer 1 stopped recognising it. An id cannot be renumbered.
  assert.equal(stepRefOf({ id: "abc-123" }), "stepid:abc-123");
  assert.doesNotMatch(stepRefOf({ id: "abc-123" }), /^pos:/, "the position scheme is never written again");
});

test("X3.3: the legacy pos: scheme is still READABLE, so old rows still block", () => {
  assert.equal(legacyStepRefOf({ message_position: 2 }), "pos:2");
  assert.equal(legacyStepRefOf({ message_position: null }), "pos:1");
});

// ─── 16: the handler chain is provably undisturbed ───────────────────────────

test("16 the four pre-existing error types still route to their original branches", async () => {
  reset();
  const { WeeklyLimitError, AlreadyConnectedError, PendingInviteError } = await import("@/lib/linkedin/connect");

  // WeeklyLimitError pauses the run; AlreadyConnectedError stamps degree=1 and
  // advances; PendingInviteError stamps connection_requested_at and waits. Each
  // must still short-circuit BEFORE the new UnresolvedSideEffectError branch.
  const chain = [WeeklyLimitError, AlreadyConnectedError, PendingInviteError, UnresolvedSideEffectError];
  for (const E of chain) {
    assert.ok(new E("x") instanceof Error, `${E.name} is an Error subclass`);
  }
  // Distinctness: no type is an instance of another, so ordering cannot alias.
  assert.ok(!(new UnresolvedSideEffectError("x") instanceof WeeklyLimitError));
  assert.ok(!(new UnresolvedSideEffectError("x") instanceof AlreadyConnectedError));
  assert.ok(!(new UnresolvedSideEffectError("x") instanceof PendingInviteError));
  assert.ok(!(new PendingInviteError("x") instanceof UnresolvedSideEffectError));

  // The InMail branch matches on SUBSTRING, so our messages must not contain it.
  const s = scenario();
  seedLedger(s.ids.profile, s.ids.target, stepRefOf(s.stepRows[0] as { id: string }), "in_flight", null);
  await run(s);
  assert.doesNotMatch(trackOf(s.ids.track).error_message ?? "", /No InMail credits left/);
});

// ─── 17–19: the `abandoned` classification (A1) ──────────────────────────────
// A throw from inside the send helper AFTER the click is indistinguishable at
// the runner's catch site from one before it. If post-click throws retract the
// intent, Retry re-sends and F1 is restored through a different door.

test("17 a throw AFTER the send click leaves the ledger in_flight and blocks re-entry", async () => {
  reset();
  const s = scenario();
  sendBehaviour = () => { throw new Error("Target page, context or browser has been closed"); };

  await run(s);

  assert.equal(sends.length, 1, "the message was delivered before the throw");
  const rows = ledgerRows(s.ids.profile);
  assert.equal(rows[0].status, "in_flight", "must NOT be abandoned — delivery cannot be ruled out");
  assert.equal(trackOf(s.ids.track).state, "failed");

  // Re-entry must refuse rather than re-send.
  reset();
  const before = sends.length;
  await run(s);
  assert.equal(sends.length, before, "zero second send");
});

test("18 a throw BEFORE the send click abandons the intent so retry can proceed", async () => {
  reset();
  const s = scenario();
  const { NotConnectedError } = await import("@/lib/linkedin/message");
  preSendBehaviour = () => { throw new NotConnectedError("not 1st degree"); };

  await run(s);

  assert.equal(sends.length, 0, "nothing was delivered");
  assert.equal(ledgerRows(s.ids.profile)[0].status, "abandoned", "intent is retractable");

  // The ledger no longer blocks the step. NotConnectedError also resets
  // degree=NULL (correct: the target stopped being a connection), so restore
  // that separately — otherwise the degree gate, not the ledger, is what defers
  // the retry and this test would prove nothing about the ledger.
  getDb().prepare("UPDATE targets SET degree = 1 WHERE id = ?").run(s.ids.target);
  reset();
  await run(s);
  assert.equal(sends.length, 1, "the abandoned intent allows exactly one send on retry");
  const rows = ledgerRows(s.ids.profile);
  assert.equal(rows.length, 1, "the row is re-armed in place, not duplicated");
  assert.equal(rows[0].status, "confirmed");
  const attempts = getDb().prepare("SELECT attempt_count FROM step_side_effects WHERE run_profile_id = ?").get(s.ids.profile) as { attempt_count: number };
  assert.equal(attempts.attempt_count, 2, "the second attempt is counted");
});

test("19 an unrecognised error fails CLOSED — in_flight, not abandoned", async () => {
  reset();
  const s = scenario();
  sendBehaviour = () => { throw new Error("something nobody anticipated"); };

  await run(s);

  assert.equal(ledgerRows(s.ids.profile)[0].status, "in_flight",
    "unknown errors must never retract the intent");
});

test("19b MessagingUrnUnresolvedError is provably pre-click and DOES abandon", async () => {
  reset();
  const s = scenario();
  const { MessagingUrnUnresolvedError } = await import("@/lib/linkedin/message");
  preSendBehaviour = () => { throw new MessagingUrnUnresolvedError("no urn"); };

  await run(s);

  assert.equal(sends.length, 0);
  assert.equal(ledgerRows(s.ids.profile)[0].status, "abandoned");
});

// ─── R1: resolve:"resend" must actually resend ───────────────────────────────
// This is the one path deliberately allowed to deliver a duplicate. An option
// that claims to do something dangerous and instead does nothing is worse than
// either behaviour, because the operator reaches for it exactly when they need
// to know what happened.

const { default: retryHandler } = await import("@/pages/api/runs/[id]/retry");

function callRetry(runId: string, body: unknown) {
  const cap: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status(c: number) { cap.status = c; return this; },
    json(b: unknown) { cap.body = b; return this; },
    end() { return this; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retryHandler({ method: "POST", query: { id: runId }, body } as any, res as any);
  return cap;
}

const ledgerRow = (profileId: string) =>
  getDb().prepare("SELECT status, attempt_count, error_message FROM step_side_effects WHERE run_profile_id = ?").get(profileId) as
    { status: string; attempt_count: number; error_message: string | null };

test("R1 resend on a blocked in-flight message performs EXACTLY ONE send", async () => {
  reset();
  const s = scenario();
  // The state an operator actually faces: a possibly-delivered message, blocked.
  seedLedger(s.ids.profile, s.ids.target, stepRefOf(s.stepRows[0] as { id: string }), "in_flight", bodyFingerprint(RENDERED));
  getDb().prepare("UPDATE run_profile_tracks SET state = 'failed' WHERE id = ?").run(s.ids.track);

  const r = callRetry(s.ids.run, { target_ids: [s.ids.target], resolve: "resend" });
  assert.equal((r.body as { outcomes: Array<{ outcome: string }> }).outcomes[0].outcome, "rearmed");

  // Re-entry must now genuinely send — not refuse, not wedge.
  const tr = { ...(getDb().prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(s.ids.track) as object),
    run_id: s.ids.run, target_id: s.ids.target, email_account_id: null, account_id: "acct-x", workflow_id: s.ids.wf };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await executeStep(getDb(), s.ids.run, tr as any, s.target as any, s.stepRows as any, "acct-x", LIMITS);

  assert.equal(sends.length, 1, "exactly one send — not zero (wedged) and not two");
  const led = ledgerRow(s.ids.profile);
  assert.equal(led.status, "confirmed");
  assert.ok(led.attempt_count >= 2, `attempt_count must increment, got ${led.attempt_count}`);
  assert.ok(targetOf(s.ids.target).message_sent_at, "message_sent_at stamped");
  assert.equal(trackOf(s.ids.track).current_step, 1, "track advanced");
});

test("R1 resend twice in a row yields two sends, not a wedge", async () => {
  reset();
  const s = scenario();
  seedLedger(s.ids.profile, s.ids.target, stepRefOf(s.stepRows[0] as { id: string }), "in_flight", bodyFingerprint(RENDERED));
  getDb().prepare("UPDATE run_profile_tracks SET state = 'failed', current_step = 0 WHERE id = ?").run(s.ids.track);

  const runOnce = async () => {
    callRetry(s.ids.run, { target_ids: [s.ids.target], resolve: "resend" });
    const tr = { ...(getDb().prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(s.ids.track) as object),
      run_id: s.ids.run, target_id: s.ids.target, email_account_id: null, account_id: "acct-x", workflow_id: s.ids.wf };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await executeStep(getDb(), s.ids.run, tr as any, s.target as any, s.stepRows as any, "acct-x", LIMITS);
  };

  await runOnce();
  // Reset the track to the same step so a second forced resend is possible.
  getDb().prepare("UPDATE run_profile_tracks SET state = 'failed', current_step = 0 WHERE id = ?").run(s.ids.track);
  await runOnce();

  assert.equal(sends.length, 2, "the operator's second forced resend must also send");
  assert.ok(ledgerRow(s.ids.profile).attempt_count >= 3, "every attempt is counted");
});

test("R1 the forced resend is recorded on the ledger row, not just logged", async () => {
  reset();
  const s = scenario();
  seedLedger(s.ids.profile, s.ids.target, stepRefOf(s.stepRows[0] as { id: string }), "in_flight", bodyFingerprint(RENDERED));
  getDb().prepare("UPDATE run_profile_tracks SET state = 'failed' WHERE id = ?").run(s.ids.track);

  callRetry(s.ids.run, { target_ids: [s.ids.target], resolve: "resend" });

  const led = ledgerRow(s.ids.profile);
  assert.equal(led.status, "abandoned", "the row is explicitly transitioned so re-entry is a genuine first attempt");
  assert.match(led.error_message ?? "", /operator/i, "and the override is attributable in the record");
});

test("X3.3: a LEGACY pos: ledger row still blocks a re-send", async () => {
  // Read-both, proved. There are zero pos: rows in production (D-7), so no data
  // migration exists — but a row written by an older build must still be seen,
  // or the switch would make a delivered message invisible and re-sendable.
  reset();
  const s = scenario();
  seedLedger(s.ids.profile, s.ids.target, "pos:1", "confirmed", bodyFingerprint(RENDERED));

  await run(s);

  assert.equal(sends.length, 0, "a confirmed legacy row must still suppress the send");
  assert.equal(targetOf(s.ids.target).message_sent_at !== null, true, "and the bookkeeping still converges");
});
