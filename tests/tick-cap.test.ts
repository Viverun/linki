import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-tick-cap-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-tick-cap-tests";

const { MAX_TRACKS_PER_TICK, tracksForTick } = await import("@/lib/linkedin/runner");

after(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

test("a tick executes at most MAX_TRACKS_PER_TICK due tracks", () => {
  const due = Array.from({ length: 23 }, (_, i) => i);
  const batch = tracksForTick(due);
  assert.equal(batch.length, MAX_TRACKS_PER_TICK);
  assert.deepEqual(batch, due.slice(0, MAX_TRACKS_PER_TICK));
});

test("the cap keeps oldest-due order and does not mutate the input", () => {
  const due = ["a", "b", "c", "d", "e", "f", "g"];
  const before = [...due];
  assert.deepEqual(tracksForTick(due), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(due, before, "the due list is reused for other passes in tick()");
});

test("fewer due tracks than the cap all run, and an empty list stays empty", () => {
  assert.deepEqual(tracksForTick(["a", "b"]), ["a", "b"]);
  assert.deepEqual(tracksForTick([]), []);
});

test("the cap is bounded: it must not be removed or raised past the audit's ten-track case", () => {
  // NF-5 measured ~61 minutes for ten tracks. A cap of ten would reproduce the
  // audited state, so the guard is deliberately below it.
  assert.ok(Number.isInteger(MAX_TRACKS_PER_TICK), "cap must be an integer");
  assert.ok(MAX_TRACKS_PER_TICK > 0, "a zero cap would stall the runner forever");
  assert.ok(MAX_TRACKS_PER_TICK < 10, "a cap of ten reproduces the ~61-minute tick NF-5 measured");
});

test("tick() actually applies the cap instead of iterating the raw due list", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile("lib/linkedin/runner.ts", "utf8");
  assert.match(src, /for \(const tr of tracksForTick\(toExecute\)\)/);
  assert.doesNotMatch(src, /for \(const tr of toExecute\)/);
});
