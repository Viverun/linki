import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The predicate is THE definition of "should something restart this container?",
// consumed by both the Docker HEALTHCHECK and scripts/watchdog.sh. It is executed
// here as a real process against a real HTTP response, not re-implemented.
//
// Async throughout: execFileSync would block the event loop, so the test server
// would never get a chance to answer and every case would look like "unreachable".

async function runPredicate(payload: unknown | null, status = 200): Promise<number> {
  const server = createServer((_req, res) => {
    if (payload === null) { res.destroy(); return; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    await execFileAsync("node", ["scripts/health-predicate.js", `http://127.0.0.1:${port}/`]);
    return 0;
  } catch (e) {
    return (e as { code?: number }).code ?? 1;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("acts ONLY on a dead runner that a restart can fix", async () => {
  assert.equal(await runPredicate({ runner: { state: "dead" }, restart_will_help: true }, 503), 1);
});

test("does NOT act on the three restart-proof 503s", async () => {
  // Each of these repeats identically after a restart, and every restart kills
  // in-flight LinkedIn work. A human still sees the 503; nothing acts on it.
  assert.equal(await runPredicate({ db: "unreachable", restart_will_help: false }, 503), 0, "bad secret / permissions");
  assert.equal(await runPredicate({ schema: "incomplete", reason: "step_side_effects_missing", restart_will_help: false }, 503), 0, "swallowed migration");
  assert.equal(await runPredicate({ schema: "unknown", restart_will_help: false }, 503), 0, "unexpected query failure");
});

test("does NOT act on degraded or healthy", async () => {
  assert.equal(await runPredicate({ ok: true, runner: { state: "degraded", consecutive_tick_failures: 9 }, restart_will_help: false }), 0);
  assert.equal(await runPredicate({ ok: true, runner: { state: "healthy" }, restart_will_help: false }), 0);
});

test("a dead runner WITHOUT restart_will_help is not acted on — fails safe on an unknown payload", async () => {
  // e.g. an older image whose /api/health predates the field.
  assert.equal(await runPredicate({ runner: { state: "dead" } }, 503), 0);
});

test("an unanswerable server IS acted on — that is what a restart fixes", async () => {
  assert.equal(await runPredicate(null), 1);
});

test("the Dockerfile and compose both call the shared predicate, not an inline copy", async () => {
  const { readFile } = await import("node:fs/promises");
  const dockerfile = await readFile("Dockerfile", "utf8");
  const compose = await readFile("docker-compose.yml", "utf8");
  assert.match(dockerfile, /CMD node scripts\/health-predicate\.js/);
  assert.match(compose, /health-predicate\.js/);
  // An inline duplicate is exactly how the two callers would drift apart.
  assert.doesNotMatch(dockerfile, /restart_will_help===?true/, "no inline copy of the predicate");
  assert.doesNotMatch(compose, /restart_will_help===?true/, "no inline copy of the predicate");
  const ignore = await readFile(".dockerignore", "utf8");
  assert.match(ignore, /!scripts\/health-predicate\.js/, "must be present in the image");
});

test("scripts/watchdog.sh uses the shared predicate and enforces a restart budget", async () => {
  const { readFile } = await import("node:fs/promises");
  const sh = await readFile("scripts/watchdog.sh", "utf8");
  assert.match(sh, /health-predicate\.js/, "one definition, two callers");
  assert.match(sh, /FAILURES_BEFORE_ACTION/, "requires N consecutive failures");
  assert.match(sh, /MAX_RESTARTS_PER_HOUR/, "restart budget — autoheal had none");
  assert.match(sh, /BUDGET EXHAUSTED/, "and says so rather than silently continuing");
  assert.doesNotMatch(sh, /docker\.sock/, "no socket mount: that is root-equivalent on the host");
});
