import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-import-claim-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-import-claim-tests";

const importJobs = await import("@/lib/import-jobs");
const lease = await import("@/lib/linkedin/lease");
const { getDb } = await import("@/lib/db");

after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

const db = () => getDb();

let n = 0;
function seedList(): string {
  const id = `list-${++n}`;
  db().prepare("INSERT INTO lists (id, name) VALUES (?, ?)").run(id, `List ${n}`);
  return id;
}
function seedAccount(): string {
  const id = `acct-${++n}`;
  db().prepare("INSERT INTO accounts (id, name, email) VALUES (?, ?, ?)").run(id, `Acct ${n}`, `a${n}@example.com`);
  return id;
}
function seedScheduledImport(opts: { listId?: string; accountId?: string; cancelRequested?: number } = {}): string {
  const listId = opts.listId ?? seedList();
  const accountId = opts.accountId ?? seedAccount();
  const id = `imp-${++n}`;
  db().prepare(
    `INSERT INTO list_imports (id, list_id, account_id, sales_nav_url, status, start_page, batch_index, cancel_requested, started_at)
     VALUES (?, ?, ?, ?, 'scheduled', 1, 1, ?, datetime('now'))`
  ).run(id, listId, accountId, "https://www.linkedin.com/sales/lists/people/12345", opts.cancelRequested ?? 0);
  return id;
}
function row(id: string) {
  return db().prepare("SELECT * FROM list_imports WHERE id = ?").get(id) as {
    status: string; owner: string | null; heartbeat_at: string | null;
  };
}

test("C1 two claims for one scheduled row: exactly one wins", () => {
  const id = seedScheduledImport();
  assert.equal(importJobs.claimScheduledImport(db(), id, "A"), true);
  assert.equal(importJobs.claimScheduledImport(db(), id, "B"), false);
  const r = row(id);
  assert.equal(r.owner, "A");
  assert.equal(r.status, "running");
  assert.ok(r.heartbeat_at);
});

test("C2 a cancelled scheduled row cannot be claimed", () => {
  const id = seedScheduledImport({ cancelRequested: 1 });
  assert.equal(importJobs.claimScheduledImport(db(), id, "A"), false);
  assert.equal(row(id).status, "scheduled");
});

test("C3 processScheduledImports starts nothing while the runner lease is not held (standby)", async () => {
  db().prepare("DELETE FROM app_settings WHERE key = 'runner_lease'").run();
  const id = seedScheduledImport();
  await importJobs.processScheduledImports(db());
  assert.equal(row(id).status, "scheduled");
});

test("C4 processScheduledImports skips an account that already has a running import", async () => {
  lease.acquireRunnerLease(db());
  const accountId = seedAccount();
  const runningId = seedScheduledImport({ accountId });
  db().prepare("UPDATE list_imports SET status = 'running', owner = ? WHERE id = ?").run(lease.RUNNER_OWNER, runningId);
  const blockedId = seedScheduledImport({ accountId });
  await importJobs.processScheduledImports(db());
  assert.equal(row(blockedId).status, "scheduled", "blocked because its account already has a running import");
});
