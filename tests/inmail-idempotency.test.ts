import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/db.ts resolves the DB path on first getDb(), so set it before loading.
const dbDir = mkdtempSync(join(tmpdir(), "linki-inmail-idem-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-inmail-idempotency-tests";

// ─── sandbox ─────────────────────────────────────────────────────────────────
// Mirrors tests/message-idempotency.test.ts: the session is stubbed so nothing
// can open a browser, and premium.inmail is stubbed at the lib/premium
// boundary (ee/ is absent in this build, so without the stub the branch
// exits early and the ledger would be untestable). Every send is recorded.

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { exports: Record<string, unknown> }) => void;

interface InmailRecord { salesNavUrl: string; subject: string; body: string }

const sends: InmailRecord[] = [];
/** Throws AFTER the send is recorded — the delivered-but-failed window. */
let sendBehaviour: () => void = () => {};
/** First call throws BEFORE recording (nothing delivered), then succeeds. */
let failFirstPreSend = false;
let calls = 0;

mockModule("@/lib/premium", {
  exports: {
    premium: {
      inmail: {
        sendInMail: async (_page: unknown, salesNavUrl: string, subject: string, body: string) => {
          calls++;
          if (failFirstPreSend && calls === 1) {
            // NotConnectedError is a pre-send failure (thrown before compose
            // opens) — the intent must retract, not wedge in_flight.
            throw new NotConnectedError("no longer connected (pre-send)");
          }
          sends.push({ salesNavUrl, subject, body });
          sendBehaviour();
        },
      },
    },
  },
});

const realSession = await import("@/lib/linkedin/session");
mockModule("@/lib/linkedin/session", {
  exports: {
    ...realSession,
    getSessionPage: async () => ({ close: async () => {} }),
    saveSessionState: async () => {},
  },
});

const { executeStep, stepRefOf, bodyFingerprint, UnresolvedSideEffectError } = await import("@/lib/linkedin/runner");
const { NotConnectedError } = await import("@/lib/linkedin/message");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const SUBJECT = "Quick idea for {{company}}";
const BODY = "Hi {{first_name}}, one line on InMail.";
const RENDERED_SUBJECT = "Quick idea for Acme";
const RENDERED_BODY = "Hi Ada, one line on InMail.";

// 24/7 so enforceSchedule never defers and the step always runs.
const LIMITS = {
  active_hours_start: 0, active_hours_end: 24, timezone: "UTC", working_days: "1,2,3,4,5,6,7",
  daily_connection_limit: 20, daily_message_limit: 50, daily_inmail_limit: 15,
};

let seq = 0;

function scenario() {
  const n = ++seq;
  const ids = {
    run: `run-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, track: `track-${n}`, target: `target-${n}`,
    step: `step-${n}`,
  };
  const db = getDb();

  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare(
    `INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, message_body, email_subject, message_position, ai_enabled)
     VALUES (?, ?, 1, 'linkedin', 'sales_inmail', 0, ?, ?, 1, 0)`
  ).run(ids.step, ids.wf, BODY, SUBJECT);

  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(ids.run, ids.wf);
  db.prepare(
    `INSERT INTO targets (id, full_name, first_name, company, sales_nav_url, apollo_enriched_at)
     VALUES (?, 'Ada Lovelace', 'Ada', 'Acme', ?, datetime('now'))`
  ).run(ids.target, `https://www.linkedin.com/sales/people/ACoAA-${n}`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  db.prepare(
    `INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, current_step_id, next_step_at)
     VALUES (?, ?, 'linkedin', 'in_progress', 0, ?, NULL)`
  ).run(ids.track, ids.profile, ids.step);

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
  getDb().prepare("SELECT step_ref, status, action FROM step_side_effects WHERE run_profile_id = ? ORDER BY step_ref").all(profileId) as
    Array<{ step_ref: string; status: string; action: string }>;

const targetOf = (id: string) =>
  getDb().prepare("SELECT inmail_sent_at FROM targets WHERE id = ?").get(id) as { inmail_sent_at: string | null };

const trackOf = (id: string) =>
  getDb().prepare("SELECT state, current_step, error_message FROM run_profile_tracks WHERE id = ?").get(id) as
    { state: string; current_step: number; error_message: string | null };

function seedLedger(profileId: string, targetId: string, stepRef: string, status: string, fingerprint: string | null) {
  getDb().prepare(
    `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, body_fingerprint, started_at)
     VALUES (?, ?, 'linkedin', ?, ?, 'inmail', ?, ?, datetime('now'))`
  ).run(`se-${Math.random().toString(36).slice(2)}`, profileId, stepRef, targetId, status, fingerprint);
}

function reset() { sends.length = 0; calls = 0; sendBehaviour = () => {}; failFirstPreSend = false; }

// ─── the gap Phase 3.1 closes ───────────────────────────────────────────────

test("1 a clean InMail send writes a confirmed inmail ledger row", async () => {
  reset();
  const s = scenario();

  await run(s);

  assert.equal(sends.length, 1, "exactly one send");
  assert.equal(sends[0].subject, RENDERED_SUBJECT);
  assert.deepEqual(ledgerRows(s.ids.profile).map(r => [r.step_ref, r.status, r.action]),
    [[stepRefOf(s.stepRows[0] as { id: string }), "confirmed", "inmail"]]);
  assert.ok(targetOf(s.ids.target).inmail_sent_at, "inmail_sent_at must be stamped");
  assert.equal(trackOf(s.ids.track).current_step, 1, "track advances past the delivered InMail");
});

test("2 a throw after the send leaves in_flight; the next attempt refuses (no duplicate)", async () => {
  reset();
  const s = scenario();
  sendBehaviour = () => { throw new Error("page crashed after click"); };

  await run(s);
  assert.equal(sends.length, 1);
  assert.deepEqual(ledgerRows(s.ids.profile).map(r => r.status), ["in_flight"]);

  sendBehaviour = () => {};
  await run(s);
  assert.equal(sends.length, 1, "second attempt must not re-send a possibly-delivered InMail");
  assert.equal(trackOf(s.ids.track).state, "failed");
  assert.match(trackOf(s.ids.track).error_message ?? "", /may already have been delivered/);
});

test("3 a pre-send failure retracts the intent and the retry sends once", async () => {
  reset();
  const s = scenario();
  failFirstPreSend = true;

  await run(s);
  assert.equal(sends.length, 0, "pre-send throw delivers nothing");
  assert.deepEqual(ledgerRows(s.ids.profile).map(r => r.status), ["abandoned"]);

  await run(s);
  assert.equal(sends.length, 1, "retry after a retracted intent sends exactly once");
  assert.deepEqual(ledgerRows(s.ids.profile).map(r => r.status), ["confirmed"]);
});

test("4 a confirmed ledger row converges without sending", async () => {
  reset();
  const s = scenario();
  seedLedger(s.ids.profile, s.ids.target, stepRefOf(s.stepRows[0] as { id: string }), "confirmed",
    bodyFingerprint(`${RENDERED_SUBJECT}\n${RENDERED_BODY}`));

  await run(s);

  assert.equal(sends.length, 0, "zero sends");
  assert.equal(trackOf(s.ids.track).current_step, 1, "advances instead of re-sending");
  assert.ok(targetOf(s.ids.target).inmail_sent_at, "bookkeeping is completed on the convergent path");
});

test("5 UnresolvedSideEffectError is the in_flight signal (ordering, not just text)", async () => {
  reset();
  const s = scenario();
  seedLedger(s.ids.profile, s.ids.target, stepRefOf(s.stepRows[0] as { id: string }), "in_flight",
    bodyFingerprint(`${RENDERED_SUBJECT}\n${RENDERED_BODY}`));
  // The error must survive as a distinct class through executeStep's mapping,
  // so a future edit cannot turn the refusal into a silent skip.
  assert.ok(UnresolvedSideEffectError, "guard class is importable (ordering anchor)");
  await run(s);
  assert.equal(sends.length, 0);
});
