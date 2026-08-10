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

async function runPredicateWithStderr(payload: unknown | null, status = 200): Promise<{ code: number; stderr: string }> {
  const server = createServer((_req, res) => {
    if (payload === null) { res.destroy(); return; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const { stderr } = await execFileAsync("node", ["scripts/health-predicate.js", `http://127.0.0.1:${port}/`]);
    return { code: 0, stderr };
  } catch (e) {
    const err = e as { code?: number; stderr?: string };
    return { code: err.code ?? 1, stderr: err.stderr ?? "" };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

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
  assert.equal(await runPredicate({ health_schema: 1, runner: { state: "dead" }, restart_will_help: true }, 503), 1);
});

test("does NOT act on the three restart-proof 503s", async () => {
  // Each of these repeats identically after a restart, and every restart kills
  // in-flight LinkedIn work. A human still sees the 503; nothing acts on it.
  assert.equal(await runPredicate({ health_schema: 1, db: "unreachable", restart_will_help: false }, 503), 0, "bad secret / permissions");
  assert.equal(await runPredicate({ health_schema: 1, schema: "incomplete", reason: "step_side_effects_missing", restart_will_help: false }, 503), 0, "swallowed migration");
  assert.equal(await runPredicate({ health_schema: 1, schema: "unknown", restart_will_help: false }, 503), 0, "unexpected query failure");
});

test("does NOT act on degraded or healthy", async () => {
  assert.equal(await runPredicate({ health_schema: 1, ok: true, runner: { state: "degraded", consecutive_tick_failures: 9 }, restart_will_help: false }), 0);
  assert.equal(await runPredicate({ health_schema: 1, ok: true, runner: { state: "healthy" }, restart_will_help: false }), 0);
});

// §2 — FAIL-SAFE MUST NOT BE FAIL-SILENT.
// Each of these correctly declines to act. Each must also SAY SO: "no action" is
// indistinguishable from "healthy" in exit codes alone, so a renamed field would
// otherwise leave a supervisor that has quietly stopped protecting anything.

test("absent restart_will_help: no action, and it says the supervisor is inactive", async () => {
  const r = await runPredicateWithStderr({ health_schema: 1, runner: { state: "dead" } }, 503);
  assert.equal(r.code, 0, "must not act on a payload it does not understand");
  assert.match(r.stderr, /SUPERVISOR INACTIVE/, "and must not do so silently");
  assert.match(r.stderr, /restart_will_help/, "naming the missing field");
});

test("unexpected health_schema: no action, and it names the version mismatch", async () => {
  const r = await runPredicateWithStderr({ health_schema: 99, runner: { state: "dead" }, restart_will_help: true }, 503);
  assert.equal(r.code, 0, "a contract we do not understand is not actionable");
  assert.match(r.stderr, /SUPERVISOR INACTIVE/);
  assert.match(r.stderr, /health_schema=99/, "naming what it saw");
});

test("a non-object payload: no action, loudly", async () => {
  const r = await runPredicateWithStderr("not-json-object");
  assert.equal(r.code, 0);
  assert.match(r.stderr, /SUPERVISOR INACTIVE/);
});

test("the live health route emits the version the predicate expects", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile("pages/api/health.ts", "utf8");
  const pred = await readFile("scripts/health-predicate.js", "utf8");
  const routeVersion = route.match(/const HEALTH_SCHEMA = (\d+)/)?.[1];
  const predVersion = pred.match(/const EXPECTED_SCHEMA = (\d+)/)?.[1];
  assert.ok(routeVersion, "route declares HEALTH_SCHEMA");
  assert.equal(routeVersion, predVersion, "route and predicate must agree on the contract version");
  assert.match(route, /health_schema: HEALTH_SCHEMA/, "and every response carries it");
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
