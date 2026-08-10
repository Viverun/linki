import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const dbDir = mkdtempSync(join(tmpdir(), "linki-alerting-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-alerting-tests";

const runner = await import("@/lib/linkedin/runner");
const { getDb } = await import("@/lib/db");
const db = getDb();

after(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

const readKey = (k: string) =>
  (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
const failures = () => parseInt(readKey("runner_tick_failures") ?? "0", 10);
const resetAll = () =>
  db.prepare("DELETE FROM app_settings WHERE key LIKE 'runner_%' OR key LIKE 'alert_%'").run();

/** A throwaway webhook receiver that records what it was sent. */
async function withWebhook(fn: (url: string, received: unknown[]) => Promise<void>) {
  const received: unknown[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try { received.push(JSON.parse(body)); } catch { received.push(body); }
      res.writeHead(200); res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}/`, received);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// ─── P2-2 REPRODUCTION ───────────────────────────────────────────────────────
// NF-4 as lived: tick is wrapped inside while(true), so a tick that throws every
// iteration leaves the loop spinning, the progress marker fresh, and nothing
// accomplished. Phase 1 made it *visible* in /api/health. Nothing makes it reach
// a person.

test("P2-2 repro: a tick failing every iteration climbs the counter and reaches NOBODY", async () => {
  resetAll();

  // Five consecutive failures — the degraded threshold.
  for (let i = 0; i < 5; i++) runner.recordTickOutcome(db, new Error("tick exploded"));
  assert.equal(failures(), 5, "the counter climbs, as Phase 1 built it to");

  // ...and that is the end of it. Nothing notifies, nothing is queued, nothing
  // records that a human was told.
  assert.equal(typeof (runner as Record<string, unknown>).notifyRunnerState, "function",
    "an alerting entry point must exist");
  assert.notEqual(readKey("alert_last_state"), null,
    "something must persist what was last announced, or 'transition' is unknowable");
});

// ─── Part A: the error-class allowlist ───────────────────────────────────────

test("A: classifyError maps known errors to their class and everything else to unknown_error", () => {
  class NotConnectedError extends Error {}
  assert.equal(runner.classifyError(new NotConnectedError("x")), "NotConnectedError");
  assert.equal(runner.classifyError(new TypeError("x")), "TypeError");
  // Not on the allowlist -> bucketed, never passed through.
  class SomeVendorSpecificError extends Error {}
  assert.equal(runner.classifyError(new SomeVendorSpecificError("x")), "unknown_error");
  assert.equal(runner.classifyError("a bare string"), "unknown_error");
  assert.equal(runner.classifyError(null), "unknown_error");
});

test("A: an error message containing a path AND a token leaks into nothing (I9)", async () => {
  resetAll();
  const nasty = new Error(
    "SQLITE_CANTOPEN: unable to open /data/linki.db (li_at=AQEDATExampleSecretToken123 at /home/op/secrets.env)"
  );

  runner.recordTickOutcome(db, nasty);

  // 1. Nothing in app_settings.
  const settings = db.prepare("SELECT key, value FROM app_settings").all() as Array<{ key: string; value: string }>;
  const blob = JSON.stringify(settings);
  for (const secret of ["/data/linki.db", "li_at", "AQEDATExample", "/home/op", "secrets.env"]) {
    assert.ok(!blob.includes(secret), `app_settings must not contain ${secret}`);
  }

  // 2. Nothing in the webhook body.
  await withWebhook(async (url, received) => {
    process.env.ALERT_WEBHOOK_URL = url;
    await runner.notifyRunnerState(db, { state: "degraded", failures: 5, errorClass: runner.classifyError(nasty) });
    delete process.env.ALERT_WEBHOOK_URL;
    assert.equal(received.length, 1, "one notification");
    const sent = JSON.stringify(received[0]);
    for (const secret of ["/data/linki.db", "li_at", "AQEDATExample", "/home/op", "secrets.env", "unable to open"]) {
      assert.ok(!sent.includes(secret), `webhook body must not contain ${secret}`);
    }
    assert.match(sent, /degraded/, "but it does carry the state");
  });
});

test("A: the stored error class is the classified value, not the raw constructor name", () => {
  resetAll();
  class WeirdlyNamedThing extends Error {}
  runner.recordTickOutcome(db, new WeirdlyNamedThing("boom"));
  assert.equal(readKey("runner_last_error_class"), "unknown_error",
    "an unrecognised class is bucketed — a class name is attacker-influenceable in principle");
});

// ─── Part B: the banner ──────────────────────────────────────────────────────
// The project has no DOM test tooling and adding some would mean new
// dependencies, so the split is deliberate and stated rather than hidden: every
// DECISION the banner makes lives in bannerFromHealth and is tested behaviourally
// below; only the React wiring is checked structurally, at the end.

const { bannerFromHealth } = await import("@/lib/health-contract");

const healthy = { ok: true, body: { ok: true, runner: { state: "healthy", consecutive_tick_failures: 0 } } };
const degraded = (failures: number, cls: string) =>
  ({ ok: true, body: { ok: true, runner: { state: "degraded", consecutive_tick_failures: failures, last_error_class: cls } } });
const dead = { ok: false, body: { ok: false, restart_will_help: true, runner: { state: "dead" } } };

test("B: a healthy runner shows nothing", () => {
  assert.equal(bannerFromHealth(healthy).severity, "none");
});

test("B: degraded warns, names the count and the class", () => {
  const b = bannerFromHealth(degraded(7, "SqliteError"));
  assert.equal(b.severity, "warn");
  assert.match(b.detail, /7/, "the operator needs to know how long it has been failing");
  assert.match(b.detail, /SqliteError/);
});

test("B: dead is an error, and says work has stopped", () => {
  const b = bannerFromHealth(dead);
  assert.equal(b.severity, "error");
  assert.match(b.detail, /not being executed|no campaign work/i);
});

test("B: a 503 a restart cannot fix says so, instead of implying it will clear", () => {
  const b = bannerFromHealth({ ok: false, body: { ok: false, restart_will_help: false, reason: "step_side_effects_missing" } });
  assert.equal(b.severity, "error");
  assert.match(b.detail, /will not fix/i);
  assert.match(b.detail, /step_side_effects_missing/);
});

test("B: an unreachable or unparseable response is NOT treated as healthy", () => {
  // The whole point of P2-2. A proxy in front of a stopped container returns an
  // HTML 502; `.json()` throws; a component that swallows that and renders
  // nothing reports "all clear" during a total outage.
  for (const input of [null, { ok: false, body: null }, { ok: true, body: "<html>502 Bad Gateway</html>" }]) {
    const b = bannerFromHealth(input as Parameters<typeof bannerFromHealth>[0]);
    assert.equal(b.severity, "error", `${JSON.stringify(input)} must not read as healthy`);
  }
});

test("B: dismissing a degraded banner cannot hide a later dead one", () => {
  // Dismissal is remembered against the key. If every banner shared one key, the
  // most severe state would be the one most likely already silenced.
  const d = bannerFromHealth(degraded(5, "TypeError"));
  assert.notEqual(d.key, bannerFromHealth(dead).key, "dead is a different problem");
  assert.equal(d.key, bannerFromHealth(degraded(9, "TypeError")).key,
    "but the same failure with a higher count is the SAME problem — a dismissal must survive the counter ticking");
  assert.notEqual(d.key, bannerFromHealth(degraded(5, "SqliteError")).key,
    "a different failure class is a different problem");
});

test("B/I9: a leaked error class in the payload cannot reach the DOM", () => {
  // Re-validated on read. The allowlist upstream is not trusted here, because
  // this function is what puts the string on a page.
  const leaked = bannerFromHealth(
    degraded(5, "Error: li_at=AQEDATExampleSecretToken123 at /home/op/secrets.env")
  );
  for (const secret of ["li_at", "AQEDATExample", "/home/op", "secrets.env"]) {
    assert.ok(!JSON.stringify(leaked).includes(secret), `banner must not carry ${secret}`);
  }
  assert.match(leaked.detail, /unknown_error/, "it is bucketed, not dropped silently");
});

test("B: the component's polling hygiene", async () => {
  // Structural, and weaker than the tests above — it asserts the wiring reads a
  // certain way, not that it behaves a certain way. It is here because the
  // alternative is no check at all on properties that are easy to regress.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile("components/layout/RunnerHealthBanner.tsx", "utf8");

  // Comments stripped FIRST, and every assertion below reads the stripped text.
  // Two mutations survived the first version of this test because the component
  // explains in prose why the wrong API is wrong — so `assert.match(src, /res\.ok/)`
  // passed against a comment while the code had stopped checking it. A structural
  // test that can be satisfied by a comment is not a test.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  assert.match(code, /POLL_MS = 60_000/, "polls at 60s");
  assert.match(code, /addEventListener\("visibilitychange"/, "pauses when the tab is hidden");
  assert.match(code, /clearInterval\(timer\)/, "and actually stops the timer");
  assert.match(code, /removeEventListener\("visibilitychange"/, "cleans up on unmount");
  assert.match(code, /\{\s*ok:\s*res\.ok/, "the response's .ok is what reaches the decision, not a hardcoded true");
  assert.match(code, /sessionStorage/, "dismissal is session-scoped");
  assert.ok(!/localStorage/.test(code),
    "localStorage would let a dismissal outlive the outage it hid, by months");

  const layout = await readFile("components/layout/Layout.tsx", "utf8");
  const earlyReturn = layout.indexOf("return <>{children}</>");
  const mount = layout.indexOf("<RunnerHealthBanner />");
  assert.ok(earlyReturn > 0 && mount > earlyReturn,
    "mounted BELOW the /login early return, so it can never poll from the login page");
});

// ─── Part C: transition-only webhook ─────────────────────────────────────────

test("C: notifies on TRANSITION into degraded, not on every tick", async () => {
  resetAll();
  await withWebhook(async (url, received) => {
    process.env.ALERT_WEBHOOK_URL = url;
    for (let i = 0; i < 6; i++) {
      await runner.notifyRunnerState(db, { state: "degraded", failures: 5 + i, errorClass: "TypeError" });
    }
    delete process.env.ALERT_WEBHOOK_URL;
    assert.equal(received.length, 1, "six degraded ticks must produce ONE notification, not six");
  });
});

test("C: re-notifies after recovery and a fresh transition", async () => {
  resetAll();
  await withWebhook(async (url, received) => {
    process.env.ALERT_WEBHOOK_URL = url;
    await runner.notifyRunnerState(db, { state: "degraded", failures: 5, errorClass: "TypeError" });
    await runner.notifyRunnerState(db, { state: "healthy", failures: 0 });
    await runner.notifyRunnerState(db, { state: "degraded", failures: 5, errorClass: "TypeError" });
    delete process.env.ALERT_WEBHOOK_URL;
    assert.equal(received.length, 3, "degraded -> healthy -> degraded is three real transitions");
  });
});

test("C: does nothing at all when ALERT_WEBHOOK_URL is unset", async () => {
  resetAll();
  delete process.env.ALERT_WEBHOOK_URL;
  await runner.notifyRunnerState(db, { state: "dead", failures: 0 });
  assert.equal(readKey("alert_last_state"), "dead", "state is still tracked for the banner");
});

test("C: a failing webhook logs and continues — it can never fail a tick", async () => {
  resetAll();
  process.env.ALERT_WEBHOOK_URL = "http://127.0.0.1:1/definitely-refused";
  await assert.doesNotReject(
    () => runner.notifyRunnerState(db, { state: "degraded", failures: 5, errorClass: "TypeError" }),
    "a notification failure must never propagate"
  );
  delete process.env.ALERT_WEBHOOK_URL;
});

test("C: the payload carries state, counts, class and timestamp — and nothing else", async () => {
  resetAll();
  await withWebhook(async (url, received) => {
    process.env.ALERT_WEBHOOK_URL = url;
    await runner.notifyRunnerState(db, { state: "degraded", failures: 7, errorClass: "SqliteError" });
    delete process.env.ALERT_WEBHOOK_URL;
    const body = received[0] as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      ["consecutive_tick_failures", "error_class", "service", "state", "timestamp"],
      "an exact key set — new fields are how target names eventually leak"
    );
    assert.equal(body.state, "degraded");
    assert.equal(body.consecutive_tick_failures, 7);
    assert.equal(body.error_class, "SqliteError");
  });
});
