import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-import-checkpoints-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-import-checkpoints-tests";

const importJobs = await import("@/lib/import-jobs");
const lease = await import("@/lib/linkedin/lease");
const ownership = await import("@/lib/linkedin/ownership");
const { getDb } = await import("@/lib/db");

after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

const db = () => getDb();

// A fake browser context — never touched by these fakes since onPage is called
// directly and the fakes never call owner.newPage().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
ownership.setBrowserContextProvider(async () => ({} as any));

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
function seedRunningImport(opts: { listId?: string; accountId?: string; owner?: string; startPage?: number; heartbeatAt?: string; recoveryCount?: number } = {}) {
  const listId = opts.listId ?? seedList();
  const accountId = opts.accountId ?? seedAccount();
  const id = `imp-${++n}`;
  db().prepare(
    `INSERT INTO list_imports
       (id, list_id, account_id, sales_nav_url, status, owner, start_page, page, batch_index, cancel_requested, recovery_count, heartbeat_at, started_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, 0, 1, 0, ?, ?, datetime('now'))`
  ).run(
    id, listId, accountId, "https://www.linkedin.com/sales/lists/people/12345",
    opts.owner ?? lease.RUNNER_OWNER, opts.startPage ?? 1, opts.recoveryCount ?? 0, opts.heartbeatAt ?? null
  );
  return { id, listId, accountId };
}
function row(id: string) {
  return db().prepare("SELECT * FROM list_imports WHERE id = ?").get(id) as {
    status: string; owner: string | null; page: number; imported: number; skipped: number;
    stall_reason: string | null; recovery_count: number; error: string | null; cancel_requested: number;
    total: number;
  };
}
function listTargetCount(listId: string): number {
  return (db().prepare("SELECT COUNT(*) c FROM list_targets WHERE list_id = ?").get(listId) as { c: number }).c;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeProfiles(pageNum: number, count = 25, suffix = ""): any[] {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      linkedinUrl: `https://www.linkedin.com/in/p-${suffix}${pageNum}-${i}/`,
      salesNavUrl: `https://www.linkedin.com/sales/lead/p-${suffix}${pageNum}-${i}`,
      firstName: "First",
      lastName: `Last${pageNum}${i}`,
      fullName: `First Last${pageNum}${i}`,
      title: "Engineer",
      company: "Acme",
      location: "Remote",
      degree: "2nd",
      objectUrn: `urn:li:member:${pageNum}${i}`,
      summary: "",
      openLink: false,
      companyIndustry: "Software",
      companyLocation: "Remote",
      tenureMonths: 12,
      spotlightBadges: null,
    });
  }
  return out;
}

const T0 = Date.parse("2026-09-18T10:00:00Z");

test("I1 each verified page is inserted and checkpointed together", async () => {
  lease.acquireRunnerLease(db());
  const { id, listId } = seedRunningImport();
  let sawMidState: { page: number; imported: number } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrape = async (owner: any, url: string, opts: any) => {
    await opts.onPage(1, makeProfiles(1));
    await opts.onPage(2, makeProfiles(2));
    sawMidState = { page: row(id).page, imported: row(id).imported };
    await opts.onPage(3, makeProfiles(3));
    return { profiles: [], lastPage: 3, knownTotal: 75, exhausted: true };
  };
  await importJobs.runBatch(id, { scrape });
  assert.deepEqual(sawMidState, { page: 2, imported: 50 });
  const r = row(id);
  assert.equal(r.status, "done");
  assert.equal(r.page, 3);
  assert.equal(r.imported, 75);
  assert.equal(listTargetCount(listId), 75);
  const continuation = db().prepare("SELECT id FROM list_imports WHERE list_id = ? AND id != ?").get(listId, id);
  assert.equal(continuation, undefined, "exhausted — no continuation row");
});

test("I2 a missing page ends the window without advancing; continuation from page+1", async () => {
  lease.acquireRunnerLease(db());
  const { id, listId } = seedRunningImport();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrape = async (owner: any, url: string, opts: any) => {
    await opts.onPage(1, makeProfiles(1));
    return { profiles: [], lastPage: 1, knownTotal: 75, exhausted: false, stalled: { page: 2, reason: "no data intercepted after retry" } };
  };
  await importJobs.runBatch(id, { scrape });
  const r = row(id);
  assert.equal(r.page, 1);
  assert.equal(r.stall_reason, "no data intercepted after retry at page 2");
  assert.equal(r.status, "done");
  const cont = db().prepare("SELECT start_page FROM list_imports WHERE list_id = ? AND id != ?").get(listId, id) as { start_page: number } | undefined;
  assert.ok(cont, "continuation row scheduled");
  assert.equal(cont!.start_page, 2);
});

