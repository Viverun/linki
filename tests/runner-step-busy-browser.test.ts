import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/db.ts resolves the DB path on first getDb(), so set it before loading.
const dbDir = mkdtempSync(join(tmpdir(), "linki-busy-browser-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-busy-browser-tests";

// ─── sandbox ─────────────────────────────────────────────────────────────────
// visitProfile is replaced with a no-op so no browser is ever reached. Session
// is mocked EXCEPT getSessionPage, which stays the real implementation — this
// suite exists to prove getSessionPage itself routes through the per-account
// browser owner (lib/linkedin/ownership.ts), so it must not be stubbed out
// like the other runner suites do.

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { namedExports: Record<string, unknown> }) => void;

const realVisit = await import("@/lib/linkedin/visit");
mockModule("@/lib/linkedin/visit", {
  namedExports: {
    ...realVisit,
    visitProfile: async () => ({ degree: "inconclusive", isFirstDegree: false, messagingUrn: null }),
  },
});

const realSession = await import("@/lib/linkedin/session");
mockModule("@/lib/linkedin/session", {
  namedExports: {
    ...realSession,
    saveSessionState: async () => {},
  },
});

const own = await import("@/lib/linkedin/ownership");
let pagesOpened = 0;
own.setBrowserContextProvider(async () => ({
  pages: () => [],
  newPage: async () => { pagesOpened++; return { close: async () => {}, isClosed: () => false }; },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any);

const lease = await import("@/lib/linkedin/lease");
const { executeStep } = await import("@/lib/linkedin/runner");
const { getDb } = await import("@/lib/db");
lease.acquireRunnerLease(getDb()); // R1: verbs now require the lease

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const LIMITS = {
  active_hours_start: 0, active_hours_end: 24, timezone: "UTC", working_days: "1,2,3,4,5,6,7",
  daily_connection_limit: 20, daily_message_limit: 50, daily_inmail_limit: 15,
};

const VISIT_STEP = {
  id: "step-visit", step_order: 1, track: "linkedin", step_type: "visit", template_id: null,
  delay_seconds: 0, connect_note: null, message_body: null, email_subject: null, email_body: null,
  ai_enabled: 0, ai_model: null, ai_prompt: null, ai_max_words: null, ai_language: null,
  email_position: 1, message_position: 1, email_signature: null,
};

let seq = 0;

/** A run/profile/track chain with a single linkedin 'visit' step, owned by account "acct-x". */
function scenario() {
  const n = ++seq;
  const ids = { run: `run-${n}`, profile: `profile-${n}`, track: `track-${n}`, target: `target-${n}` };
  const db = getDb();

  db.prepare("INSERT INTO runs (id, status) VALUES (?, 'running')").run(ids.run);
  db.prepare(
    "INSERT INTO targets (id, full_name, linkedin_url, degree) VALUES (?, 'Ada Lovelace', ?, NULL)"
  ).run(ids.target, `https://www.linkedin.com/in/ada-${n}/`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  db.prepare(
    `INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, next_step_at)
     VALUES (?, ?, 'linkedin', 'in_progress', 0, NULL)`
  ).run(ids.track, ids.profile);

  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(ids.target);
  const tr = {
    ...(db.prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(ids.track) as object),
    run_id: ids.run, target_id: ids.target, email_account_id: null,
    account_id: "acct-x", workflow_id: `wf-${n}`,
  };

  return { ids, tr, target };
}

const run = (s: ReturnType<typeof scenario>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeStep(getDb(), s.ids.run, s.tr as any, s.target as any, [VISIT_STEP] as any, "acct-x", LIMITS);

const track = (id: string) =>
  getDb().prepare("SELECT state, next_step_at FROM run_profile_tracks WHERE id = ?").get(id) as
    { state: string; next_step_at: string | null };

const lastLog = (runId: string) =>
  (getDb().prepare("SELECT message FROM logs WHERE run_id = ? ORDER BY rowid DESC LIMIT 1").get(runId) as { message: string } | undefined)?.message ?? "";

// ─── B1–B2: a step routes through the browser owner ─────────────────────────

test("B1 a step for an account whose browser is owned by an import is rescheduled ~5 min out and opens no page", async () => {
  const s = scenario();
  const hold = own.withBrowserOwner("acct-x", "import", { maxHoldMs: 10_000 }, async () => {
    await new Promise(r => setTimeout(r, 80));
  });
  await new Promise(r => setTimeout(r, 5));
  pagesOpened = 0;

  await run(s);

  const t = track(s.ids.track);
  assert.equal(t.state, "in_progress");
  assert.ok(t.next_step_at && new Date(t.next_step_at).getTime() - Date.now() > 4 * 60_000);
  assert.equal(pagesOpened, 0);
  assert.match(lastLog(s.ids.run), /browser owned by import — rescheduling/);

  await hold;
});

test("B2 with the browser free the step opens its page and proceeds", async () => {
  const s = scenario();
  pagesOpened = 0;

  await run(s);

  assert.equal(pagesOpened, 1);
});
