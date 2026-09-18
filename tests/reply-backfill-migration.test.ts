import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";

// One temp DB per PROCESS: lib/db.ts caches the connection on first getDb().
// Each boot that needs to observe a fresh migration pass runs in a child process
// (mirrors tests/migrations-fail-closed.test.ts).

const dir = mkdtempSync(join(tmpdir(), "linki-reply-backfill-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Runs `script` (ESM source) in a fresh Node process against `dbPath`; returns stdout or throws with stderr. */
function child(dbPath: string, script: string): string {
  return execFileSync(process.execPath, [
    "--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning",
    "--import", "./scripts/test-setup.mjs", "--input-type=module", "-e", script,
  ], { env: { ...process.env, LINKI_DB_PATH: dbPath, NEXTAUTH_SECRET: "x" }, encoding: "utf8", stdio: "pipe", timeout: 30_000 });
}

const OPEN_ONLY = `
  const { getDb } = await import("@/lib/db");
  getDb();
  console.log(JSON.stringify({ ok: true }));
`;

test("legacy undecided reply is backfilled to decided (dispatched_at + migration JSON) on the boot that first sees it", () => {
  const dbPath = join(dir, "legacy.db");
  // Boot 1: builds the current schema (app_settings, email_replies, the backfill marker).
  child(dbPath, OPEN_ONLY);

  // Simulate a reply captured before C2-B2 existed: undecided, and the marker absent
  // (as if this row predates the migration that inserts it).
  const raw = new Database(dbPath);
  const targetId = randomUUID();
  const replyId = randomUUID();
  raw.exec("INSERT INTO targets (id, full_name) VALUES ('" + targetId + "', 'Legacy Lead')");
  raw.prepare(
    "INSERT INTO email_replies (id, target_id, from_email, subject, body_text, received_at, dispatched_at, dispatch_result_json, created_at) VALUES (?, ?, 'lead@fixture.test', 'Re: hi', 'no thanks', '2025-01-01T00:00:00.000Z', NULL, NULL, '2025-01-01T00:00:00.000Z')"
  ).run(replyId, targetId);
  raw.prepare("DELETE FROM app_settings WHERE key = 'c2b2_reply_backfill_done'").run();
  raw.close();

  // Boot 2: the migration runs, sees no marker, backfills this row, then inserts the marker.
  child(dbPath, OPEN_ONLY);

  const check1 = new Database(dbPath);
  const row1 = check1.prepare("SELECT dispatched_at, dispatch_result_json, created_at FROM email_replies WHERE id = ?").get(replyId) as
    { dispatched_at: string | null; dispatch_result_json: string | null; created_at: string };
  assert.equal(row1.dispatched_at, row1.created_at, "backfilled dispatched_at takes the row's created_at");
  assert.ok(row1.dispatch_result_json);
  const parsed1 = JSON.parse(row1.dispatch_result_json!);
  assert.equal(parsed1.source, "migration");
  assert.equal(parsed1.decision, "operator_continue");
  assert.match(parsed1.reason, /C2-B2/);
  const marker1 = check1.prepare("SELECT value FROM app_settings WHERE key = 'c2b2_reply_backfill_done'").get();
  assert.ok(marker1, "marker inserted after the backfill runs");

  // Insert a SECOND undecided reply now that the marker is present — this represents
  // a genuine C2-B2-era hold, which must NOT be swept up by the (already-run) migration.
  const targetId2 = randomUUID();
  const replyId2 = randomUUID();
  check1.exec("INSERT INTO targets (id, full_name) VALUES ('" + targetId2 + "', 'Current Lead')");
  check1.prepare(
    "INSERT INTO email_replies (id, target_id, from_email, subject, body_text, received_at, dispatched_at, dispatch_result_json, created_at) VALUES (?, ?, 'lead2@fixture.test', 'Re: hi', 'no thanks', datetime('now'), NULL, NULL, datetime('now'))"
  ).run(replyId2, targetId2);
  check1.close();

  // Boot 3: marker already present → migration is a no-op, the new undecided row stays undecided.
  child(dbPath, OPEN_ONLY);

  const check2 = new Database(dbPath);
  const row2 = check2.prepare("SELECT dispatched_at, dispatch_result_json FROM email_replies WHERE id = ?").get(replyId2) as
    { dispatched_at: string | null; dispatch_result_json: string | null };
  assert.equal(row2.dispatched_at, null, "a reply captured after the marker exists stays undecided — a genuine C2-B2 hold");
  assert.equal(row2.dispatch_result_json, null);
  check2.close();
});
