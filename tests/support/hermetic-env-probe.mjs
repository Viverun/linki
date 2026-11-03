/**
 * Probe for PR-16's environment isolation, driven by
 * `tests/test-env-isolation.test.ts`.
 *
 * Not a `.test.ts` file, so the runner's glob ignores it. It runs under
 * `scripts/test-setup.mjs` with whatever environment the parent hands it, and
 * reports what the app code would actually see and do:
 *
 *   node --import ./scripts/test-setup.mjs tests/support/hermetic-env-probe.mjs env
 *   node --import ./scripts/test-setup.mjs tests/support/hermetic-env-probe.mjs backup
 *
 * `backup` calls the REAL createBackup with only a source path — no destDir and
 * no offsiteDir — which is exactly the call that wrote a snapshot into an
 * inherited BACKUP_OFFSITE_DIR before the bootstrap sanitised the environment.
 */
import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { createBackup } from "../../scripts/backup.mjs";

const mode = process.argv[2] ?? "env";

const report = {
  mode,
  scope: process.env.LINKI_TEST_ENV_SCOPE ?? null,
  env: {
    LINKI_DB_PATH: process.env.LINKI_DB_PATH ?? null,
    BACKUP_DIR: process.env.BACKUP_DIR ?? null,
    BACKUP_OFFSITE_DIR: process.env.BACKUP_OFFSITE_DIR ?? null,
    BACKUP_RETAIN: process.env.BACKUP_RETAIN ?? null,
    ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL ?? null,
  },
  snapshot: null,
};

if (mode === "backup") {
  // Beside the backup directory so the fixture stays inside whatever temp root
  // the bootstrap chose. The point of the test is that this is NOT the
  // inherited path.
  const sourcePath = join(dirname(process.env.BACKUP_DIR ?? "."), "probe-source.db");
  const db = new Database(sourcePath);
  db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY); INSERT INTO accounts (id) VALUES ('a1');");
  db.close();

  // No destDir, no offsiteDir: the code's own defaults and environment.
  report.snapshot = createBackup({ sourcePath });
}

process.stdout.write(`PROBE ${JSON.stringify(report)}\n`);
