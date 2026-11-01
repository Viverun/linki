import test from "node:test";
import assert from "node:assert/strict";
import { mutateFetch, readError, NETWORK_ERROR_MESSAGE } from "@/lib/ui-mutation";

/**
 * PR-15 requires that success, 4xx, 5xx, network failure and non-JSON responses
 * all leave the UI truthful. These tests pin the boundary those guarantees rest
 * on; `tests/ui-mutation-surface.test.ts` proves every mutation call site uses
 * it.
 */

const realFetch = globalThis.fetch;

function stubFetch(impl: () => Promise<Response>): void {
  globalThis.fetch = impl as typeof fetch;
}

function restore(): void {
  globalThis.fetch = realFetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const html = (status: number) =>
  new Response("<!DOCTYPE html><html><body>Internal Server Error</body></html>", {
    status,
    headers: { "Content-Type": "text/html" },
  });

// ─── success ─────────────────────────────────────────────────────────────────

test("success is passed through untouched", async () => {
  stubFetch(async () => json({ id: "new-1" }, 201));
  try {
    const res = await mutateFetch("/api/x", { method: "POST" });
    assert.equal(res.ok, true);
    assert.equal(res.status, 201);
    assert.equal((await readError(res)), null, "a success body has no error to report");
  } finally {
    restore();
  }
});

test("204 (no body) is a success and is not turned into an error", async () => {
  stubFetch(async () => new Response(null, { status: 204 }));
  try {
    const res = await mutateFetch("/api/x", { method: "DELETE" });
    assert.equal(res.ok, true);
    assert.equal(res.status, 204);
  } finally {
    restore();
  }
});

// ─── refused mutations ───────────────────────────────────────────────────────

test("4xx JSON surfaces the server's message verbatim", async () => {
  stubFetch(async () => json({ error: "This list has 1 active run." }, 409));
  try {
    const res = await mutateFetch("/api/lists/l-1", { method: "DELETE" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(await readError(res), "This list has 1 active run.");
  } finally {
    restore();
  }
});

test("5xx HTML does not throw; it reports no message so the caller falls back", async () => {
  stubFetch(async () => html(500));
  try {
    const res = await mutateFetch("/api/x", { method: "POST" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 500);
    assert.equal(await readError(res), null);
  } finally {
    restore();
  }
});

test("a JSON body without a usable error field reports no message", async () => {
  for (const body of [{}, { error: "" }, { error: 42 }, { error: "   " }, null]) {
    stubFetch(async () => json(body, 400));
    try {
      const res = await mutateFetch("/api/x", { method: "POST" });
      assert.equal(await readError(res), null, `body ${JSON.stringify(body)}`);
    } finally {
      restore();
    }
  }
});

test("an empty 4xx body does not throw", async () => {
  stubFetch(async () => new Response("", { status: 400 }));
  try {
    const res = await mutateFetch("/api/x", { method: "POST" });
    assert.equal(res.ok, false);
    assert.equal(await readError(res), null);
  } finally {
    restore();
  }
});

// ─── transport failure ───────────────────────────────────────────────────────

test("a rejected fetch becomes ok:false instead of an unhandled rejection", async () => {
  stubFetch(async () => { throw new TypeError("Failed to fetch"); });
  try {
    // The whole point: this await must not throw.
    const res = await mutateFetch("/api/x", { method: "POST" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 0, "status 0 marks 'never reached the server'");
    assert.equal(await readError(res), NETWORK_ERROR_MESSAGE);
  } finally {
    restore();
  }
});

test("the network message tells the operator what happened", () => {
  assert.match(NETWORK_ERROR_MESSAGE, /connection|reach the server/i);
});

// ─── ordering guarantee the UI relies on ─────────────────────────────────────

test("a refusal is distinguishable from a success without inspecting the body", async () => {
  stubFetch(async () => json({ error: "nope" }, 403));
  try {
    const res = await mutateFetch("/api/x", { method: "PATCH" });
    // Handlers branch on `res.ok` first and only then read the message, so a
    // non-JSON error body can never swallow the guard.
    assert.equal(res.ok, false);
    assert.match(String(await readError(res)), /nope/);
  } finally {
    restore();
  }
});
