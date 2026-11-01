import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

/**
 * PR-05 (C4) — watchdog shell/control flow.
 *
 * The acceptance text is behavioural, so these tests run the real script with a
 * fake health predicate and a fake restart command (PATH shims named `node` and
 * `docker`) rather than re-implementing its logic. A shell script tested by
 * translation is a shell script that has never run.
 *
 * What the shims deliberately do NOT replace: bash, flock, awk, date, wc, mv.
 * The defects being pinned are all in how those interact — `set -euo pipefail`
 * against a group ending in `[ -n ]`, an unserialised read-modify-write, an
 * in-place truncation of the state file — so substituting them would remove the
 * subject of the test.
 */

const SCRIPT = join(import.meta.dirname, "..", "scripts", "watchdog.sh");
const dirs: string[] = [];

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A directory whose files can be EXECUTED.
 *
 * The isolated gate mounts `/tmp` as `noexec` on purpose — scratch data cannot
 * be executed even if something writes a payload there — and reserves exec for
 * the workspace. A PATH shim written under `/tmp` is therefore skipped by the
 * shell, which then falls through to the REAL `node` further along PATH: a fake
 * that quietly stops being a fake. That is exactly how this suite failed its
 * first isolated run (9 of 11), while passing on the host.
 *
 * So the fixture root is probed rather than assumed: a script inside it must
 * actually run. The fallback is the workspace's `node_modules`, which must be
 * exec-capable because it holds native addons that are dlopened.
 */
