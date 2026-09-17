import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-email-idem-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-email-idempotency-tests";

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { namedExports: Record<string, unknown> }) => void;

interface SendRecord { to: string; subject: string; body: string }
const sends: SendRecord[] = [];
/** What the mocked transport does. Default: accept. */
let transport: (rec: SendRecord) => Promise<{ accepted: string[]; rejected: string[]; messageId: string | null }> =
  async rec => ({ accepted: [rec.to], rejected: [], messageId: "<m@fake>" });

const realSender = await import("@/lib/email/sender");
mockModule("@/lib/email/sender", {
  namedExports: {
    ...realSender,
    sendEmail: async (_account: unknown, to: string, subject: string, body: string) => {
      const rec = { to, subject, body };
      const result = await transport(rec); // may throw BEFORE recording (pre-send) — see helpers below
      sends.push(rec);
      return result;
    },
  },
});
const realSession = await import("@/lib/linkedin/session");
mockModule("@/lib/linkedin/session", {
  namedExports: { ...realSession, getSessionPage: async () => ({ close: async () => {} }), saveSessionState: async () => {} },
});

const { executeStep, stepRefOf, bodyFingerprint } = await import("@/lib/linkedin/runner");
const { default: retryHandler } = await import("@/pages/api/runs/[id]/retry");
const { getDb } = await import("@/lib/db");

after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

// ─── helpers to shape transport behaviour ───────────────────────────────────
type SmtpShape = { code?: string; command?: string; responseCode?: number };
const smtpError = (s: SmtpShape) => Object.assign(new Error("synthetic smtp failure"), s);
/** Throws without recording a send: nothing left the process. */
const failBefore = (s: SmtpShape) => { transport = async () => { throw smtpError(s); }; };
/** Records the send, THEN throws: the message may be on the wire. */
const failAfter = (s: SmtpShape) => { transport = async rec => { sends.push(rec); throw smtpError(s); }; };
// Models Nodemailer's real behaviour: `accepted` is built from its normalized
// envelope (trimmed, domain lowercased/punycoded), not an echo of the raw `to`.
const accept = () => { transport = async rec => ({ accepted: [rec.to.trim().toLowerCase()], rejected: [], messageId: "<m@fake>" }); };
const rejectAll = () => { transport = async rec => ({ accepted: [], rejected: [rec.to], messageId: null }); };

// ─── fixtures ───────────────────────────────────────────────────────────────
const LIMITS = { active_hours_start: 0, active_hours_end: 24, timezone: "UTC", working_days: "1,2,3,4,5,6,7", daily_connection_limit: 20, daily_message_limit: 50, daily_inmail_limit: 15 };
const EMAIL_LIMITS = { ...LIMITS, daily_email_limit: 50, ramp_up_enabled: 0, ramp_start_date: null };
const SUBJECT = "Quick question, {{first_name}}";
const BODY = "Hi {{first_name}}, following up on our connection.";
const RENDERED_SUBJECT = "Quick question, Ada";
const RENDERED_BODY = "Hi Ada, following up on our connection.";
let seq = 0;

function scenario(steps: Array<{ subject: string; body: string }> = [{ subject: SUBJECT, body: BODY }], opts: { currentStep?: number; email?: string } = {}) {
  const n = ++seq;
  const ids = { run: `run-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, track: `track-${n}`, target: `target-${n}`, email: `ea-${n}` };
  const db = getDb();
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  steps.forEach((s, i) => db.prepare(
    `INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, email_subject, email_body, email_position, ai_enabled)
     VALUES (?, ?, ?, 'email', 'email', 0, ?, ?, ?, 0)`
  ).run(`step-${n}-${i}`, ids.wf, i + 1, s.subject, s.body, i + 1));
  db.prepare(
    `INSERT INTO email_accounts (id, name, from_email, smtp_host, smtp_port, smtp_secure, username, password, daily_email_limit)
     VALUES (?, 'Fixture', 'sender@fixture.test', '127.0.0.1', 2525, 0, 'u', 'plaintext-not-encrypted', 50)`
  ).run(ids.email);
  db.prepare("INSERT INTO runs (id, workflow_id, status, email_account_id) VALUES (?, ?, 'running', ?)").run(ids.run, ids.wf, ids.email);
  db.prepare("INSERT INTO targets (id, full_name, first_name, linkedin_url, email) VALUES (?, 'Ada Lovelace', 'Ada', ?, ?)")
    .run(ids.target, `https://www.linkedin.com/in/ada-${n}/`, opts.email ?? `ada-${n}@fixture.test`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(ids.profile, ids.run, ids.target, ids.email);
  db.prepare(
    `INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, current_step_id, next_step_at)
     VALUES (?, ?, 'email', 'in_progress', ?, ?, NULL)`
  ).run(ids.track, ids.profile, opts.currentStep ?? 0, `step-${n}-${opts.currentStep ?? 0}`);
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(ids.target);
  const tr = { ...(db.prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(ids.track) as object), run_id: ids.run, target_id: ids.target, email_account_id: ids.email, account_id: `acct-${n}`, workflow_id: ids.wf };
  const stepRows = db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order").all(ids.wf);
  return { ids, tr, target, stepRows };
}

