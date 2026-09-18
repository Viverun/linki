import test from "node:test";
import assert from "node:assert/strict";

const own = await import("@/lib/linkedin/ownership");

// ── fake browser objects ────────────────────────────────────────────────────
type FakePage = { closed: boolean; close: () => Promise<void>; isClosed: () => boolean };
type FakeCtx = { pages: () => FakePage[]; newPage: () => Promise<FakePage>; _pages: FakePage[] };
function fakeContext(): FakeCtx {
  const ctx: FakeCtx = {
    _pages: [],
    pages: () => ctx._pages.filter(p => !p.closed),
    newPage: async () => { const p: FakePage = { closed: false, isClosed: () => p.closed, close: async () => { p.closed = true; } }; ctx._pages.push(p); return p; },
  };
  return ctx;
}
const contexts = new Map<string, FakeCtx>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
own.setBrowserContextProvider(async (id) => (contexts.get(id) ?? (contexts.set(id, fakeContext()), contexts.get(id)!)) as any);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("O1 a second acquirer waits until the first releases (no overlap)", async () => {
  const order: string[] = [];
  const a = own.withBrowserOwner("acct-1", "first", { maxHoldMs: 10_000 }, async (o) => { order.push("a-start"); await o.newPage(); await sleep(50); order.push("a-end"); });
  await sleep(5);
  const b = own.withBrowserOwner("acct-1", "second", { maxHoldMs: 10_000 }, async () => { order.push("b-start"); });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
});

test("O2 accounts are independent", async () => {
  const order: string[] = [];
  await Promise.all([
    own.withBrowserOwner("acct-2", "x", { maxHoldMs: 10_000 }, async () => { order.push("2-start"); await sleep(30); order.push("2-end"); }),
    own.withBrowserOwner("acct-3", "y", { maxHoldMs: 10_000 }, async () => { order.push("3-start"); }),
  ]);
  assert.equal(order[1], "3-start", "acct-3 did not wait for acct-2");
});

test("O3 tryWithBrowserOwner reports the holder instead of waiting", async () => {
  const hold = own.withBrowserOwner("acct-4", "import", { maxHoldMs: 10_000 }, async () => { await sleep(60); });
  await sleep(5);
  const r = await own.tryWithBrowserOwner("acct-4", "step", { maxHoldMs: 1000 }, async () => "ran");
  assert.deepEqual(r, { ok: false, heldBy: "import" });
  assert.equal(own.browserOwnerState("acct-4")?.heldBy, "import");
  await hold;
  const r2 = await own.tryWithBrowserOwner("acct-4", "step", { maxHoldMs: 1000 }, async () => "ran");
  assert.deepEqual(r2, { ok: true, value: "ran" });
  assert.equal(own.browserOwnerState("acct-4"), null);
});

test("O4 max-hold aborts the holder, closes every page of the context, and admits the next only after the holder settled", async () => {
  const events: string[] = [];
  let observedAbort = false;
  const a = own.withBrowserOwner("acct-5", "slow", { maxHoldMs: 40 }, async (o) => {
    const p1 = await o.newPage(); await o.context.newPage(); // one tracked, one opened directly on the context
    o.signal.addEventListener("abort", () => { observedAbort = true; });
    await sleep(120);                                         // outlives maxHold
    events.push(`a-end pages-open=${o.context.pages().length} p1-closed=${p1.isClosed()}`);
  });
  await sleep(5);
  const b = own.withBrowserOwner("acct-5", "next", { maxHoldMs: 1000 }, async () => { events.push("b-start"); });
  await Promise.all([a, b]);
  assert.equal(observedAbort, true);
  assert.deepEqual(events, ["a-end pages-open=0 p1-closed=true", "b-start"]);
});

test("O5 waitMs expiry throws BrowserBusyError naming the holder", async () => {
  const hold = own.withBrowserOwner("acct-6", "import", { maxHoldMs: 10_000 }, async () => { await sleep(80); });
  await sleep(5);
  await assert.rejects(own.withBrowserOwner("acct-6", "route", { maxHoldMs: 100, waitMs: 20 }, async () => {}), (e: unknown) => e instanceof own.BrowserBusyError && (e as { heldBy: string }).heldBy === "import");
  await hold;
});

test("O6 a throwing holder still releases", async () => {
  await assert.rejects(own.withBrowserOwner("acct-7", "x", { maxHoldMs: 1000 }, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(own.browserOwnerState("acct-7"), null);
  const r = await own.tryWithBrowserOwner("acct-7", "y", { maxHoldMs: 1000 }, async () => 1);
  assert.deepEqual(r, { ok: true, value: 1 });
});

test("O7 acquire/release handle: release after the teardown gap admits the next holder", async () => {
  const t0 = Date.now();
  const h = await own.acquireBrowserOwner("acct-8", "step", { maxHoldMs: 1000 });
  const next = own.withBrowserOwner("acct-8", "n", { maxHoldMs: 1000 }, async () => Date.now() - t0);
  await sleep(5);
  await h.release();
  const elapsed = await next;
  assert.ok(elapsed >= own.PAGE_TEARDOWN_GAP_MS - 5, `next holder admitted only after the gap (elapsed ${elapsed})`);
});