const EXEC_ROOT = (() => {
  const canExec = (base: string): boolean => {
    try {
      const dir = mkdtempSync(join(base, "linki-exec-probe-"));
      const file = join(dir, "probe.sh");
      writeFileSync(file, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
      const r = spawnSync(file, [], { encoding: "utf8" });
      rmSync(dir, { recursive: true, force: true });
      return r.status === 7;
    } catch {
      return false;
    }
  };
  const fallback = join(import.meta.dirname, "..", "node_modules", ".cache");
  for (const base of [tmpdir(), fallback]) {
    try {
      mkdirSync(base, { recursive: true });
    } catch {
      continue;
    }
    if (canExec(base)) return base;
  }
  // Loud, because the alternative is a suite that silently measures the real
  // binaries instead of the fakes and reports the result as evidence.
  throw new Error("no exec-capable fixture directory: PATH shims could not be created");
})();

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

interface Sandbox {
  dir: string;
  run(extraEnv?: Record<string, string>): Result;
  runAsync(extraEnv?: Record<string, string>): Promise<Result>;
  setHealth(code: number): void;
  setDockerExit(code: number): void;
  /** Write the state file verbatim; `null` means "leave it absent". */
  seed(contents: string | null): void;
  rawState(): string;
  streak(): number;
  history(): number[];
  /** Every docker invocation, in order. */
  restarts(): string[];
  statePath: string;
}

function sandbox(opts: { health?: number; threshold?: number; max?: number; docker?: number } = {}): Sandbox {
  const dir = mkdtempSync(join(EXEC_ROOT, "linki-watchdog-"));
  dirs.push(dir);

  const bin = join(dir, "bin");
  const stateFile = join(dir, "state", ".watchdog-state");
  const restartsFile = join(dir, "restarts.log");
  const healthFile = join(dir, "health-exit");
  const dockerFile = join(dir, "docker-exit");
  mkdirSync(bin, { recursive: true });
  writeFileSync(restartsFile, "");
  writeFileSync(healthFile, String(opts.health ?? 1));
  writeFileSync(dockerFile, String(opts.docker ?? 0));

  // The health predicate. `WD_SLEEP` widens the window in which one invocation
  // provably holds the lock, which is what makes the concurrency test
  // deterministic instead of a race that usually loses.
  writeFileSync(
    join(bin, "node"),
    [
      "#!/usr/bin/env bash",
      '[ -z "${WD_SLEEP:-}" ] || sleep "${WD_SLEEP}"',
      'exit "$(cat "${HEALTH_EXIT_FILE}")"',
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  writeFileSync(
    join(bin, "docker"),
    [
      "#!/usr/bin/env bash",
      '[ -z "${WD_SLEEP:-}" ] || sleep "${WD_SLEEP}"',
      'rc="$(cat "${DOCKER_EXIT_FILE}")"',
      'echo "compose $* exit=${rc}" >> "${RESTARTS_FILE}"',
      'exit "${rc}"',
      "",
    ].join("\n"),
    { mode: 0o755 }
  );

  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COMPOSE_DIR: dir,
      STATE_FILE: stateFile,
      HEALTH_URL: "http://127.0.0.1:1/api/health",
      FAILURES_BEFORE_ACTION: String(opts.threshold ?? 3),
      MAX_RESTARTS_PER_HOUR: String(opts.max ?? 3),
      SERVICE: "linki",
      HEALTH_EXIT_FILE: healthFile,
      DOCKER_EXIT_FILE: dockerFile,
      RESTARTS_FILE: restartsFile,
      WD_SLEEP: "",
      ...extra,
    };
  }

  const self: Sandbox = {
    dir,
    statePath: stateFile,
    run(extra = {}) {
      const r = spawnSync("bash", [SCRIPT], { env: env(extra), encoding: "utf8" });
      return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    runAsync(extra = {}) {
      return new Promise((resolve) => {
        const child = spawn("bash", [SCRIPT], { env: env(extra) });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });
    },
    setHealth(code) {
      writeFileSync(healthFile, String(code));
    },
    setDockerExit(code) {
      writeFileSync(dockerFile, String(code));
    },
    seed(contents) {
      if (contents === null) return;
      mkdirSync(join(dir, "state"), { recursive: true });
      writeFileSync(stateFile, contents);
    },
    rawState() {
      return readFileSync(stateFile, "utf8");
    },
    streak() {
      return Number.parseInt(self.rawState().split("\n")[0] || "0", 10);
    },
    history() {
      return self
        .rawState()
        .split("\n")
        .slice(1)
        .filter((l) => l.trim() !== "")
        .map((l) => Number.parseInt(l, 10));
    },
    restarts() {
      return readFileSync(restartsFile, "utf8").split("\n").filter(Boolean);
    },
  };
  return self;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Assertion message for a shell invocation. The exit code alone says nothing
 * about WHY the script exited — and the first isolated run of this suite failed
 * with nine bare "1 !== 0" assertions that took a container reproduction to
 * explain. The child's stderr would have said it in one line.
 */
const why = (r: Result) =>
  `code=${r.code} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`;

// ─── the threshold is reachable at all ───────────────────────────────────────

test("an empty history reaches the threshold one failure at a time, with no premature exit", () => {
  const s = sandbox({ health: 1, threshold: 3 });

  const first = s.run();
  assert.equal(first.code, 0, why(first));
  assert.equal(s.streak(), 1);
  assert.deepEqual(s.restarts(), [], "nothing below the threshold");
  assert.match(first.stdout, /streak 1\/3/);

  const second = s.run();
  assert.equal(second.code, 0, why(second));
  assert.equal(s.streak(), 2);
  assert.deepEqual(s.restarts(), []);

  const third = s.run();
  assert.equal(third.code, 0, why(third));
  assert.equal(s.restarts().length, 1, "the third consecutive failure acts");
});

test("the first successful restart exits 0 and logs that it happened", () => {
  // The regression: with an empty history the inline
  // `{ echo 0; echo "$now"; [ -n "$history" ] && echo "$history"; } | awk`
  // group exits 1 under `pipefail`, so `set -e` killed the script AFTER the
  // restart succeeded and BEFORE "restart issued" — the one run that happens
  // after a fresh state reported failure to cron.
  const s = sandbox({ health: 1, threshold: 1 });

  const r = s.run();

  assert.equal(r.code, 0, why(r));
  assert.match(r.stdout, /restart issued/);
  assert.equal(s.restarts().length, 1);
  assert.equal(s.streak(), 0, "the streak resets once the condition is treated");
  assert.equal(s.history().length, 1, "the restart is on the budget");
  assert.ok(Math.abs(s.history()[0] - nowSec()) < 120, "the recorded epoch is now");
});

// ─── states that must not restart ────────────────────────────────────────────

test("healthy: no restart, and the streak is cleared without touching the budget", () => {
  const s = sandbox({ health: 0, threshold: 3 });
  s.seed("2\n");

  const r = s.run();

  assert.equal(r.code, 0, why(r));
  assert.deepEqual(s.restarts(), []);
  assert.equal(s.streak(), 0);
  assert.match(r.stdout, /clearing the failure streak/);
});

test("a healthy blip clears the streak but does NOT reset the hourly budget", () => {
  // Clearing the streak is about consecutive failures. If it also erased the
  // restart history, a service that flaps once an hour would restart forever.
  const s = sandbox({ health: 0, threshold: 3 });
  const t = nowSec();
  s.seed(`1\n${t}\n`);

  s.run();

  assert.equal(s.streak(), 0);
  assert.deepEqual(s.history(), [t], "the restart already spent this hour still counts");
});

test("a probe that cannot run is not an unhealthy app", () => {
  // 127 = node missing, or the predicate crashed. Restarting on that would let
  // a broken supervisor restart the service three times an hour, and restarting
  // would never fix it.
  const s = sandbox({ health: 127, threshold: 1 });
  s.seed("2\n");

  const r = s.run();

  assert.equal(r.code, 0, why(r));
  assert.deepEqual(s.restarts(), [], "a broken probe must not restart anything");
  assert.equal(s.streak(), 2, "and must not advance the streak either");
  assert.match(r.stdout, /could not run/);
});

// ─── budget ──────────────────────────────────────────────────────────────────

test("budget exhausted: no restart, streak preserved, and it says so", () => {
  const s = sandbox({ health: 1, threshold: 3, max: 2 });
  const t = nowSec();
  s.seed(`3\n${t}\n${t - 120}\n`);

  const r = s.run();

  assert.equal(r.code, 0, why(r));
  assert.deepEqual(s.restarts(), []);
  assert.match(r.stdout, /BUDGET EXHAUSTED/);
  assert.equal(s.history().length, 2, "the history is untouched");
  assert.ok(s.streak() >= 3, "the failure is still counted");
});

test("a restart more than an hour ago no longer consumes the budget", () => {
  const s = sandbox({ health: 1, threshold: 3, max: 1 });
  s.seed(`3\n${nowSec() - 3700}\n`);

  const r = s.run();

  assert.equal(s.restarts().length, 1, "the old restart is outside the window");
  assert.match(r.stdout, /0 restarts in the last hour/);
});

test("history older than 24h is pruned so the file cannot grow without bound", () => {
  const s = sandbox({ health: 1, threshold: 3, max: 1 });
  const ancient = nowSec() - 90_000; // ~25h
  s.seed(`3\n${ancient}\n`);

  s.run();

  assert.ok(!s.history().includes(ancient), "an entry that cannot affect any decision is dropped");
  assert.equal(s.history().length, 1, "only today's restart remains");
});

// ─── failure recovery ────────────────────────────────────────────────────────

test("a failed restart stays recoverable and is visible to whatever runs the cron job", () => {
  const s = sandbox({ health: 1, threshold: 1, docker: 1 });

  const failed = s.run();

  assert.equal(failed.code, 1, why(failed));
  assert.match(failed.stdout, /restart FAILED/);
  assert.equal(s.streak(), 1, "the streak is intact so the next run retries");
  assert.deepEqual(s.history(), [], "a restart that did not happen spends no budget");

  // The condition clears; the very next run must act, not wait for the streak to
  // rebuild from zero.
  s.setDockerExit(0);
  const recovered = s.run();

  assert.equal(recovered.code, 0, why(recovered));
  assert.equal(s.restarts().length, 2, "the retry actually reached docker");
  assert.equal(s.streak(), 0);
});

// ─── state-file resilience ───────────────────────────────────────────────────

test("a zero-byte state file is a fresh state, not a crash", () => {
  // In-place `>` truncation leaves exactly this after a host dies mid-write.
  const s = sandbox({ health: 1, threshold: 3 });
  s.seed("");

  const r = s.run();

  assert.equal(r.code, 0, why(r));
  assert.equal(s.streak(), 1, "it counts from zero instead of failing on arithmetic");
});

// ─── concurrency ─────────────────────────────────────────────────────────────

test("concurrent invocations cannot lose a budget update", async () => {
  // Read-modify-write without a lock: both runs read streak=0, both write 1, both
  // restart, and the history ends up with one entry for two restarts. `WD_SLEEP`
  // holds the winner's lock open long enough for the loser to provably collide
  // rather than merely start late.
  const s = sandbox({ health: 1, threshold: 1, max: 3 });
  s.seed("0\n");

  const [a, b] = await Promise.all([s.runAsync({ WD_SLEEP: "1.5" }), s.runAsync({ WD_SLEEP: "1.5" })]);

  assert.equal(s.restarts().length, 1, "exactly one invocation may restart the service");
  assert.equal(s.history().length, 1, "and the budget must contain exactly that one restart");
  assert.equal(s.streak(), 0);

  const both = `${a.stdout}${b.stdout}`;
  assert.equal(
    (both.match(/skipping this tick/g) ?? []).length,
    1,
    "the loser must skip explicitly, not fail silently"
  );
  assert.equal([a.code, b.code].filter((c) => c === 0).length, 2, "a skipped tick is not an error");
});