test("I3 a crash between pages leaves a stale running row; recovery reschedules from page+1 without duplicates", async () => {
  lease.acquireRunnerLease(db());
  const { id, listId } = seedRunningImport({ heartbeatAt: "2020-01-01 00:00:00" });
  // Simulate that page 1 had already been durably checkpointed before the crash.
  db().transaction(() => {
    // Reuse the same insert path a real onPage would have used, via runBatch's
    // internal helper is not exported — insert directly against targets/list_targets
    // the same way insertProfiles does, keyed on linkedin_url.
    const profiles = makeProfiles(1);
    for (const p of profiles) {
      const targetId = `t-${p.linkedinUrl}`;
      db().prepare(
        `INSERT INTO targets (id, linkedin_url, full_name) VALUES (?, ?, ?)
         ON CONFLICT(linkedin_url) DO NOTHING`
      ).run(targetId, p.linkedinUrl, p.fullName);
      const t = db().prepare("SELECT id FROM targets WHERE linkedin_url = ?").get(p.linkedinUrl) as { id: string };
      db().prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)").run(listId, t.id);
    }
    db().prepare("UPDATE list_imports SET page = 1, imported = 25, count = 25 WHERE id = ?").run(id);
  }).immediate();

  const result = importJobs.recoverInterruptedImports(db(), T0);
  assert.deepEqual(result.recovered, [id]);
  assert.deepEqual(result.quarantined, []);
  const recovered = db().prepare("SELECT status, start_page, recovery_count, owner FROM list_imports WHERE id = ?").get(id) as
    { status: string; start_page: number; recovery_count: number; owner: string | null };
  assert.equal(recovered.status, "scheduled");
  assert.equal(recovered.start_page, 2);
  assert.equal(recovered.recovery_count, 1);
  assert.equal(recovered.owner, null);

  const token = importJobs.claimScheduledImport(db(), id);
  assert.ok(token, "reschedule is claimable again");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrape = async (owner: any, url: string, opts: any) => {
    assert.equal(opts.startPage, 2, "resumes from page+1, never re-fetching the durably checkpointed page 1");
    await opts.onPage(2, makeProfiles(2));
    await opts.onPage(3, makeProfiles(3));
    return { profiles: [], lastPage: 3, knownTotal: 75, exhausted: true };
  };
  await importJobs.runBatch(id, { scrape, owner: token! });
  const r = row(id);
  assert.equal(r.status, "done");
  assert.equal(r.page, 3);
  assert.equal(r.imported, 75, "25 from the crash-simulated page 1 + 25 + 25 from the re-run");
  assert.equal(r.skipped, 0);
  assert.equal(listTargetCount(listId), 75, "no duplicate insert of page 1");
});

test("I4 third recovery quarantines", () => {
  lease.acquireRunnerLease(db());
  const { id } = seedRunningImport({ heartbeatAt: "2020-01-01 00:00:00", recoveryCount: 2 });
  const result = importJobs.recoverInterruptedImports(db(), T0);
  assert.deepEqual(result.recovered, []);
  assert.deepEqual(result.quarantined, [id]);
  const r = row(id);
  assert.equal(r.status, "error");
  assert.match(r.error ?? "", /quarantined/);
});

test("I5 cancel between pages: status canceled, imported reflects durable inserts", async () => {
  lease.acquireRunnerLease(db());
  const { id, listId } = seedRunningImport();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrape = async (owner: any, url: string, opts: any) => {
    await opts.onPage(1, makeProfiles(1));
    db().prepare("UPDATE list_imports SET cancel_requested = 1 WHERE id = ?").run(id);
    return { profiles: [], lastPage: 1, knownTotal: 75, exhausted: false };
  };
  await importJobs.runBatch(id, { scrape });
  const r = row(id);
  assert.equal(r.status, "canceled");
  assert.equal(r.imported, 25);
  assert.equal(listTargetCount(listId), 25);
});

