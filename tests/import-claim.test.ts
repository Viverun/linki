import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-import-claim-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-import-claim-tests";

// processScheduledImports drives the real runBatch (it has no `deps` hook of
// its own), which otherwise dynamically imports the real scraper and tries to
// open a real browser session. Stub scrapeNavigatorUrl for the whole file so
// no real runBatch work is ever left running in the background after a test
// returns, and wire a fake browser context provider so withBrowserOwner
// resolves instantly.
const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { namedExports: Record<string, unknown> }) => void;
const realScraper = await import("@/lib/linkedin/scraper");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeScrape = async (_owner: any, _url: string, opts: any) => {
  await opts.onPage?.(1, []);
  return { profiles: [], lastPage: 1, knownTotal: 0, exhausted: true };
};
mockModule("@/lib/linkedin/scraper", { namedExports: { ...realScraper, scrapeNavigatorUrl: fakeScrape } });

const importJobs = await import("@/lib/import-jobs");
const lease = await import("@/lib/linkedin/lease");
const ownership = await import("@/lib/linkedin/ownership");
const { getDb } = await import("@/lib/db");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
ownership.setBrowserContextProvider(async () => ({} as any));

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
  const tokenA = importJobs.claimScheduledImport(db(), id, "A");
  assert.ok(tokenA, "first claim wins and returns a fence token");
  assert.match(tokenA!, /^A:[0-9a-f-]{36}$/);
  assert.equal(importJobs.claimScheduledImport(db(), id, "B"), null, "second claim loses");
  const r = row(id);
  assert.equal(r.owner, tokenA);
  assert.equal(r.status, "running");
  assert.ok(r.heartbeat_at);
});

test("C2 a cancelled scheduled row cannot be claimed", () => {
  const id = seedScheduledImport({ cancelRequested: 1 });
  assert.equal(importJobs.claimScheduledImport(db(), id, "A"), null);
  assert.equal(row(id).status, "scheduled");
});

test("C3 processScheduledImports starts nothing while the runner lease is not held (standby)", async () => {
  db().prepare("DELETE FROM app_settings WHERE key = 'runner_lease'").run();
  const id = seedScheduledImport();
  await importJobs.processScheduledImports(db());
  assert.equal(row(id).status, "scheduled");
});

test("C4 processScheduledImports skips an account that already has a running import, and claims one that has none (positive control)", async () => {
  lease.acquireRunnerLease(db());
  const accountId = seedAccount();
  const runningId = seedScheduledImport({ accountId });
  db().prepare("UPDATE list_imports SET status = 'running', owner = ? WHERE id = ?").run(lease.RUNNER_OWNER, runningId);
  const blockedId = seedScheduledImport({ accountId });
  await importJobs.processScheduledImports(db());
  assert.equal(row(blockedId).status, "scheduled", "blocked because its account already has a running import");

  // Positive control: an otherwise-identical due row on an account with no
  // running import IS claimed (status flips to running with an owner token
  // set synchronously, before runBatch's async work even starts).
  const freeId = seedScheduledImport();
  await importJobs.processScheduledImports(db());
  const claimed = row(freeId);
  assert.equal(claimed.status, "running");
  assert.ok(claimed.owner, "claimed row has a fence-token owner");
  // Let the backgrounded runBatch (stubbed scrape, no real network/browser
  // work) settle before the test returns — nothing should still be running
  // once the DB is closed in this file's `after` hook.
  await new Promise((r) => setTimeout(r, 50));
});
