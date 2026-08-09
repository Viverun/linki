import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/db.ts resolves the DB path on first getDb(), so set it before loading.
const dbDir = mkdtempSync(join(tmpdir(), "linki-visit-degree-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-visit-degree-tests";

// ─── sandbox ─────────────────────────────────────────────────────────────────
// visitProfile and the session are replaced before the runner is loaded, so no
// browser can open and no LinkedIn page can be reached. Each test dictates the
// observation the visit step will see.

// @types/node is pinned at v20, which still types mock.module's old
// `namedExports` option. Node 24 deprecates that in favour of `exports`.
// Bound, not detached — mock.module reads private state off `mock`.
const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { exports: Record<string, unknown> }) => void;

type Observation = "first_degree" | "not_first_degree" | "inconclusive";
interface VisitResult { degree: Observation; isFirstDegree: boolean; messagingUrn: string | null }

const realVisit = await import("@/lib/linkedin/visit");

/** What visitProfile returns on the next call, or a throw to simulate a failure. */
let nextVisit: VisitResult | (() => never) = { degree: "inconclusive", isFirstDegree: false, messagingUrn: null };
let visitCalls = 0;

const observe = (degree: Observation, messagingUrn: string | null = null): VisitResult => ({
  degree,
  isFirstDegree: degree === "first_degree",
  messagingUrn,
});

mockModule("@/lib/linkedin/visit", {
  exports: {
    ...realVisit,
    visitProfile: async () => {
      visitCalls++;
      if (typeof nextVisit === "function") nextVisit();
      return nextVisit;
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

const { executeStep } = await import("@/lib/linkedin/runner");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened, or already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const VISIT_STEP = {
  id: "step-visit",
  step_order: 1,
  track: "linkedin",
  step_type: "visit",
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

// 24/7 window so nothing reschedules and the step always runs.
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
function scenario(opts: { degree?: number | null; connectedAt?: string | null; messagingUrn?: string | null } = {}) {
  const n = ++seq;
  const runId = `run-${n}`;
  const profileId = `profile-${n}`;
  const trackId = `track-${n}`;
  const targetId = `target-${n}`;
  const db = getDb();

  db.prepare("INSERT INTO runs (id, status) VALUES (?, 'running')").run(runId);
  db.prepare(
    "INSERT INTO targets (id, linkedin_url, full_name, degree, connected_at, messaging_urn) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    targetId,
    `https://www.linkedin.com/in/test-${n}/`,
    `Test Person ${n}`,
    opts.degree ?? null,
    opts.connectedAt ?? null,
    opts.messagingUrn ?? null,
  );
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
  };

  return { runId, trackId, targetId, tr, target };
}

const run = (s: ReturnType<typeof scenario>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeStep(getDb(), s.runId, s.tr as any, s.target as any, [VISIT_STEP] as any, "account-x", LIMITS);

const targetOf = (id: string) =>
  getDb().prepare("SELECT degree, connected_at, messaging_urn FROM targets WHERE id = ?").get(id) as
    { degree: number | null; connected_at: string | null; messaging_urn: string | null };

const CONNECTED_AT = "2026-01-01T00:00:00.000Z";
const URN = "urn:li:fsd_profile:ACoAAStored";

// ─── H1–H2: first_degree backfill ────────────────────────────────────────────

test("H1 degree=NULL + first_degree → backfills degree=1 and connected_at", async () => {
  const s = scenario({ degree: null });
  nextVisit = observe("first_degree");

  await run(s);

  const t = targetOf(s.targetId);
  assert.equal(t.degree, 1);
  assert.ok(t.connected_at, "connected_at must be stamped");
});

test("H2 degree=1 + first_degree → no rewrite, connected_at preserved", async () => {
  const s = scenario({ degree: 1, connectedAt: CONNECTED_AT });
  nextVisit = observe("first_degree");

  await run(s);

  assert.deepEqual(targetOf(s.targetId), { degree: 1, connected_at: CONNECTED_AT, messaging_urn: null });
});

// ─── H3–H4: not_first_degree clearing ────────────────────────────────────────

test("H3 degree=1 + not_first_degree → clears degree AND connected_at", async () => {
  const s = scenario({ degree: 1, connectedAt: CONNECTED_AT });
  nextVisit = observe("not_first_degree");

  await run(s);

  const t = targetOf(s.targetId);
  assert.equal(t.degree, null, "a disproven connection must be cleared");
  assert.equal(t.connected_at, null);
});

test("H4 degree=NULL + not_first_degree → nothing written", async () => {
  const s = scenario({ degree: null });
  nextVisit = observe("not_first_degree");

  await run(s);

  assert.deepEqual(targetOf(s.targetId), { degree: null, connected_at: null, messaging_urn: null });
});

// ─── H5–H6 / I: inconclusive must never clear ────────────────────────────────

test("I (THE DANGEROUS CASE) degree=1 + inconclusive → connection MUST survive", async () => {
  // A missing top card means the card was never inspected — page still
  // rendering, layout drift, a 404, or an auth wall. Clearing here would erase
  // a correct connection and silently re-fire a connect step at a real contact.
  const s = scenario({ degree: 1, connectedAt: CONNECTED_AT, messagingUrn: URN });
  nextVisit = observe("inconclusive");

  await run(s);

  assert.deepEqual(targetOf(s.targetId), { degree: 1, connected_at: CONNECTED_AT, messaging_urn: URN },
    "an inconclusive visit must leave the row completely untouched");
});

test("H6 degree=NULL + inconclusive → remains NULL", async () => {
  const s = scenario({ degree: null });
  nextVisit = observe("inconclusive");

  await run(s);

  assert.deepEqual(targetOf(s.targetId), { degree: null, connected_at: null, messaging_urn: null });
});

test("I2 an inconclusive visit carrying a URN still writes no degree", async () => {
  // Defence in depth: even if a URN somehow accompanied an inconclusive result,
  // it is an address, never evidence of a connection.
  const s = scenario({ degree: null });
  nextVisit = { degree: "inconclusive", isFirstDegree: false, messagingUrn: URN };

  await run(s);

  assert.equal(targetOf(s.targetId).degree, null);
});

// ─── H7: non-1 degrees are not rewritten ─────────────────────────────────────

test("H7 degree=2 + not_first_degree → left as 2, not nulled", async () => {
  const s = scenario({ degree: 2 });
  nextVisit = observe("not_first_degree");

  await run(s);

  assert.equal(targetOf(s.targetId).degree, 2, "only a stale degree=1 is the visit step's business");
});

test("H7b degree=3 + inconclusive → left as 3", async () => {
  const s = scenario({ degree: 3 });
  nextVisit = observe("inconclusive");

  await run(s);

  assert.equal(targetOf(s.targetId).degree, 3);
});

// ─── H8: messaging_urn is never cleared ──────────────────────────────────────

test("H8 messaging_urn survives a stale-degree clear", async () => {
  const s = scenario({ degree: 1, connectedAt: CONNECTED_AT, messagingUrn: URN });
  nextVisit = observe("not_first_degree");

  await run(s);

  const t = targetOf(s.targetId);
  assert.equal(t.degree, null, "degree cleared");
  assert.equal(t.messaging_urn, URN, "the URN is an address — message.ts re-verifies before using it");
});

test("H8b a first_degree visit still caches a newly seen URN", async () => {
  const s = scenario({ degree: null });
  nextVisit = observe("first_degree", URN);

  await run(s);

  assert.equal(targetOf(s.targetId).messaging_urn, URN);
});

// ─── exceptions preserve existing behaviour ──────────────────────────────────

test("a thrown visit fails the track and writes no degree at all", async () => {
  const s = scenario({ degree: 1, connectedAt: CONNECTED_AT });
  nextVisit = () => { throw new Error("Timeout 30000ms exceeded"); };

  await run(s);

  assert.deepEqual(targetOf(s.targetId), { degree: 1, connected_at: CONNECTED_AT, messaging_urn: null },
    "a navigation/DOM failure must never touch connection state");
  const tr = getDb().prepare("SELECT state FROM run_profile_tracks WHERE id = ?").get(s.trackId) as { state: string };
  assert.equal(tr.state, "failed");

  nextVisit = observe("inconclusive"); // reset for any later test
});

test("the visit step actually ran the visit in every case above", () => {
  assert.ok(visitCalls >= 10, `expected the mocked visitProfile to be exercised, got ${visitCalls}`);
});
