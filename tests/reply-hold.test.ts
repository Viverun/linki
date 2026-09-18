import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-reply-hold-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-reply-hold-tests";

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { namedExports: Record<string, unknown> }) => void;

const sends: string[] = [];
const realSender = await import("@/lib/email/sender");
mockModule("@/lib/email/sender", {
  namedExports: {
    ...realSender,
    sendEmail: async (_a: unknown, to: string) => { sends.push(to); return { accepted: [to], rejected: [], messageId: "<m@fake>" }; },
  },
});
let sessionPageOpens = 0;
const realSession = await import("@/lib/linkedin/session");
mockModule("@/lib/linkedin/session", {
  namedExports: { ...realSession, getSessionPage: async () => { sessionPageOpens++; return { close: async () => {} }; }, saveSessionState: async () => {} },
});

const { executeStep } = await import("@/lib/linkedin/runner");
const { getDb } = await import("@/lib/db");
const lease = await import("@/lib/linkedin/lease");
lease.acquireRunnerLease(getDb()); // R1: verbs now require the lease
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

const LIMITS = { active_hours_start: 0, active_hours_end: 24, timezone: "UTC", working_days: "1,2,3,4,5,6,7", daily_connection_limit: 20, daily_message_limit: 50, daily_inmail_limit: 15 };
const EMAIL_LIMITS = { ...LIMITS, daily_email_limit: 50, ramp_up_enabled: 0, ramp_start_date: null };
let seq = 0;

