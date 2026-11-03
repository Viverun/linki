import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * PR-16 (C0 / C4) — the suite must be indifferent to the environment it inherits.
 *
 * Acceptance: "Before importing application modules, isolate all data/backup
 * paths and remove or replace external webhook settings. With harmless sentinel
 * inherited configuration, tests write only temporary fixture files and contact
 * only mocked/loopback receivers."
 *
 * This is written as a real experiment rather than an assertion about code,
 * because the register previously recorded PR-16 as Observed on the strength of
 * the isolated container running with `env -i`. A clean environment is not the
 * same property as an environment the suite ignores, and only the second one
 * survives a developer's shell or a CI runner with backup and alert variables
 * exported. Run with harmless sentinels, the suite before `scripts/test-setup.mjs`
 * gained its isolation step failed 7 of 739 and — the part that matters —
 * promoted a snapshot into the INHERITED offsite directory from a test that
 * passed no offsite option at all.
 *
 * The probe runs the real `createBackup` with only a source path, so "wrote
 * nothing to the sentinel" is a statement about the shipping code, not about a
 * stub. The sentinels point at empty throwaway directories: if they stay empty,
 * nothing escaped; if they fill up, the parent must fail.
 */

const REPO = resolve(import.meta.dirname, "..");
const SETUP = join(REPO, "scripts", "test-setup.mjs");
const PROBE = join(REPO, "tests", "support", "hermetic-env-probe.mjs");

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

interface Sentinels {
  root: string;
  backups: string;
  offsite: string;
  dbPath: string;
  webhook: string;
}

function sentinels(): Sentinels {
  const root = mkdtempSync(join(tmpdir(), "linki-sentinel-"));
  roots.push(root);
  const backups = join(root, "backups");
  const offsite = join(root, "offsite");
  mkdirSync(backups);
  mkdirSync(offsite);
  return {
    root,
    backups,
    offsite,
    dbPath: join(root, "should-not-exist.db"),
    // Loopback on a port nothing listens on: harmless, and a connection attempt
    // is itself the failure this test is about.
    webhook: "http://127.0.0.1:1/inherited-not-real",
  };
}

interface Report {
  mode: string;
  scope: string | null;
  env: Record<string, string | null>;
  snapshot: string | null;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  report: Report;
}

/**
 * @param signal which "this is a test run" signal to give the child, matching
 *   the three the bootstrap recognises. `null` means "an ordinary script" — the
 *   case that must NOT be sanitised, because the live retest and restore-drill
 *   tools share this bootstrap and need the operator's real environment.
 */
function probe(
  mode: "env" | "backup",
  opts: { sentinels: Sentinels; signal: "runner-child" | "execargv" | "marker" | null }
): Run {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // The parent is itself a test child, so its own context would otherwise leak
  // into every case and make the "ordinary script" case sanitise for the wrong
  // reason.
  delete env.NODE_TEST_CONTEXT;
  delete env.LINKI_HERMETIC_TEST_ENV;
  delete env.LINKI_TEST_ENV_SCOPE;

  Object.assign(env, {
    LINKI_DB_PATH: opts.sentinels.dbPath,
    BACKUP_DIR: opts.sentinels.backups,
    BACKUP_OFFSITE_DIR: opts.sentinels.offsite,
    BACKUP_RETAIN: "3",
    ALERT_WEBHOOK_URL: opts.sentinels.webhook,
  });

  const args: string[] = ["--import", SETUP];
  if (opts.signal === "runner-child") env.NODE_TEST_CONTEXT = "child-v8";
  if (opts.signal === "marker") env.LINKI_HERMETIC_TEST_ENV = "1";
  if (opts.signal === "execargv") args.push("--test", "--test-isolation=none", PROBE);
  else args.push(PROBE);
  args.push(mode);

  const r = spawnSync(process.execPath, args, { cwd: REPO, env, encoding: "utf8" });

  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("PROBE "));
  assert.ok(line, `probe produced no report:\nstdout=${r.stdout}\nstderr=${r.stderr}`);

  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    report: JSON.parse(line.slice("PROBE ".length)) as Report,
  };
}

const listed = (dir: string) => readdirSync(dir).sort();

