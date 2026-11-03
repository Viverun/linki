// Test bootstrap: resolver hooks + hermetic environment.
//
// Loaded with `--import`, which runs before any test file and therefore before
// any application module is imported. That ordering is the whole point of the
// environment work below — `lib/db.ts` reads LINKI_DB_PATH at module scope, so a
// sanitiser that ran later would already be too late.
import { register } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register("./test-resolve-hooks.mjs", import.meta.url);

/**
 * PR-16 — the suite must not inherit an operator's real configuration.
 *
 * This was a live defect, not a hypothesis. Running the whole suite with
 * harmless sentinels in the environment (`BACKUP_OFFSITE_DIR` pointing at an
 * empty throwaway directory, `ALERT_WEBHOOK_URL` at a loopback recorder,
 * `BACKUP_DIR`/`BACKUP_RETAIN`/`LINKI_DB_PATH` at throwaway paths) changed what
 * the tests did: seven failed, and one of them — a test that passes no
 * `offsiteDir` — promoted a real snapshot into the *inherited* offsite
 * directory. On a developer's shell or a CI runner with those variables set for
 * real, that means test snapshots written beside production backups, and
 * retention pruning them.
 *
 * The isolated gate hid this: it runs with `env -i`, so there is nothing to
 * inherit. A clean environment is not the same property as an environment the
 * suite is indifferent to, and only the second one is testable.
 *
 * So the five variables that can redirect data or reach the network are
 * replaced (or removed) before any app module loads:
 *
 *   LINKI_DB_PATH      -> a per-process temp file (lib/db.ts reads it at import)
 *   BACKUP_DIR         -> a temp directory
 *   BACKUP_OFFSITE_DIR -> removed: any inherited value would receive snapshots
 *   BACKUP_RETAIN      -> removed: retention must be the code's default here
 *   ALERT_WEBHOOK_URL  -> removed: an inherited URL is a real external receiver
 *
 * Tests that need specific values still set them after import; those overrides
 * are per-process (the runner isolates test files), so one file's environment
 * cannot leak into another's.
 *
 * SCOPE, deliberately: this applies only when the process is a test run. The
 * live tools share this bootstrap (`npm run retest:connect`, `scripts/
 * restore-drill.ts`) and *must* keep the operator's real environment — pointing
 * a live retest at a temp database would be worse than the leak being fixed.
 * The three signals are the runner's own child marker, `--test` in execArgv
 * (covers `--test-isolation=none`, where no child marker exists), and an
 * explicit marker for harnesses that invoke files directly.
 */
const scope = process.env.NODE_TEST_CONTEXT !== undefined
  ? "runner-child"
  : process.execArgv.some((arg) => arg === "--test" || arg.startsWith("--test="))
    ? "execargv"
    : process.env.LINKI_HERMETIC_TEST_ENV === "1"
      ? "marker"
      : null;

if (scope !== null) {
  // Which signal matched, recorded so a failure says "the harness stopped
  // recognising this run" instead of "the environment was unexpectedly clean".
  process.env.LINKI_TEST_ENV_SCOPE = scope;

  const managed = ["LINKI_DB_PATH", "BACKUP_DIR", "BACKUP_OFFSITE_DIR", "BACKUP_RETAIN", "ALERT_WEBHOOK_URL"];
  const ignored = managed.filter((name) => process.env[name] !== undefined);

  const root = mkdtempSync(join(tmpdir(), "linki-test-env-"));
  process.env.LINKI_DB_PATH = join(root, "db.sqlite");
  process.env.BACKUP_DIR = join(root, "backups");
  delete process.env.BACKUP_OFFSITE_DIR;
  delete process.env.BACKUP_RETAIN;
  delete process.env.ALERT_WEBHOOK_URL;

  // Names only. An inherited ALERT_WEBHOOK_URL can contain a token in its path,
  // and a diagnostic line is not a reason to copy a credential into CI logs.
  if (ignored.length > 0) {
    console.error(`[test-setup] ignored inherited ${ignored.join(", ")} (values not printed)`);
  }

  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort: a leftover temp directory is not worth failing a run */
    }
  });
}
