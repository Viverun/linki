import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/db.ts resolves the DB path on first getDb(), so set it before loading.
const dbDir = mkdtempSync(join(tmpdir(), "linki-runner-claim-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-runner-claim-tests";

const { trClaim } = await import("@/lib/linkedin/runner");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened, or already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

let seq = 0;
/**
 * A run_profile_tracks row with the given state / next_step_at, plus the
 * run + run_profile parents its foreign keys require.
 */
function makeTrack(state = "in_progress", nextStepAt: string | null = iso(-60_000)): string {
  const n = ++seq;
  const runId = `run-${n}`;
  const profileId = `profile-${n}`;
  const id = `track-${n}`;
  const db = getDb();
  db.prepare("INSERT INTO runs (id, status) VALUES (?, 'running')").run(runId);
  db.prepare("INSERT INTO run_profiles (id, run_id) VALUES (?, ?)").run(profileId, runId);
  db.prepare(
    `INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, next_step_at)
     VALUES (?, ?, 'linkedin', ?, 0, ?)`
  ).run(id, profileId, state, nextStepAt);
  return id;
}

const trackRow = (id: string) =>
  getDb()
    .prepare("SELECT state, current_step, next_step_at FROM run_profile_tracks WHERE id = ?")
    .get(id) as { state: string; current_step: number; next_step_at: string | null };

// ─── (1) a due track is claimable exactly once ───────────────────────────────

test("the first claim on a due track succeeds and the second immediately fails", () => {
  const id = makeTrack("in_progress", iso(-60_000));

  assert.equal(trClaim(getDb(), id), true, "first claim should win");
  assert.equal(trClaim(getDb(), id), false, "second claim must lose — the lease is now in the future");
});

test("a track whose next_step_at is NULL is due and claimable once", () => {
  const id = makeTrack("in_progress", null);

  assert.equal(trClaim(getDb(), id), true);
  assert.equal(trClaim(getDb(), id), false);
});

// ─── (2) a future track is not claimable ─────────────────────────────────────

test("a track scheduled in the future cannot be claimed", () => {
  const id = makeTrack("in_progress", iso(6 * 3600_000));
  const before = trackRow(id).next_step_at;

  assert.equal(trClaim(getDb(), id), false);
  assert.equal(trackRow(id).next_step_at, before, "a lost claim must not move next_step_at");
});

// ─── (3) only in_progress tracks are claimable ───────────────────────────────

for (const state of ["pending", "completed", "failed", "skipped"]) {
  test(`a due track in state '${state}' cannot be claimed`, () => {
    const id = makeTrack(state, iso(-60_000));
    const before = trackRow(id).next_step_at;

    assert.equal(trClaim(getDb(), id), false);
    assert.equal(trackRow(id).next_step_at, before);
  });
}

// ─── (4) two simulated runners race for the same track ───────────────────────

test("two runner passes over the same due track let exactly one proceed", () => {
  // Mirrors the real loop: each "runner" selects due tracks, then claims before
  // executing. Both see the row as due — only the claim can separate them.
  const id = makeTrack("in_progress", iso(-60_000));

  const dueFor = (): string[] =>
    getDb()
      .prepare(
        `SELECT id FROM run_profile_tracks
         WHERE id = ? AND state = 'in_progress'
           AND (next_step_at IS NULL OR datetime(next_step_at) <= datetime('now'))`
      )
      .all(id)
      .map(r => (r as { id: string }).id);

  const runnerA = dueFor();
  const runnerB = dueFor();
  assert.deepEqual(runnerA, [id], "runner A sees it as due");
  assert.deepEqual(runnerB, [id], "runner B sees the same row as due — this is the race");

  const executed = [...runnerA, ...runnerB].filter(t => trClaim(getDb(), t));

  assert.equal(executed.length, 1, "exactly one runner may execute the track");
});

// ─── (5) the lease, and that normal scheduling still wins afterwards ─────────

test("a successful claim pushes next_step_at into the future as a lease", () => {
  const id = makeTrack("in_progress", iso(-60_000));

  assert.equal(trClaim(getDb(), id), true);

  const after = trackRow(id).next_step_at;
  assert.ok(after, "the lease must be set");
  const msAhead = new Date(after).getTime() - Date.now();
  assert.ok(msAhead > 0, `lease must be in the future, was ${msAhead}ms`);
  assert.ok(msAhead <= 15 * 60_000 + 1000, `lease must not exceed 15 minutes, was ${msAhead}ms`);
});

test("the lease uses the same ISO-UTC format as every other next_step_at write", () => {
  const id = makeTrack("in_progress", iso(-60_000));
  trClaim(getDb(), id);

  const after = trackRow(id).next_step_at!;
  assert.match(after, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // and it must still be comparable by the due-query's datetime() predicate
  const stillDue = getDb()
    .prepare("SELECT datetime(next_step_at) <= datetime('now') AS due FROM run_profile_tracks WHERE id = ?")
    .get(id) as { due: number };
  assert.equal(stillDue.due, 0, "a leased track must not read as due");
});

test("the lease is transient — a later reschedule overwrites it", () => {
  // The lease must not become a permanent second meaning for next_step_at:
  // whatever the step does at the end (here, the 6h connection recheck) wins.
  const id = makeTrack("in_progress", iso(-60_000));
  assert.equal(trClaim(getDb(), id), true);
  const leased = trackRow(id).next_step_at!;

  const sixHoursOut = iso(6 * 3600_000);
  getDb().prepare("UPDATE run_profile_tracks SET next_step_at = ? WHERE id = ?").run(sixHoursOut, id);

  const final = trackRow(id).next_step_at!;
  assert.equal(final, sixHoursOut);
  assert.ok(new Date(final).getTime() > new Date(leased).getTime(), "the 6h recheck must outlast the lease");
});

test("a claim does not touch state or current_step", () => {
  const id = makeTrack("in_progress", iso(-60_000));
  assert.equal(trClaim(getDb(), id), true);

  const row = trackRow(id);
  assert.equal(row.state, "in_progress");
  assert.equal(row.current_step, 0);
});