/** The decisive property: nothing landed outside the temp root the bootstrap chose. */
function assertNothingEscaped(s: Sentinels) {
  assert.deepEqual(listed(s.offsite), [], "an inherited offsite directory must receive nothing");
  assert.deepEqual(listed(s.backups), [], "an inherited backup directory must receive nothing");
  assert.equal(existsSync(s.dbPath), false, "an inherited database path must not be created");
}

// ─── the property ────────────────────────────────────────────────────────────

test("with sentinel inherited configuration, a real backup writes only to the harness temp root", () => {
  const s = sentinels();

  const r = probe("backup", { sentinels: s, signal: "runner-child" });

  assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
  assert.equal(r.report.scope, "runner-child");

  // The five managed variables: three redirected into a per-process temp root,
  // two removed outright.
  const env = r.report.env;
  assert.ok(env.LINKI_DB_PATH?.startsWith(dirname(env.BACKUP_DIR!)), "the DB path is inside the harness root");
  assert.notEqual(env.LINKI_DB_PATH, s.dbPath);
  assert.match(env.BACKUP_DIR ?? "", /linki-test-env-/);
  assert.equal(env.BACKUP_OFFSITE_DIR, null, "an inherited offsite path is removed, not redirected");
  assert.equal(env.BACKUP_RETAIN, null, "an inherited retention count is removed");
  assert.equal(env.ALERT_WEBHOOK_URL, null, "no inherited webhook may survive into a test");

  // ...and the real backup honoured that, without being told to.
  assert.ok(r.report.snapshot, "createBackup ran");
  assert.equal(dirname(r.report.snapshot!), env.BACKUP_DIR, "the snapshot landed in the harness directory");
  assert.ok(r.report.snapshot!.startsWith("/tmp/") || r.report.snapshot!.includes("linki-test-env-"));
  assertNothingEscaped(s);
});

test("the override is announced by name and never by value", () => {
  // A diagnostic line that prints an inherited ALERT_WEBHOOK_URL would copy a
  // credential into CI logs — the URL can carry a token in its path.
  const s = sentinels();

  const r = probe("env", { sentinels: s, signal: "runner-child" });

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /\[test-setup\] ignored inherited /);
  for (const name of ["LINKI_DB_PATH", "BACKUP_DIR", "BACKUP_OFFSITE_DIR", "BACKUP_RETAIN", "ALERT_WEBHOOK_URL"]) {
    assert.match(r.stderr, new RegExp(name), `the notice names ${name}`);
  }
  assert.doesNotMatch(r.stderr, /inherited-not-real/, "the webhook value must not be echoed");
  assert.doesNotMatch(r.stderr, new RegExp(s.offsite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no sentinel path is echoed");
});

// ─── scope: the tools that share this bootstrap ──────────────────────────────

test("an ordinary script keeps the operator's environment", () => {
  // `npm run retest:connect` and `scripts/restore-drill.ts` import this same
  // bootstrap. Pointing a live retest at a temp database, or a restore drill at
  // an empty backup directory, would be a worse failure than the leak being
  // fixed — so sanitisation must be scoped to test runs, and only those.
  const s = sentinels();

  const r = probe("env", { sentinels: s, signal: null });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.scope, null, "nothing claims this is a test run");
  assert.equal(r.report.env.BACKUP_OFFSITE_DIR, s.offsite);
  assert.equal(r.report.env.BACKUP_DIR, s.backups);
  assert.equal(r.report.env.LINKI_DB_PATH, s.dbPath);
  assert.equal(r.report.env.ALERT_WEBHOOK_URL, s.webhook);
});

test("the explicit marker sanitises when no runner signal is present", () => {
  const s = sentinels();

  const r = probe("env", { sentinels: s, signal: "marker" });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.scope, "marker");
  assert.equal(r.report.env.BACKUP_OFFSITE_DIR, null);
  assert.equal(r.report.env.ALERT_WEBHOOK_URL, null);
});

test("--test with isolation disabled still sanitises", () => {
  // `--test-isolation=none` runs files in the runner's own process, where the
  // child marker does not exist. Without this branch the suite would silently
  // become non-hermetic for anyone using it.
  const s = sentinels();

  const r = probe("env", { sentinels: s, signal: "execargv" });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report.scope, "execargv");
  assert.equal(r.report.env.BACKUP_OFFSITE_DIR, null);
  assert.equal(r.report.env.ALERT_WEBHOOK_URL, null);
});