test("I6 owner fence: an onPage for a row whose owner changed inserts nothing and aborts", async () => {
  lease.acquireRunnerLease(db());
  const { id, listId } = seedRunningImport({ owner: "me" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrape = async (owner: any, url: string, opts: any) => {
    db().prepare("UPDATE list_imports SET owner = 'someone-else' WHERE id = ?").run(id);
    await opts.onPage(1, makeProfiles(1, 25, "i6")); // must throw ImportOwnershipLostError
    return { profiles: [], lastPage: 1, knownTotal: 75, exhausted: true };
  };
  await importJobs.runBatch(id, { scrape, owner: "me" });
  assert.equal(listTargetCount(listId), 0, "onPage's insert must have rolled back with the failed fenced update");
  const r = row(id);
  assert.equal(r.owner, "someone-else", "runBatch must not touch a row it no longer owns");
  assert.equal(r.status, "running");
});

test("I7 owner fence at the terminal write: ownership lost right after the last onPage leaves the row untouched", async () => {
  lease.acquireRunnerLease(db());
  const { id, listId } = seedRunningImport({ owner: "me" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrape = async (owner: any, url: string, opts: any) => {
    await opts.onPage(1, makeProfiles(1, 25, "i7"));
    // Ownership changes AFTER the last durable checkpoint but BEFORE the
    // terminal 'done' write — the row is still (falsely, from this run's
    // point of view) 'running'.
    db().prepare("UPDATE list_imports SET owner = 'someone-else' WHERE id = ?").run(id);
    return { profiles: [], lastPage: 1, knownTotal: 75, exhausted: true };
  };
  await importJobs.runBatch(id, { scrape, owner: "me" });
  const r = row(id);
  assert.equal(r.status, "running", "the done write must not have landed");
  assert.equal(r.owner, "someone-else");
  assert.equal(listTargetCount(listId), 25, "the durable page-1 checkpoint made before the ownership change stands");
  const continuation = db().prepare("SELECT id FROM list_imports WHERE list_id = ? AND id != ?").get(listId, id);
  assert.equal(continuation, undefined, "no continuation row inserted for a done write that never landed");
});

test("I8 recovery finishes a stale row whose window was already fully checkpointed (crash between last onPage and done)", () => {
  lease.acquireRunnerLease(db());
  const { id } = seedRunningImport({ heartbeatAt: "2020-01-01 00:00:00" });
  // 75 total → ceil(75/25) = 3 pages; page 3 (the last) is already durably checkpointed.
  db().prepare("UPDATE list_imports SET page = 3, imported = 75, total = 75 WHERE id = ?").run(id);
  const result = importJobs.recoverInterruptedImports(db(), T0);
  assert.deepEqual(result.recovered, [id]);
  assert.deepEqual(result.quarantined, []);
  const r = row(id);
  assert.equal(r.status, "done");
  assert.equal(r.owner, null);
  assert.equal(r.error, null);
});

test("I10 a process that lost the runner lease cannot checkpoint a second page (Critical part 2)", async () => {
  lease.acquireRunnerLease(db()); // we hold it as lease.RUNNER_OWNER when page 1 checkpoints
  const { id, listId } = seedRunningImport();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrape = async (owner: any, url: string, opts: any) => {
    await opts.onPage(1, makeProfiles(1, 25, "i10"));
    // Another process now holds the lease — ours is no longer valid, so the
    // owner-token predicate on the row would still (falsely) pass but the
    // lease fence must not. Written directly (acquireRunnerLease's fairness
    // check would refuse to steal a lease that is still fresh for us).
    db().prepare(
      `UPDATE app_settings SET value = ? WHERE key = ?`
    ).run(JSON.stringify({ owner: "other-process", expires_at: new Date(Date.now() + 600_000).toISOString() }), lease.LEASE_KEY);
    await opts.onPage(2, makeProfiles(2, 25, "i10")); // throws LeaseLostError — never reached below
    return { profiles: [], lastPage: 2, knownTotal: 75, exhausted: false };
  };
  await importJobs.runBatch(id, { scrape });
  const r = row(id);
  assert.equal(r.page, 1, "page 2's checkpoint never landed");
  assert.equal(r.imported, 25, "only page 1's profiles are durably counted");
  assert.equal(listTargetCount(listId), 25, "no second-page profiles inserted");
  assert.equal(r.status, "running", "recovery's job, not runBatch's — the row is left running for the new owner");
  // Hand the lease back to us for the tests that follow (acquireRunnerLease's
  // fairness check would otherwise refuse to steal it back from "other-process").
  db().prepare(`DELETE FROM app_settings WHERE key = ?`).run(lease.LEASE_KEY);
  lease.acquireRunnerLease(db());
});

test("I9 recovery cancels a stale row that was already flagged for cancellation, instead of rescheduling it", () => {
  lease.acquireRunnerLease(db());
  const { id } = seedRunningImport({ heartbeatAt: "2020-01-01 00:00:00" });
  db().prepare("UPDATE list_imports SET cancel_requested = 1 WHERE id = ?").run(id);
  const result = importJobs.recoverInterruptedImports(db(), T0);
  assert.deepEqual(result.recovered, [id]);
  assert.deepEqual(result.quarantined, []);
  const r = row(id);
  assert.equal(r.status, "canceled");
  assert.equal(r.owner, null);
});
