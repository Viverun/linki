import test from "node:test";
import assert from "node:assert/strict";
import { mutationOutcome, reconcileMutation } from "@/lib/ui-mutation";

/**
 * PR-15 (C3) — the ambiguous-outcome clause.
 *
 * `!res.ok` collapses three different facts into one: the server refused, the
 * server failed after possibly committing, and nobody ever learned what
 * happened. Reporting all three as "failed" is a false negative that invites a
 * retry of a non-idempotent POST, which is how one list becomes two.
 *
 * Two decisions are tested here:
 *
 *   - `mutationOutcome` — only a 4xx is a fact about what the server did.
 *   - `reconcileMutation` — resolves the rest by READING, and distinguishes
 *     "I looked and it is not there" from "I could not look". Only the first
 *     may be presented as failure.
 */

const res = (status: number) => ({ ok: status >= 200 && status < 300, status });

test("only a 4xx is a statement about what the server did", () => {
  for (const status of [200, 201, 202, 204]) {
    assert.equal(mutationOutcome(res(status)), "applied", `${status} succeeded`);
  }
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    assert.equal(mutationOutcome(res(status)), "refused", `${status} was a refusal`);
  }
  // 0 is the synthetic transport failure `mutateFetch` returns; 5xx may be a
  // proxy that never reached the app, or a handler that committed and threw.
  for (const status of [0, 500, 502, 503, 504]) {
    assert.equal(mutationOutcome(res(status)), "unknown", `${status} is not knowable`);
  }
});

test("an applied mutation is resolved by one read", async () => {
  let reads = 0;
  const result = await reconcileMutation({
    read: async () => {
      reads++;
      return ["alpha"];
    },
    confirm: (rows) => rows.includes("alpha"),
    delayMs: 0,
  });

  assert.equal(result.state, "applied");
  assert.equal(reads, 1);
  assert.deepEqual(result.snapshot, ["alpha"]);
});

test("a write still in flight is found by a later read, not by resending", async () => {
  // The lost response does not mean the request finished; the second read sees
  // what the first one could not. Nothing here can re-send the mutation.
  const snapshots = [["alpha"], ["alpha", "beta"], ["alpha", "beta"]];
  let reads = 0;
  const result = await reconcileMutation({
    read: async () => snapshots[Math.min(reads++, snapshots.length - 1)],
    confirm: (rows) => rows.includes("beta"),
    attempts: 4,
    delayMs: 0,
  });

  assert.equal(result.state, "applied");
  assert.equal(reads, 2, "the second read is what confirmed it");
});

test("absence after every read is 'not applied', with the server's state returned", async () => {
  let reads = 0;
  const result = await reconcileMutation({
    read: async () => {
      reads++;
      return ["alpha"];
    },
    confirm: (rows) => rows.includes("beta"),
    attempts: 3,
    delayMs: 0,
  });

  assert.equal(result.state, "not-applied");
  assert.equal(reads, 3, "reads are bounded — the UI cannot hang on a guess");
  // The caller renders this snapshot either way, so a failed create still shows
  // the truth rather than the stale list the operator was looking at.
  assert.deepEqual(result.snapshot, ["alpha"]);
});

test("'could not look' is not 'not there'", async () => {
  const result = await reconcileMutation({
    read: async () => {
      throw new Error("offline");
    },
    confirm: () => true,
    attempts: 3,
    delayMs: 0,
  });

  assert.equal(result.state, "unknown", "absence was never observed, so it cannot be claimed");
  assert.equal(result.snapshot, null);
  assert.equal(result.reads, 3);
});

test("losing sight of the resource after an inconclusive read is still unknown", async () => {
  // Saw it absent, then the network died. Reporting "not applied" would assert
  // something the last observation does not support.
  const results: Array<() => Promise<string[]>> = [
    async () => ["alpha"],
    async () => {
      throw new Error("offline");
    },
  ];
  let i = 0;
  const result = await reconcileMutation({
    read: () => results[Math.min(i++, results.length - 1)](),
    confirm: (rows) => rows.includes("beta"),
    attempts: 3,
    delayMs: 0,
  });

  assert.equal(result.state, "unknown");
  assert.deepEqual(result.snapshot, ["alpha"], "the last successful read is still returned");
});

test("attempts is honoured exactly, so the wait is bounded", async () => {
  for (const attempts of [1, 2, 5]) {
    let reads = 0;
    await reconcileMutation({
      read: async () => {
        reads++;
        return null;
      },
      confirm: () => false,
      attempts,
      delayMs: 0,
    });
    assert.equal(reads, attempts);
  }
});