const run = (s: ReturnType<typeof scenario>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeStep(getDb(), s.ids.run, s.tr as any, s.target as any, s.stepRows as any, "acct-x", LIMITS, s.ids.email, EMAIL_LIMITS);
const reload = (s: ReturnType<typeof scenario>) => ({ ...s, tr: { ...s.tr, ...(getDb().prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(s.ids.track) as object) } });
const ledger = (profileId: string) =>
  getDb().prepare("SELECT step_ref, action, status, body_fingerprint, attempt_count, error_message FROM step_side_effects WHERE run_profile_id = ? ORDER BY step_ref").all(profileId) as
    Array<{ step_ref: string; action: string; status: string; body_fingerprint: string | null; attempt_count: number; error_message: string | null }>;
const track = (id: string) =>
  getDb().prepare("SELECT state, current_step, error_message, last_email_subject FROM run_profile_tracks WHERE id = ?").get(id) as
    { state: string; current_step: number; error_message: string | null; last_email_subject: string | null };
const targetMessageSentAt = (targetId: string) =>
  (getDb().prepare("SELECT message_sent_at FROM targets WHERE id = ?").get(targetId) as { message_sent_at: string | null }).message_sent_at;
function callRetry(runId: string, body: unknown) {
  const captured = { status: 200, body: undefined as unknown };
  const res = { status(c: number) { captured.status = c; return this; }, json(p: unknown) { captured.body = p; return this; }, end() { return this; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retryHandler({ method: "POST", query: { id: runId }, body } as any, res as any);
  return captured.body as { outcomes: Array<{ outcome: string; reason?: string }> };
}
function reset() { sends.length = 0; accept(); }

// ─── tests ──────────────────────────────────────────────────────────────────

test("E1 a successful send is recorded as confirmed and the track advances", async () => {
  reset(); const s = scenario();
  await run(s);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], { to: `ada-${s.ids.target.split("-")[1]}@fixture.test`, subject: RENDERED_SUBJECT, body: RENDERED_BODY });
  const [row] = ledger(s.ids.profile);
  assert.equal(row.action, "email");
  assert.equal(row.status, "confirmed");
  assert.equal(row.step_ref, stepRefOf(s.stepRows[0] as { id: string }));
  assert.equal(row.body_fingerprint, bodyFingerprint(`${RENDERED_SUBJECT}\n\n${RENDERED_BODY}`));
  assert.equal(track(s.ids.track).state, "completed");
});

test("E2 a provably pre-send failure abandons the intent; retry re-arms; re-entry sends exactly once", async () => {
  reset(); const s = scenario();
  failBefore({ code: "EAUTH", command: "AUTH", responseCode: 535 });
  await run(s);
  assert.equal(sends.length, 0);
  assert.equal(ledger(s.ids.profile)[0].status, "abandoned");
  assert.equal(track(s.ids.track).state, "failed");
  const { outcomes } = callRetry(s.ids.run, { target_ids: [s.ids.target] });
  assert.equal(outcomes[0].outcome, "rearmed");
  accept();
  await run(reload(s));
  assert.equal(sends.length, 1);
  assert.equal(ledger(s.ids.profile)[0].status, "confirmed");
  assert.equal(ledger(s.ids.profile)[0].attempt_count, 2);
});

test("E3 an explicit server rejection after DATA is abandoned (not held)", async () => {
  reset(); const s = scenario();
  failAfter({ code: "EMESSAGE", command: "DATA", responseCode: 554 });
  await run(s);
  assert.equal(ledger(s.ids.profile)[0].status, "abandoned");
  assert.equal(callRetry(s.ids.run, { target_ids: [s.ids.target] }).outcomes[0].outcome, "rearmed");
});

test("E4 an ambiguous failure stays in_flight, blocks retry, and re-entry refuses to send", async () => {
  reset(); const s = scenario();
  failAfter({ code: "ETIMEDOUT", command: "DATA" });
  await run(s);
  const [row] = ledger(s.ids.profile);
  assert.equal(row.status, "in_flight");
  assert.match(row.error_message ?? "", /may have been delivered/);
  assert.match(track(s.ids.track).error_message ?? "", /may already have been delivered|synthetic smtp failure/);
  const { outcomes } = callRetry(s.ids.run, { target_ids: [s.ids.target] });
  assert.equal(outcomes[0].outcome, "blocked");
  sends.length = 0; accept();
  await run(reload({ ...s, tr: { ...s.tr } }));
  assert.equal(sends.length, 0, "an in_flight email row must refuse re-entry");
  assert.match(track(s.ids.track).error_message ?? "", /may already have been delivered/);
});

test("E5 mark_delivered on an in-flight email advances with zero sends", async () => {
  reset(); const s = scenario();
  failAfter({ code: "ESOCKET", command: "DATA" });
  await run(s);
  sends.length = 0;
  const { outcomes } = callRetry(s.ids.run, { target_ids: [s.ids.target], resolve: "mark_delivered" });
  assert.equal(outcomes[0].outcome, "marked_delivered");
  assert.equal(ledger(s.ids.profile)[0].status, "confirmed");
  assert.match(ledger(s.ids.profile)[0].error_message ?? "", /operator-asserted/);
  assert.equal(sends.length, 0);
  assert.equal(track(s.ids.track).state, "in_progress");
  assert.equal(track(s.ids.track).current_step, 1);
  assert.equal(targetMessageSentAt(s.ids.target), null, "email mark_delivered must not stamp message_sent_at");
});

test("E6 resend on an in-flight email sends exactly once more", async () => {
  reset(); const s = scenario();
  failAfter({ code: "ESOCKET", command: "DATA" });
  await run(s);
  sends.length = 0;
  assert.equal(callRetry(s.ids.run, { target_ids: [s.ids.target], resolve: "resend" }).outcomes[0].outcome, "rearmed");
  accept();
  await run(reload(s));
  assert.equal(sends.length, 1);
  assert.equal(ledger(s.ids.profile)[0].status, "confirmed");
});

test("E7 a confirmed row skips the send and advances (bookkeeping-failure recovery)", async () => {
  reset(); const s = scenario();
  getDb().prepare(
    `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, body_fingerprint, started_at, confirmed_at)
     VALUES ('se-e7', ?, 'email', ?, ?, 'email', 'confirmed', NULL, datetime('now'), datetime('now'))`
  ).run(s.ids.profile, stepRefOf(s.stepRows[0] as { id: string }), s.ids.target);
  await run(s);
  assert.equal(sends.length, 0);
  assert.equal(track(s.ids.track).state, "completed");
  assert.equal(callRetry(s.ids.run, { target_ids: [s.ids.target] }).outcomes.length, 0, "nothing failed, nothing to retry");
});

test("E8 all recipients rejected without a throw is abandoned, never confirmed", async () => {
  reset(); const s = scenario();
  rejectAll();
  await run(s);
  assert.equal(ledger(s.ids.profile)[0].status, "abandoned");
  assert.equal(track(s.ids.track).state, "failed");
});

test("E9 the same subject+body under a renumbered step is refused", async () => {
  reset(); const s = scenario([{ subject: SUBJECT, body: BODY }, { subject: SUBJECT, body: BODY }], { currentStep: 1 });
  getDb().prepare(
    `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, body_fingerprint, started_at, confirmed_at)
     VALUES ('se-e9', ?, 'email', 'stepid:some-old-id', ?, 'email', 'confirmed', ?, datetime('now'), datetime('now'))`
  ).run(s.ids.profile, s.ids.target, bodyFingerprint(`${RENDERED_SUBJECT}\n\n${RENDERED_BODY}`));
  await run(s);
  assert.equal(sends.length, 0);
  assert.match(track(s.ids.track).error_message ?? "", /already sent|Refusing/);
});

test("E10 a bookkeeping failure after acceptance leaves the row confirmed and sends nothing on retry", async () => {
  reset(); const s = scenario();
  const db = getDb();
  db.exec("CREATE TRIGGER e10_fail BEFORE UPDATE OF last_email_subject ON run_profile_tracks BEGIN SELECT RAISE(ABORT, 'injected bookkeeping failure'); END");
  try { await run(s); } finally { db.exec("DROP TRIGGER e10_fail"); }
  assert.equal(sends.length, 1);
  assert.equal(ledger(s.ids.profile)[0].status, "confirmed");
  assert.notEqual(track(s.ids.track).state, "failed", "a delivered email must never look like a send failure");
  // The trigger is gone now, so a retry + re-entry must find the row already
  // confirmed and send nothing more.
  callRetry(s.ids.run, { target_ids: [s.ids.target] });
  await run(reload(s));
  assert.equal(sends.length, 1, "a confirmed row must refuse to send again on retry");
});

test("E11 acceptance is judged by accepted.length, not raw address equality", async () => {
  reset();
  const s = scenario([{ subject: SUBJECT, body: BODY }], { email: "Ada@Example.COM" });
  // accept() normalizes rec.to (trim + lowercase) the way Nodemailer's real
  // envelope does — targets.email stores the raw mixed-case address, so a
  // naive string comparison against sendResult.accepted would wrongly abandon
  // a message the server actually accepted.
  await run(s);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, "Ada@Example.COM");
  const [row] = ledger(s.ids.profile);
  assert.equal(row.status, "confirmed");
  assert.equal(track(s.ids.track).state, "completed");
  assert.equal(callRetry(s.ids.run, { target_ids: [s.ids.target] }).outcomes.length, 0, "nothing failed, nothing to retry");
});
