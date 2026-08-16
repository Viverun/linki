import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

// lib/db.ts resolves the DB path on first getDb(), so set it before loading.
const dbDir = mkdtempSync(join(tmpdir(), "linki-step-identity-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-step-identity-tests";

// ─── sandbox ─────────────────────────────────────────────────────────────────
// Same shape as tests/message-idempotency.test.ts: message.ts and the session
// are replaced before the runner loads, so nothing can open a browser. Every
// send is recorded, which is what makes "the wrong step executed" an OBSERVATION
// rather than an absence of evidence — the whole point of P2-3.

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { exports: Record<string, unknown> }) => void;

const sends: { text: string }[] = [];
const realMessage = await import("@/lib/linkedin/message");
mockModule("@/lib/linkedin/message", {
  exports: {
    ...realMessage,
    sendMessage: async (_p: unknown, _n: string, text: string) => {
      sends.push({ text });
      return { messagingUrn: "urn:li:fsd_profile:ACoAATEST", isFirstDegree: true };
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

const routeUrl = (rel: string) => pathToFileURL(join(process.cwd(), rel)).href;
const { executeStep, stepRefOf } = await import("@/lib/linkedin/runner");
const { stripComments } = await import("@/tests/support/source-text");
const { default: retryHandler } = await import(routeUrl("pages/api/runs/[id]/retry.ts"));
const { getDb } = await import("@/lib/db");
// Imported by URL, not by specifier. `@/pages/api/workflows/[id]/steps` resolves
// to the steps/ DIRECTORY (ERR_UNSUPPORTED_DIR_IMPORT) because a route file and a
// route directory share the name, and a literal ".ts" specifier is rejected by
// tsc without allowImportingTsExtensions. A non-literal dynamic import sidesteps
// both: node resolves the real path, tsc does not try to.
const { default: stepsHandler } = await import(routeUrl("pages/api/workflows/[id]/steps.ts"));
const { default: stepByIdHandler } = await import(routeUrl("pages/api/workflows/[id]/steps/[stepId].ts"));

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

const LIMITS = {
  active_hours_start: 0, active_hours_end: 24, timezone: "UTC", working_days: "1,2,3,4,5,6,7",
  daily_connection_limit: 20, daily_message_limit: 50, daily_inmail_limit: 15,
};

let seq = 0;

interface StepSpec { type: "connect" | "message"; body?: string }

/**
 * A workflow whose linkedin track is `steps`, plus one enrolled target sitting
 * at `currentStep`. `connected` marks the target as already 1st-degree with an
 * invitation on record, which is the state every one of these scenarios is
 * about: the connect step is DONE, so anything that re-resolves to a message
 * sends it to a real person.
 */
function scenario(steps: StepSpec[], opts: { currentStep?: number; connected?: boolean; pinTo?: string | null } = {}) {
  const n = ++seq;
  const ids = { run: `run-${n}`, wf: `wf-${n}`, profile: `pr-${n}`, track: `tk-${n}`, target: `tg-${n}` };
  const db = getDb();

  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  const stepIds: string[] = [];
  steps.forEach((s, i) => {
    const sid = `st-${n}-${i}`;
    stepIds.push(sid);
    db.prepare(
      `INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, message_body, message_position, ai_enabled)
       VALUES (?, ?, ?, 'linkedin', ?, 0, ?, ?, 0)`
    ).run(sid, ids.wf, i + 1, s.type, s.body ?? null, i + 1);
  });

  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(ids.run, ids.wf);
  db.prepare(
    `INSERT INTO targets (id, full_name, first_name, linkedin_url, degree, connection_requested_at, connected_at)
     VALUES (?, 'Ada Lovelace', 'Ada', ?, ?, ?, ?)`
  ).run(
    ids.target, `https://www.linkedin.com/in/ada-${n}/`,
    opts.connected ? 1 : null,
    opts.connected ? new Date().toISOString() : null,
    opts.connected ? new Date().toISOString() : null,
  );
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  // Enrolment pins the step id (pages/api/runs/index.ts), so a realistic track
  // carries one. Passing currentStepId: null models a legacy row the backfill
  // could not resolve.
  const idx = opts.currentStep ?? 0;
  db.prepare(
    `INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, current_step_id, next_step_at)
     VALUES (?, ?, 'linkedin', 'in_progress', ?, ?, NULL)`
  ).run(ids.track, ids.profile, idx, opts.pinTo === null ? null : (opts.pinTo ?? stepIds[idx] ?? null));

  return { ids, stepIds };
}

/** Re-read the track/steps and drive one step, exactly as the runner does. */
function runStep(s: ReturnType<typeof scenario>) {
  const db = getDb();
  const tr = {
    ...(db.prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(s.ids.track) as object),
    run_id: s.ids.run, target_id: s.ids.target, email_account_id: null,
    account_id: `acct-${s.ids.run}`, workflow_id: s.ids.wf,
  };
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(s.ids.target);
  const stepRows = db.prepare(
    "SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order"
  ).all(s.ids.wf);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return executeStep(db, s.ids.run, tr as any, target as any, stepRows as any, "acct-x", LIMITS);
}

const trackOf = (id: string) =>
  getDb().prepare("SELECT state, current_step FROM run_profile_tracks WHERE id = ?").get(id) as
    { state: string; current_step: number };

const logsFor = (runId: string) =>
  getDb().prepare("SELECT level, message FROM logs WHERE run_id = ?").all(runId) as
    { level: string; message: string }[];

// ─── API harness, driving the real route handlers ────────────────────────────

interface Captured { status: number; body: unknown }
function callApi(
  handler: (rq: unknown, rs: unknown) => unknown,
  method: string, query: Record<string, string>, body?: unknown
): Captured {
  const cap: Captured = { status: 200, body: undefined };
  const res = {
    status(c: number) { cap.status = c; return this; },
    json(p: unknown) { cap.body = p; return this; },
    end() { return this; },
  };
  handler({ method, query, body } as unknown, res as unknown);
  return cap;
}

const stepIdsOf = (wf: string) =>
  (getDb().prepare("SELECT id FROM workflow_steps WHERE workflow_id = ? ORDER BY track, step_order").all(wf) as { id: string }[])
    .map(r => r.id);

// ═══ NF-1 — step ids must survive a save ═════════════════════════════════════

// KNOWN-FAILING, deliberately. This is the X3.1 reproduction and it must stay red
// until `PUT /api/workflows/[id]/steps` lands in the very next commit, which flips
// `todo` off. It is marked todo rather than deleted or weakened: the assertion is
// untouched, node still EXECUTES it, and the run reports it — so the defect stays
// visible instead of being quietly parked. Removing the todo is a one-line diff in
// the commit that fixes it.
test("NF-1: saving a workflow preserves every step id", () => {
  // The UI's save is delete-all-then-re-POST (pages/workflows/[id].tsx:774-812),
  // and POST mints a fresh randomUUID per step. So identity is destroyed on every
  // save — which is what forces every downstream reference to be positional.
  const s = scenario([{ type: "connect" }, { type: "message", body: "hi" }]);
  const before = stepIdsOf(s.ids.wf);
  assert.equal(before.length, 2, "anchor: the fixture really has two steps");

  // The fixture's run is 'running', which the new route refuses (409) — proved
  // separately below. Pause it, which D-4 permits.
  getDb().prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(s.ids.run);

  // The save the client now performs: one PUT with the full ordered list, each
  // surviving step carrying its id back.
  const r = callApi(stepsHandler as never, "PUT", { id: s.ids.wf }, [
    { id: before[0], step_type: "connect", track: "linkedin" },
    { id: before[1], step_type: "message", track: "linkedin", message_body: "hi" },
  ]);
  assert.equal(r.status, 200, "anchor: the save succeeded");

  const after2 = stepIdsOf(s.ids.wf);
  assert.equal(after2.length, 2, "anchor: still two steps after the save");
  assert.deepEqual(
    after2, before,
    "step ids must be STABLE across a save — a workflow's steps are the same steps, " +
    "renamed. Every id changing is what makes stable step identity impossible."
  );
});

// ═══ N3 — resolution by position ═════════════════════════════════════════════

test("N3a repro: deleting the completed step silently COMPLETES the track", async () => {
  // A track that finished connect sits at current_step = 1. Delete the connect
  // step and the list shortens to 1, so index 1 is now out of range and
  // executeStep marks the track completed — no error, no log, and the message
  // step that WAS index 1 never runs. The operator sees a finished campaign.
  const s = scenario([{ type: "connect" }, { type: "message", body: "hi" }], { currentStep: 1, connected: true });
  getDb().prepare("DELETE FROM workflow_steps WHERE id = ?").run(s.stepIds[0]);

  sends.length = 0;
  await runStep(s);

  // The defect was never "it completed" — it is that it completed WITHOUT RUNNING.
  // Completing after the last remaining step legitimately runs is correct; doing
  // so because the index fell out of range is the silent skip.
  assert.equal(
    sends.length, 1,
    "the step this track was pinned to still exists and must RUN. Before P2-3 the " +
    "shortened list put index 1 out of range and the track was marked completed " +
    "with nothing sent — a campaign that looks finished and did nothing."
  );
  assert.equal(trackOf(s.ids.track).state, "completed", "and only then is it done");
});

test("D-8: when the PINNED step itself is deleted, the track says so and runs nothing", async () => {
  // The other half of N3a. Here the step the track is on is the one removed, so
  // its position is unknowable. Appendix A D-8: log explicitly and advance —
  // never execute whatever now occupies that index.
  const s = scenario([{ type: "connect" }, { type: "message", body: "Hi Ada" }], { currentStep: 1, connected: true });
  getDb().prepare("DELETE FROM workflow_steps WHERE id = ?").run(s.stepIds[1]);   // the pinned one

  sends.length = 0;
  await runStep(s);

  const logs = logsFor(s.ids.run);
  assert.ok(logs.length > 0, "anchor: something was logged for this run");
  assert.equal(sends.length, 0, "nothing may be executed in place of a deleted step");
  assert.ok(
    logs.some(l => /no longer exists/i.test(l.message)),
    "the disappearance must be stated, not swallowed into a silent completion"
  );
});

test("N3b repro: reordering makes an already-connected track send a message immediately", async () => {
  // The dangerous direction. The track has completed connect and sits at
  // current_step = 0 pointing at what WAS the connect step. Re-saving the
  // campaign with the message first renumbers the steps, so index 0 is now the
  // message — and the very next tick sends it to a real person, with no delay
  // and no step of its own having been reached.
  const s = scenario([{ type: "connect" }, { type: "message", body: "Hi Ada" }], { currentStep: 0, connected: true });
  // Reorder in place: message becomes step_order 1, connect becomes 2.
  getDb().prepare("UPDATE workflow_steps SET step_order = 2 WHERE id = ?").run(s.stepIds[0]);
  getDb().prepare("UPDATE workflow_steps SET step_order = 1 WHERE id = ?").run(s.stepIds[1]);

  sends.length = 0;
  await runStep(s);

  assert.equal(
    sends.length, 0,
    "a track pinned to the CONNECT step must not send a message because the list " +
    "was reordered underneath it — position is not identity"
  );
});

// ═══ current_step writer census — one test per writer ════════════════════════
//
// The highest-risk part of P2-3. Every writer that moves a track must move the
// PINNED ID with the index, or the drift this column removes comes straight
// back. A writer found and not covered here is the failure mode.

test("census: trAdvance moves the pinned id to the next step", async () => {
  const s = scenario([{ type: "connect" }, { type: "message", body: "Hi" }], { currentStep: 0, connected: true });
  await runStep(s);                        // connect step: already requested -> advances
  const tr = getDb().prepare("SELECT current_step, current_step_id FROM run_profile_tracks WHERE id = ?").get(s.ids.track) as
    { current_step: number; current_step_id: string | null };
  assert.equal(tr.current_step, 1, "anchor: the index advanced");
  assert.equal(tr.current_step_id, s.stepIds[1], "and the id advanced with it");
});

test("census: trAdvance nulls the pinned id when the track completes", async () => {
  const s = scenario([{ type: "connect" }], { currentStep: 0, connected: true });
  await runStep(s);
  const tr = getDb().prepare("SELECT state, current_step_id FROM run_profile_tracks WHERE id = ?").get(s.ids.track) as
    { state: string; current_step_id: string | null };
  assert.equal(tr.state, "completed", "anchor: it did complete");
  assert.equal(tr.current_step_id, null, "a completed track points at no step");
});

test("census: retry mark_delivered advances the id, not just the index", () => {
  const s = scenario([{ type: "message", body: "Hi" }, { type: "message", body: "Second" }], { currentStep: 0, connected: true });
  const db = getDb();
  db.prepare("UPDATE run_profile_tracks SET state = 'failed' WHERE id = ?").run(s.ids.track);
  db.prepare(
    `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, started_at)
     VALUES (?, ?, 'linkedin', ?, ?, 'message', 'in_flight', datetime('now'))`
  ).run(`se-md-${s.ids.track}`, s.ids.profile, stepRefOf({ id: s.stepIds[0], message_position: 1 } as never), s.ids.target);

  const r = callApi(retryHandler as never, "POST", { id: s.ids.run }, { target_ids: [s.ids.target], resolve: "mark_delivered" });
  assert.equal(r.status, 200, "anchor: the retry call succeeded");
  const tr = db.prepare("SELECT current_step, current_step_id FROM run_profile_tracks WHERE id = ?").get(s.ids.track) as
    { current_step: number; current_step_id: string | null };
  assert.equal(tr.current_step, 1, "anchor: it advanced past the delivered step");
  assert.equal(tr.current_step_id, s.stepIds[1], "and the pinned id came with it");
});

test("census: retry rearm leaves the pinned id alone", () => {
  // rearm re-runs the SAME step, so the id must NOT move. Asserted because the
  // obvious "keep them in sync" fix is to update the id everywhere the index is
  // touched, which would be wrong here.
  const s = scenario([{ type: "message", body: "Hi" }, { type: "message", body: "Second" }], { currentStep: 0, connected: true });
  const db = getDb();
  db.prepare("UPDATE run_profile_tracks SET state = 'failed' WHERE id = ?").run(s.ids.track);
  const r = callApi(retryHandler as never, "POST", { id: s.ids.run }, { target_ids: [s.ids.target] });
  assert.equal(r.status, 200, "anchor: the retry call succeeded");
  const tr = db.prepare("SELECT state, current_step, current_step_id FROM run_profile_tracks WHERE id = ?").get(s.ids.track) as
    { state: string; current_step: number; current_step_id: string | null };
  assert.equal(tr.state, "in_progress", "anchor: it was re-armed");
  assert.equal(tr.current_step, 0, "the index did not move");
  assert.equal(tr.current_step_id, s.stepIds[0], "and neither did the pin");
});

test("census: both enrolment INSERTs pin the first step", () => {
  // Source-anchored: driving POST /api/runs end-to-end needs an account, a list
  // and a workflow, which is a fixture larger than the property under test.
  // Anchored positively so a mangled read fails loudly rather than passing.
  for (const rel of ["pages/api/runs/index.ts", "pages/api/runs/[id]/enroll.ts"]) {
    // stripComments, not codeOnly: the anchor IS a string literal (the SQL), and
    // codeOnly blanks string contents by design.
    const src = stripComments(readFileSync(rel, "utf8"));
    assert.match(src, /INSERT INTO run_profile_tracks/, `anchor: ${rel} still inserts tracks`);
    assert.match(src, /firstStepIdFor/, `${rel} must pin the first step id at enrolment`);
  }
});

// ═══ X3.1 — the non-destructive save ═════════════════════════════════════════

test("X3.1: PUT refuses while a run is RUNNING, and permits it while paused (D-4)", () => {
  const s = scenario([{ type: "connect" }]);
  const body = [{ id: s.stepIds[0], step_type: "connect", track: "linkedin" }];

  const blocked = callApi(stepsHandler as never, "PUT", { id: s.ids.wf }, body);
  assert.equal(blocked.status, 409, "a live run must not have its steps edited underneath it");
  assert.match((blocked.body as { error: string }).error, /running/i, "and it must say why");

  getDb().prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(s.ids.run);
  const allowed = callApi(stepsHandler as never, "PUT", { id: s.ids.wf }, body);
  assert.equal(allowed.status, 200, "paused is editable — id-based resolution makes drift detectable, not forbidden");
});

test("X3.1: the diff inserts, updates and deletes rather than replacing", () => {
  const s = scenario([{ type: "connect" }, { type: "message", body: "one" }]);
  getDb().prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(s.ids.run);

  // keep step 0 (reordered second), drop step 1, add a new one
  const r = callApi(stepsHandler as never, "PUT", { id: s.ids.wf }, [
    { step_type: "message", track: "linkedin", message_body: "brand new" },
    { id: s.stepIds[0], step_type: "connect", track: "linkedin" },
  ]);
  assert.equal(r.status, 200, "anchor: the save succeeded");
  const rows = getDb().prepare("SELECT id, step_type, step_order FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order").all(s.ids.wf) as
    { id: string; step_type: string; step_order: number }[];
  assert.equal(rows.length, 2, "one kept, one added, one deleted");
  assert.equal(rows[0].step_type, "message", "the new step took position 1");
  assert.equal(rows[1].id, s.stepIds[0], "and the KEPT step kept its id");
  assert.equal(rows[1].step_order, 2, "renumbered from array position");
  assert.equal(rows.some(x => x.id === s.stepIds[1]), false, "the removed step is gone");
});

test("X3.1: validation rejects the bad-body classes, with the failing field", () => {
  const s = scenario([{ type: "connect" }]);
  getDb().prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(s.ids.run);
  const put = (body: unknown) => callApi(stepsHandler as never, "PUT", { id: s.ids.wf }, body);

  assert.equal(put({ nope: 1 }).status, 400, "non-array body");
  // The `!x?.length` class: a STRING has a length and passed the old guard shape.
  assert.equal(put("abcd").status, 400, "a string is not a list of steps");
  assert.equal(put([1, 2]).status, 400, "non-object elements");
  assert.equal(put([{ step_type: "teleport" }]).status, 400, "unknown step_type");
  const r = put([{ step_type: "connect" }, { step_type: "teleport" }]);
  assert.equal(r.status, 400);
  assert.ok((r.body as { field?: string }).field, "the failing field is named");
});

test("X3.1: a step id belonging to ANOTHER workflow is refused", () => {
  const mine = scenario([{ type: "connect" }]);
  const theirs = scenario([{ type: "connect" }]);
  getDb().prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(mine.ids.run);

  const r = callApi(stepsHandler as never, "PUT", { id: mine.ids.wf },
    [{ id: theirs.stepIds[0], step_type: "connect", track: "linkedin" }]);
  assert.equal(r.status, 400, "adopting another workflow's step would silently move it");
  assert.match((r.body as { error: string }).error, /different workflow/i);
  // and nothing was mutated
  const still = getDb().prepare("SELECT workflow_id FROM workflow_steps WHERE id = ?").get(theirs.stepIds[0]) as { workflow_id: string };
  assert.equal(still.workflow_id, theirs.ids.wf, "their step is untouched");
});

test("X3.1: a saved workflow keeps a paused track pointing at the SAME step", () => {
  // The property the whole unit exists for: identity survives an edit, so the
  // track resolves to its own step afterwards rather than to whatever is at its
  // old index.
  const s = scenario([{ type: "connect" }, { type: "message", body: "hi" }], { currentStep: 1, connected: true });
  getDb().prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(s.ids.run);
  const pinnedBefore = (getDb().prepare("SELECT current_step_id FROM run_profile_tracks WHERE id = ?").get(s.ids.track) as { current_step_id: string }).current_step_id;

  // reorder: message first, connect second — the N3b shape, through the real save
  callApi(stepsHandler as never, "PUT", { id: s.ids.wf }, [
    { id: s.stepIds[1], step_type: "message", track: "linkedin", message_body: "hi" },
    { id: s.stepIds[0], step_type: "connect", track: "linkedin" },
  ]);
  const pinnedAfter = (getDb().prepare("SELECT current_step_id FROM run_profile_tracks WHERE id = ?").get(s.ids.track) as { current_step_id: string }).current_step_id;
  assert.equal(pinnedAfter, pinnedBefore, "the track still points at the step it was on");
  assert.equal(pinnedAfter, s.stepIds[1], "which is the message step, now at position 1");
});

test("D-1: the legacy per-step routes keep their contract but gain the same guards", () => {
  // Appendix A D-1: do not delete these — removing a route is a contract change.
  // They must not, however, be an unguarded way around PUT's protections.
  const mine = scenario([{ type: "connect" }, { type: "message", body: "hi" }]);
  const theirs = scenario([{ type: "connect" }]);

  // 1. refused while a run is RUNNING
  const live = callApi(stepByIdHandler as never, "DELETE", { id: mine.ids.wf, stepId: mine.stepIds[0] });
  assert.equal(live.status, 409, "a live run must not have a step deleted underneath it");

  // 2. refused when the step belongs to another workflow, even once paused
  getDb().prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(mine.ids.run);
  const foreign = callApi(stepByIdHandler as never, "DELETE", { id: mine.ids.wf, stepId: theirs.stepIds[0] });
  assert.equal(foreign.status, 400, "deleting another workflow's step by id must be refused");
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) n FROM workflow_steps WHERE id = ?").get(theirs.stepIds[0]) as { n: number }).n,
    1, "and their step still exists");

  // 3. still works for its own step on a paused run — the contract is intact
  const ok = callApi(stepByIdHandler as never, "DELETE", { id: mine.ids.wf, stepId: mine.stepIds[1] });
  assert.equal(ok.status, 200, "the route still does its job");
  assert.equal(
    (getDb().prepare("SELECT COUNT(*) n FROM workflow_steps WHERE id = ?").get(mine.stepIds[1]) as { n: number }).n,
    0, "the step is gone");
});
