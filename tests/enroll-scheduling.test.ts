import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-enroll-sched-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-enroll-scheduling-tests";

const { spreadEnrollBatch } = await import("@/lib/linkedin/runner");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const LIMITS = { active_hours_start: 9, active_hours_end: 18, timezone: "UTC", working_days: "1,2,3,4,5,6,7" };

let seq = 0;
let lastRunId = "";
/** N pending tracks under one run. Returns their ids in order. */
function makeBatch(n: number): Array<{ id: string; run_profile_id: string; track: string }> {
  const runId = `run-${++seq}`;
  lastRunId = runId;
  const db = getDb();
  db.prepare("INSERT INTO runs (id, status) VALUES (?, 'running')").run(runId);
  const rows: Array<{ id: string; run_profile_id: string; track: string }> = [];
  for (let i = 0; i < n; i++) {
    const profileId = `prof-${seq}-${i}`;
    const trackId = `trk-${seq}-${i}`;
    db.prepare("INSERT INTO run_profiles (id, run_id) VALUES (?, ?)").run(profileId, runId);
    db.prepare(
      `INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, next_step_at)
       VALUES (?, ?, 'linkedin', 'pending', 0, NULL)`
    ).run(trackId, profileId);
    rows.push({ id: trackId, run_profile_id: profileId, track: "linkedin" });
  }
  return rows;
}

const slotsOf = (rows: Array<{ id: string }>): number[] =>
  rows.map(r => {
    const v = (getDb().prepare("SELECT next_step_at FROM run_profile_tracks WHERE id = ?").get(r.id) as
      { next_step_at: string | null }).next_step_at;
    assert.ok(v, `track ${r.id} must have been scheduled`);
    return new Date(v).getTime();
  });

const stateOf = (id: string) =>
  (getDb().prepare("SELECT state FROM run_profile_tracks WHERE id = ?").get(id) as { state: string }).state;

/** Deterministic "random": always mid-bucket. */
const midBucket = () => 0.5;
const at = (iso: string) => new Date(iso);
const HOUR = 3600_000;

// A fixed Saturday, so weekday handling can't vary run to run.
const WINDOW_START = at("2026-08-08T09:00:00.000Z");
const WINDOW_END = at("2026-08-08T18:00:00.000Z");

// ─── (1) before the window → existing behaviour preserved ────────────────────

test("enrolling before the window spreads across the whole window, as before", () => {
  const rows = makeBatch(3);
  const now = at("2026-08-08T07:00:00.000Z"); // 2h before open

  spreadEnrollBatch(getDb(), lastRunId, rows, LIMITS, "linkedin", { now, random: midBucket });

  const slots = slotsOf(rows);
  // buckets of 3h across 09:00-18:00, sampled mid-bucket → 10:30, 13:30, 16:30
  assert.deepEqual(slots.map(s => new Date(s).toISOString()), [
    "2026-08-08T10:30:00.000Z",
    "2026-08-08T13:30:00.000Z",
    "2026-08-08T16:30:00.000Z",
  ]);
  assert.ok(slots[0] >= WINDOW_START.getTime(), "must not precede the window");
});

// ─── (2) exactly at window start ─────────────────────────────────────────────

test("enrolling exactly at the window start behaves identically to enrolling before it", () => {
  const rows = makeBatch(3);

  spreadEnrollBatch(getDb(), lastRunId, rows, LIMITS, "linkedin", { now: WINDOW_START, random: midBucket });

  assert.deepEqual(slotsOf(rows).map(s => new Date(s).toISOString()), [
    "2026-08-08T10:30:00.000Z",
    "2026-08-08T13:30:00.000Z",
    "2026-08-08T16:30:00.000Z",
  ]);
});

// ─── (3) halfway through the window → every slot >= now ──────────────────────

test("enrolling halfway through the window schedules every slot at or after now", () => {
  // This is the regression: anchored at 09:00, buckets 0-1 landed in the past.
  const rows = makeBatch(6);
  const now = at("2026-08-08T13:30:00.000Z");

  spreadEnrollBatch(getDb(), lastRunId, rows, LIMITS, "linkedin", { now, random: midBucket });

  const slots = slotsOf(rows);
  for (const [i, s] of slots.entries()) {
    assert.ok(s >= now.getTime(), `slot ${i} (${new Date(s).toISOString()}) must not be in the past`);
    assert.ok(s <= WINDOW_END.getTime(), `slot ${i} must stay inside the window`);
  }
});

// ─── (4) late in the window → spread across what remains ─────────────────────

test("enrolling late spreads the batch across the remaining interval, not all at now", () => {
  const rows = makeBatch(4);
  const now = at("2026-08-08T16:00:00.000Z"); // 2h left

  spreadEnrollBatch(getDb(), lastRunId, rows, LIMITS, "linkedin", { now, random: midBucket });

  const slots = slotsOf(rows);
  // 2h / 4 = 30min buckets, mid-bucket → 16:15, 16:45, 17:15, 17:45
  assert.deepEqual(slots.map(s => new Date(s).toISOString()), [
    "2026-08-08T16:15:00.000Z",
    "2026-08-08T16:45:00.000Z",
    "2026-08-08T17:15:00.000Z",
    "2026-08-08T17:45:00.000Z",
  ]);
  // strictly increasing, i.e. genuinely spread rather than clamped together
  for (let i = 1; i < slots.length; i++) {
    assert.ok(slots[i] > slots[i - 1], "slots must remain strictly ordered");
  }
});