/** One run with an email track (one email step) for a target with an email address. */
function scenario() {
  const n = ++seq; const db = getDb();
  const ids = { run: `run-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, track: `track-${n}`, target: `target-${n}`, email: `ea-${n}`, step: `step-${n}` };
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, email_subject, email_body, email_position, ai_enabled) VALUES (?, ?, 1, 'email', 'email', 0, 'Hi', 'Body', 1, 0)").run(ids.step, ids.wf);
  db.prepare("INSERT INTO email_accounts (id, name, from_email, smtp_host, smtp_port, smtp_secure, username, password, daily_email_limit) VALUES (?, 'F', 'sender@fixture.test', '127.0.0.1', 2525, 0, 'u', 'p', 50)").run(ids.email);
  db.prepare("INSERT INTO runs (id, workflow_id, status, email_account_id) VALUES (?, ?, 'running', ?)").run(ids.run, ids.wf, ids.email);
  db.prepare("INSERT INTO targets (id, full_name, first_name, linkedin_url, email) VALUES (?, 'Ada', 'Ada', ?, ?)").run(ids.target, `https://www.linkedin.com/in/ada-${n}/`, `ada-${n}@fixture.test`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(ids.profile, ids.run, ids.target, ids.email);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, current_step_id) VALUES (?, ?, 'email', 'in_progress', 0, ?)").run(ids.track, ids.profile, ids.step);
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(ids.target);
  const tr = { ...(db.prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(ids.track) as object), run_id: ids.run, target_id: ids.target, email_account_id: ids.email, account_id: `acct-${n}`, workflow_id: ids.wf };
  const stepRows = db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order").all(ids.wf);
  return { ids, tr, target, stepRows };
}
const run = (s: ReturnType<typeof scenario>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeStep(getDb(), s.ids.run, s.tr as any, s.target as any, s.stepRows as any, "acct-x", LIMITS, s.ids.email, EMAIL_LIMITS);
const track = (id: string) => getDb().prepare("SELECT state, next_step_at, error_message FROM run_profile_tracks WHERE id = ?").get(id) as { state: string; next_step_at: string | null; error_message: string | null };
function addReply(targetId: string, runId: string, opts: { dispatched?: boolean } = {}) {
  const id = `reply-${Math.random().toString(36).slice(2)}`;
  getDb().prepare("INSERT INTO email_replies (id, target_id, run_id, from_email, subject, body_text, received_at, dispatched_at) VALUES (?, ?, ?, 'x@y.test', 'Re', 'body', datetime('now'), ?)")
    .run(id, targetId, runId, opts.dispatched ? new Date().toISOString() : null);
  return id;
}
const lastLog = (runId: string) => (getDb().prepare("SELECT message FROM logs WHERE run_id = ? ORDER BY rowid DESC LIMIT 1").get(runId) as { message: string } | undefined)?.message ?? "";

const CONNECT_STEP = {
  id: "step-connect", step_order: 1, track: "linkedin", step_type: "connect", template_id: null,
  delay_seconds: 0, connect_note: null, message_body: null, email_subject: null, email_body: null,
  ai_enabled: 0, ai_model: null, ai_prompt: null, ai_max_words: null, ai_language: null,
  email_position: 1, message_position: 1, email_signature: null,
};

/** One run with a LinkedIn 'connect' track (no email account involved) for a target. */
function linkedinScenario() {
  const n = ++seq; const db = getDb();
  const ids = { run: `lrun-${n}`, profile: `lprofile-${n}`, track: `ltrack-${n}`, target: `ltarget-${n}` };
  db.prepare("INSERT INTO runs (id, status) VALUES (?, 'running')").run(ids.run);
  db.prepare("INSERT INTO targets (id, full_name, first_name, linkedin_url) VALUES (?, 'Ada', 'Ada', ?)").run(ids.target, `https://www.linkedin.com/in/ada-l-${n}/`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, next_step_at) VALUES (?, ?, 'linkedin', 'in_progress', 0, NULL)").run(ids.track, ids.profile);
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(ids.target);
  const tr = { ...(db.prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(ids.track) as object), run_id: ids.run, target_id: ids.target, email_account_id: null, account_id: `lacct-${n}`, workflow_id: `lwf-${n}` };
  return { ids, tr, target };
}
const runLinkedin = (s: ReturnType<typeof linkedinScenario>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeStep(getDb(), s.ids.run, s.tr as any, s.target as any, [CONNECT_STEP] as any, "lacct-x", LIMITS);
const linkedinTrack = (id: string) => getDb().prepare("SELECT state, next_step_at, error_message FROM run_profile_tracks WHERE id = ?").get(id) as { state: string; next_step_at: string | null; error_message: string | null };

test("H1 an undecided reply holds the step: no send, track waits ~1h, log says holding", async () => {
  sends.length = 0; const s = scenario();
  addReply(s.ids.target, s.ids.run);
  await run(s);
  assert.equal(sends.length, 0);
  const t = track(s.ids.track);
  assert.equal(t.state, "in_progress");
  assert.ok(t.next_step_at && new Date(t.next_step_at).getTime() - Date.now() > 50 * 60_000, "rescheduled about an hour out");
  assert.match(lastLog(s.ids.run), /awaiting decision — holding/);
});

test("H2 a decided reply (dispatched_at set, no stamp) lets the step proceed", async () => {
  sends.length = 0; const s = scenario();
  addReply(s.ids.target, s.ids.run, { dispatched: true });
  await run(s);
  assert.equal(sends.length, 1);
});

test("H3 email_replied_at still skips all tracks with 'Lead replied' (unchanged)", async () => {
  sends.length = 0; const s = scenario();
  getDb().prepare("UPDATE targets SET email_replied_at = datetime('now') WHERE id = ?").run(s.ids.target);
  await run(s);
  assert.equal(sends.length, 0);
  assert.equal(track(s.ids.track).state, "skipped");
  assert.equal(track(s.ids.track).error_message, "Lead replied");
});

test("H4 open_core_attempts column exists with default 0", () => {
  const cols = (getDb().prepare("PRAGMA table_info(email_replies)").all() as Array<{ name: string; dflt_value: string | null }>);
  const col = cols.find(c => c.name === "open_core_attempts");
  assert.ok(col, "column missing");
  assert.equal(col!.dflt_value, "0");
});

test("H5 an undecided reply also holds a LinkedIn track: no session page opened, connect step never runs", async () => {
  sessionPageOpens = 0;
  const s = linkedinScenario();
  addReply(s.ids.target, s.ids.run);
  await runLinkedin(s);
  assert.equal(sessionPageOpens, 0, "hold must return before the connect step touches a LinkedIn session");
  const t = linkedinTrack(s.ids.track);
  assert.equal(t.state, "in_progress");
  assert.ok(t.next_step_at && new Date(t.next_step_at).getTime() - Date.now() > 50 * 60_000, "rescheduled about an hour out");
  assert.match(lastLog(s.ids.run), /awaiting decision — holding linkedin track/);
});

test("H6 last_replied_at (LinkedIn reply) skips the track with 'Lead replied', same as an email reply", async () => {
  sends.length = 0; const s = scenario();
  getDb().prepare("UPDATE targets SET last_replied_at = datetime('now') WHERE id = ?").run(s.ids.target);
  await run(s);
  assert.equal(sends.length, 0);
  assert.equal(track(s.ids.track).state, "skipped");
  assert.equal(track(s.ids.track).error_message, "Lead replied");
});
