import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { codeOnly } from "@/tests/support/source-text";

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
  // Comments stripped: `.match()` returns the FIRST hit, so a stale
  // `// legacy: const HEALTH_SCHEMA = 1` above a live `= 2` fed the OLD number
  // to this assertion while route and predicate silently disagreed about the
  // contract version — precisely the drift this test exists to catch (A3).
  const route = codeOnly(await readFile("pages/api/health.ts", "utf8"));
  const pred = codeOnly(await readFile("scripts/health-predicate.js", "utf8"));

  const routeMatches = [...route.matchAll(/const HEALTH_SCHEMA = (\d+)/g)];
  const predMatches = [...pred.matchAll(/const EXPECTED_SCHEMA = (\d+)/g)];
  // Exactly one declaration each. Two live declarations would make "the version"
  // ambiguous, and picking the first would be a guess.
  assert.equal(routeMatches.length, 1, "the route must declare HEALTH_SCHEMA exactly once");
  assert.equal(predMatches.length, 1, "the predicate must declare EXPECTED_SCHEMA exactly once");

  assert.equal(routeMatches[0][1], predMatches[0][1],
    "route and predicate must agree on the contract version");
  assert.match(route, /health_schema: HEALTH_SCHEMA/, "and every response carries it");
});

test("an unanswerable server IS acted on — that is what a restart fixes", async () => {
  assert.equal(await runPredicate(null), 1);
});

test("the Dockerfile and compose both call the shared predicate, not an inline copy", async () => {
  const { readFile } = await import("node:fs/promises");
  // Comments stripped. A2: replacing the real CMD with an inline curl and
  // leaving `# was: CMD node scripts/health-predicate.js` behind kept this test
  // green — the healthcheck would have stopped consulting the shared predicate
  // while the test still said it did.
  const dockerfile = codeOnly(await readFile("Dockerfile", "utf8"), { style: "hash", strings: false });
  const compose = codeOnly(await readFile("docker-compose.yml", "utf8"), { style: "hash", strings: false });

  // strings:false — a Dockerfile CMD and a compose healthcheck ARE quoted text.
  // Blanking literals here would erase the very thing being asserted.
  assert.match(dockerfile, /CMD node scripts\/health-predicate\.js/);
  assert.match(compose, /health-predicate\.js/);

  // An inline duplicate is exactly how the two callers would drift apart.
  // Whitespace-tolerant: the original `/restart_will_help===?true/` would have
  // let `restart_will_help === true` through, which is how anyone would actually
  // write it.
  const INLINE_COPY = /restart_will_help\s*===?\s*true/;
  assert.doesNotMatch(dockerfile, INLINE_COPY, "no inline copy of the predicate");
  assert.doesNotMatch(compose, INLINE_COPY, "no inline copy of the predicate");

  const ignore = await readFile(".dockerignore", "utf8");
  assert.match(ignore, /!scripts\/health-predicate\.js/, "must be present in the image");
});

test("scripts/watchdog.sh uses the shared predicate and enforces a restart budget", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile("scripts/watchdog.sh", "utf8");
  // strings:false — this script's echoed text IS its behaviour; BUDGET EXHAUSTED
  // is what an operator reads in the log, not incidental prose.
  const sh = codeOnly(raw, { style: "hash", strings: false });

  // A1: the script could stop invoking the predicate altogether — replacing it
  // with an inline `curl | grep` — and the header comment naming the file kept
  // this green. Match the INVOCATION, not the mention.
  assert.match(sh, /node\s+.*health-predicate\.js/, "one definition, two callers — and it is actually invoked");
  assert.match(sh, /FAILURES_BEFORE_ACTION/, "requires N consecutive failures");
  assert.match(sh, /MAX_RESTARTS_PER_HOUR/, "restart budget — autoheal had none");
  assert.match(sh, /BUDGET EXHAUSTED/, "and says so rather than silently continuing");

  // Checked against the RAW text on purpose: a socket mount hidden inside a
  // comment is still a socket mount waiting to be uncommented, and the cost of
  // a false positive here (someone renames a comment) is trivial next to the
  // cost of a miss (root-equivalent host access).
  assert.doesNotMatch(raw, /docker\.sock/, "no socket mount: that is root-equivalent on the host");
});