// ─── (5) single-item batch ───────────────────────────────────────────────────

test("a single-item batch enrolled mid-window is never scheduled in the past", () => {
  // The exact live failure: one contact, enrolled 14:06 into a 09:00-18:00
  // window, drew a slot from 09:00 and became due on the next tick.
  const now = at("2026-08-08T14:06:00.000Z");

  for (const r of [0, 0.5, 0.999]) {
    const rows = makeBatch(1);
    spreadEnrollBatch(getDb(), lastRunId, rows, LIMITS, "linkedin", { now, random: () => r });
    const [slot] = slotsOf(rows);
    assert.ok(slot >= now.getTime(), `random=${r} produced a past slot ${new Date(slot).toISOString()}`);
    assert.ok(slot <= WINDOW_END.getTime());
  }
});

// ─── (6) multi-item batch → no burst ─────────────────────────────────────────

test("a multi-item batch enrolled mid-window produces no burst of immediately-due slots", () => {
  const rows = makeBatch(10);
  const now = at("2026-08-08T14:00:00.000Z");

  spreadEnrollBatch(getDb(), lastRunId, rows, LIMITS, "linkedin", { now, random: () => 0 }); // worst case: bucket floor

  const slots = slotsOf(rows);
  const dueImmediately = slots.filter(s => s <= now.getTime() + 1000).length;
  assert.equal(dueImmediately, 1, "at most the first slot may be at now; the rest must be spread");
  // 4h remaining / 10 = 24min apart
  assert.equal(slots[1] - slots[0], 24 * 60_000);
  assert.equal(slots[9] - slots[0], 9 * 24 * 60_000);
});

// ─── (7) at/near window end → tomorrow behaviour preserved ───────────────────

test("enrolling within the last 15 minutes still reschedules to tomorrow", () => {
  // rescheduleToTomorrow() reads the real clock, so anchor `now` to it and
  // shape the window around it instead of asserting a fixed timestamp.
  const realNow = new Date();
  const hourUtc = realNow.getUTCHours() + realNow.getUTCMinutes() / 60;
  const limits = { ...LIMITS, active_hours_start: 0, active_hours_end: Math.min(24, hourUtc + 0.1) };

  const rows = makeBatch(2);
  spreadEnrollBatch(getDb(), lastRunId, rows, limits, "linkedin", { now: realNow, random: midBucket });

  for (const s of slotsOf(rows)) {
    assert.ok(s > realNow.getTime(), "the tomorrow slot must be in the future");
    assert.ok(s > realNow.getTime() + 6 * HOUR, "must land on a later day, not the tail of today");
  }
});

// ─── (8) timezone boundaries ─────────────────────────────────────────────────

test("the window is computed in the account timezone, not UTC", () => {
  const limits = { ...LIMITS, timezone: "Asia/Kolkata" }; // UTC+5:30
  const rows = makeBatch(2);
  // 05:00Z = 10:30 IST — inside a 09:00-18:00 IST window, 7.5h remaining.
  const now = at("2026-08-08T05:00:00.000Z");

  spreadEnrollBatch(getDb(), lastRunId, rows, limits, "linkedin", { now, random: midBucket });

  const slots = slotsOf(rows);
  const windowEndUtc = at("2026-08-08T12:30:00.000Z").getTime(); // 18:00 IST
  for (const s of slots) {
    assert.ok(s >= now.getTime(), "slot must not precede now");
    assert.ok(s <= windowEndUtc, "slot must stay inside the IST window");
  }
  // 7.5h / 2 = 3.75h buckets, mid-bucket → 06:52:30Z and 10:37:30Z
  assert.deepEqual(slots.map(s => new Date(s).toISOString()), [
    "2026-08-08T06:52:30.000Z",
    "2026-08-08T10:37:30.000Z",
  ]);
});

// ─── (9) already-enrolled tracks are untouched ───────────────────────────────

test("tracks that are no longer pending keep their existing next_step_at", () => {
  const rows = makeBatch(2);
  const existing = "2026-08-08T17:00:00.000Z";
  // Simulate the first row already claimed+scheduled by another pass.
  getDb().prepare("UPDATE run_profile_tracks SET state='in_progress', next_step_at=? WHERE id=?")
    .run(existing, rows[0].id);

  spreadEnrollBatch(getDb(), lastRunId, rows, LIMITS, "linkedin", { now: at("2026-08-08T13:00:00.000Z"), random: midBucket });

  const untouched = (getDb().prepare("SELECT next_step_at FROM run_profile_tracks WHERE id = ?").get(rows[0].id) as
    { next_step_at: string }).next_step_at;
  assert.equal(untouched, existing, "an already-claimed track must not be rescheduled");
  assert.equal(stateOf(rows[1].id), "in_progress", "the still-pending track is claimed normally");
});
