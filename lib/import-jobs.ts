import type DatabaseType from "better-sqlite3";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { RUNNER_OWNER, holdsRunnerLease, withLease, LeaseLostError } from "@/lib/linkedin/lease";
import { withBrowserOwner, BrowserBusyError } from "@/lib/linkedin/ownership";
import type { scrapeNavigatorUrl } from "@/lib/linkedin/scraper";

type DB = DatabaseType.Database;

const PAGE_SIZE = 25;
export const DEFAULT_DAILY_CAP = 1500;

export interface ImportRow {
  id: string;
  list_id: string;
  account_id: string | null;
  sales_nav_url: string | null;
  status: string;
  phase: string | null;
  page: number;
  total_pages: number;
  count: number;
  total: number;
  imported: number;
  skipped: number;
  error: string | null;
  scheduled_for: string | null;
  start_page: number;
  cap: number | null;
  cancel_requested: number;
  batch_index: number;
  enrich: number;
  started_at: string;
  finished_at: string | null;
  owner: string | null;
  heartbeat_at: string | null;
  recovery_count: number;
  stall_reason: string | null;
}

// ─── settings ────────────────────────────────────────────────────────────────

export function getDailyImportCap(db: DB = getDb()): number {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'daily_import_cap'").get() as
    | { value: string }
    | undefined;
  const n = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

export function setDailyImportCap(db: DB, n: number): void {
  const v = String(Math.max(1, Math.floor(n)));
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('daily_import_cap', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(v);
}

// ─── quota ───────────────────────────────────────────────────────────────────

/**
 * Contacts imported across ALL lists today (the global daily budget).
 *
 * Ruling I-3 (C2-B1/PR-06 review): a still-`running` row counts regardless of
 * when it started — its `imported` counter only grows via durable, owner-fenced
 * per-page checkpoints, so it is always truthful budget already spent, even if
 * it started yesterday and is still going. A TERMINAL row (done/canceled/error)
 * counts by `finished_at`'s date — the day the budget was actually consumed.
 */
export function importedToday(db: DB): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(imported), 0) c FROM list_imports
       WHERE status = 'running' OR (status IN ('done', 'canceled', 'error') AND date(finished_at) = date('now'))`
    )
    .get() as { c: number };
  return row.c;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysStr(base: string, days: number): string {
  const d = new Date(base + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Queue an import for a list. Creates the first batch as 'scheduled' for today;
 * the runner's scheduler picks it up (one import at a time). Large lists are
 * split across days under the daily cap by runBatch chaining continuations.
 */
export function startImport(
  db: DB,
  opts: { listId: string; accountId: string; salesNavUrl: string; enrich?: boolean }
): { importId: string } {
  cancelImportsForList(db, opts.listId); // supersede any prior import for this list
  const importId = randomUUID();
  db.prepare(
    `INSERT INTO list_imports
       (id, list_id, account_id, sales_nav_url, status, scheduled_for, start_page, batch_index, enrich, started_at)
     VALUES (?, ?, ?, ?, 'scheduled', ?, 1, 1, ?, datetime('now'))`
  ).run(importId, opts.listId, opts.accountId, opts.salesNavUrl, todayStr(), opts.enrich ? 1 : 0);
  return { importId };
}

export function cancelImportsForList(db: DB, listId: string): void {
  db.prepare(
    `UPDATE list_imports
       SET cancel_requested = 1,
           status = CASE WHEN status = 'scheduled' THEN 'canceled' ELSE status END,
           finished_at = CASE WHEN status = 'scheduled' THEN datetime('now') ELSE finished_at END
     WHERE list_id = ? AND status IN ('scheduled', 'running')`
  ).run(listId);
}

export function cancelImport(db: DB, importId: string): void {
  db.prepare(
    `UPDATE list_imports
       SET cancel_requested = 1,
           status = CASE WHEN status = 'scheduled' THEN 'canceled' ELSE status END,
           finished_at = CASE WHEN status = 'scheduled' THEN datetime('now') ELSE finished_at END
     WHERE id = ?`
  ).run(importId);
}

// ─── scheduler + executor ────────────────────────────────────────────────────

/** A stale running row (no heartbeat inside this window) is presumed crashed. */
export const IMPORT_STALE_MS = 600_000;

/** Thrown by onPage when the row's owner has changed mid-scrape (another process claimed it). */
export class ImportOwnershipLostError extends Error {}

/**
 * Atomically claims a scheduled, non-cancelled row.
 *
 * Ruling I-4 (C2-B1/PR-06 review): `owner` alone is not a fine-enough fence —
 * two claims by the SAME process identity (e.g. a retried claim after a
 * transient error) must not be able to fence each other's writes as "still
 * mine". Every claim mints a fresh per-claim TOKEN (`<owner>:<uuid>`), writes
 * it to `owner`, and returns it; every fenced write in runBatch uses this
 * token, not the bare process identity. Returns null if the claim lost.
 */
export function claimScheduledImport(db: DB, importId: string, owner: string = RUNNER_OWNER): string | null {
  const token = `${owner}:${randomUUID()}`;
  const changes = db
    .prepare(
      `UPDATE list_imports SET status = 'running', owner = ?, heartbeat_at = datetime('now'), started_at = COALESCE(started_at, datetime('now'))
       WHERE id = ? AND status = 'scheduled' AND cancel_requested = 0`
    )
    .run(token, importId).changes;
  return changes === 1 ? token : null;
}

/** Runner hook (called each tick): start the next due batch if none is running. */
export async function processScheduledImports(db: DB): Promise<void> {
  if (!holdsRunnerLease(db)) return; // standby processes never claim
  const due = db
    .prepare(
      `SELECT * FROM list_imports
       WHERE status = 'scheduled' AND cancel_requested = 0
         AND (scheduled_for IS NULL OR scheduled_for <= date('now'))
         AND account_id NOT IN (SELECT account_id FROM list_imports WHERE status = 'running' AND account_id IS NOT NULL)
       ORDER BY scheduled_for ASC, batch_index ASC LIMIT 1`
    )
    .get() as ImportRow | undefined;
  if (!due) return;
  // Fenced claim (part 2 of ruling R17): holdsRunnerLease above is a fast
  // exit for the common case, but the lease can be lost between that check
  // and the claim write below — withLease re-checks atomically inside the
  // same transaction as the claim, so a process that just lost the lease can
  // never claim a row out from under the new owner.
  let token: string | null;
  try {
    token = withLease(db, () => claimScheduledImport(db, due.id));
  } catch (err) {
    if (err instanceof LeaseLostError) return;
    throw err;
  }
  if (!token) return;
  runBatch(due.id, { owner: token }).catch((e) => console.error("[import] batch crashed:", e));
}

export async function runBatch(
  importId: string,
  deps: { scrape?: typeof scrapeNavigatorUrl; owner?: string } = {}
): Promise<void> {
  const db = getDb();
  const scrape = deps.scrape ?? (await import("@/lib/linkedin/scraper")).scrapeNavigatorUrl;
  const owner = deps.owner ?? RUNNER_OWNER;
  const job = db.prepare("SELECT * FROM list_imports WHERE id = ?").get(importId) as ImportRow | undefined;
  if (!job || !job.account_id || !job.sales_nav_url) return;

  // List deleted out from under us?
  const list = db.prepare("SELECT id FROM lists WHERE id = ?").get(job.list_id);
  if (!list) {
    db.prepare("UPDATE list_imports SET status = 'canceled', finished_at = datetime('now'), owner = NULL WHERE id = ? AND owner = ? AND status = 'running'").run(importId, owner);
    return;
  }

  // Today's remaining budget → max whole pages this run
  const cap = getDailyImportCap(db);
  const remaining = cap - importedToday(db);
  const maxPages = Math.floor(remaining / PAGE_SIZE);
  if (maxPages < 1) {
    db.prepare("UPDATE list_imports SET status = 'scheduled', scheduled_for = ?, owner = NULL WHERE id = ? AND owner = ? AND status = 'running'").run(
      addDaysStr(todayStr(), 1),
      importId,
      owner
    );
    return;
  }

  console.log(`[import] batch ${importId} (b${job.batch_index}) start_page=${job.start_page} maxPages=${maxPages} cap=${cap}`);

  // page and count are owned exclusively by onPage's fenced checkpoint —
  // onProgress only ever reports phase/total_pages/total.
  const updateProgress = db.prepare(
    "UPDATE list_imports SET phase = ?, total_pages = ?, total = ? WHERE id = ? AND owner = ?"
  );
  const isCanceled = () => {
    const r = db.prepare("SELECT cancel_requested FROM list_imports WHERE id = ?").get(importId) as
      | { cancel_requested: number }
      | undefined;
    return !r || r.cancel_requested === 1; // row deleted (list cascade) or explicit cancel
  };
  const giveUpIfNotOwned = (r: { changes: number }): boolean => {
    if (r.changes === 0) {
      console.warn(`[import] import ${importId} no longer owned — leaving the row to its new owner`);
      return true;
    }
    return false;
  };

  // Every verified page is inserted and checkpointed together, inside one
  // owner-fenced transaction: if the row is no longer ours (owner changed —
  // another process reclaimed it after a perceived crash), the UPDATE matches
  // nothing and we throw, rolling back the insert too. No page is ever
  // recorded without the profiles that came with it, and nothing is inserted
  // for a row we no longer own.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onPage = (pageNum: number, pageProfiles: any[]) => {
    // withLease is itself an IMMEDIATE transaction fenced on the runner lease
    // — a process that lost the lease (e.g. a replacement took over after a
    // perceived crash) can no longer durably checkpoint this import, even if
    // it still (falsely) believes it owns the row. LeaseLostError propagates
    // like ImportOwnershipLostError below: the scraper's `finally` closes the
    // page, and runBatch's catch treats both the same way.
    withLease(db, () => {
      const { imported, skipped } = insertProfiles(db, job.list_id, pageProfiles);
      const r = db
        .prepare(
          `UPDATE list_imports SET page = ?, imported = imported + ?, skipped = skipped + ?, count = count + ?, heartbeat_at = datetime('now'), phase = 'scraping'
           WHERE id = ? AND status = 'running' AND owner = ?`
        )
        .run(pageNum, imported, skipped, pageProfiles.length, importId, owner);
      if (r.changes === 0) throw new ImportOwnershipLostError(`import ${importId} no longer owned`);
    });
  };

  try {
    const result = await withBrowserOwner(job.account_id, "import", { maxHoldMs: 3 * 3_600_000 }, async (bo) => {
      // Fenced heartbeat the moment we actually hold the browser — before the
      // (possibly long) scrape starts — so a slow queue wait never counts
      // against IMPORT_STALE_MS, and a lost fence is caught before any work.
      const hb = db
        .prepare(`UPDATE list_imports SET heartbeat_at = datetime('now') WHERE id = ? AND status = 'running' AND owner = ?`)
        .run(importId, owner);
      if (hb.changes === 0) throw new ImportOwnershipLostError(`import ${importId} no longer owned`);
      return scrape(bo, job.sales_nav_url!, {
        startPage: job.start_page,
        maxPages,
        onProgress: (p) => updateProgress.run(p.phase, p.totalPages ?? 0, p.total, importId, owner),
        isCanceled: () => isCanceled() || bo.signal.aborted,
        onPage,
      });
    });

    if (isCanceled()) {
      const r = db
        .prepare("UPDATE list_imports SET status = 'canceled', finished_at = datetime('now'), owner = NULL WHERE id = ? AND status = 'running' AND owner = ?")
        .run(importId, owner);
      giveUpIfNotOwned(r);
      return;
    }

    const { lastPage, knownTotal, exhausted, stalled } = result;

    // Stalled with nothing verified this window (the very first page failed) —
    // truthfully an error, not a done-with-zero-progress row. Unreachable with
    // the current scraper (it never returns `lastPage < startPage`); kept for
    // a scraper that reports a first-page miss as `stalled`.
    if (stalled && lastPage < job.start_page) {
      const r = db
        .prepare(
          "UPDATE list_imports SET status = 'error', error = ?, owner = NULL, finished_at = datetime('now') WHERE id = ? AND status = 'running' AND owner = ?"
        )
        .run(stalled.reason, importId, owner);
      if (giveUpIfNotOwned(r)) return;
      if (/re-authentication|No data intercepted/i.test(stalled.reason) && job.account_id) {
        try {
          const { markNeedsReauth } = await import("@/lib/linkedin/session");
          await markNeedsReauth(job.account_id);
        } catch { /* ignore */ }
      }
      return;
    }

    db.transaction(() => {
      const r = db
        .prepare(
          `UPDATE list_imports SET status = 'done', total = ?, total_pages = ?, finished_at = datetime('now'), owner = NULL, error = NULL, stall_reason = ?
           WHERE id = ? AND status = 'running' AND owner = ?`
        )
        .run(
          knownTotal,
          Math.ceil(knownTotal / PAGE_SIZE),
          stalled ? `${stalled.reason} at page ${stalled.page}` : null,
          importId,
          owner
        );
      if (r.changes === 0) throw new ImportOwnershipLostError(`import ${importId} no longer owned`);

      // More of the list left → chain the remainder to the next day
      if (!exhausted) {
        db.prepare(
          `INSERT INTO list_imports
             (id, list_id, account_id, sales_nav_url, status, scheduled_for, start_page, batch_index, enrich, total, total_pages, started_at)
           VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(
          randomUUID(),
          job.list_id,
          job.account_id,
          job.sales_nav_url,
          addDaysStr(todayStr(), 1),
          lastPage + 1,
          job.batch_index + 1,
          job.enrich,
          knownTotal,
          Math.ceil(knownTotal / PAGE_SIZE)
        );
      }
    }).immediate();
    console.log(`[import] batch ${importId} done (lastPage=${lastPage}, exhausted=${exhausted})`);
  } catch (err) {
    if (err instanceof ImportOwnershipLostError || err instanceof LeaseLostError) {
      console.warn(`[import] ${err.message} — leaving the row to its new owner`);
      return;
    }
    if (err instanceof BrowserBusyError) {
      const r = db
        .prepare("UPDATE list_imports SET status = 'scheduled', owner = NULL, error = ? WHERE id = ? AND status = 'running' AND owner = ?")
        .run("browser busy — will retry", importId, owner);
      giveUpIfNotOwned(r);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[import] FAILED:", message);
    if (db.prepare("SELECT id FROM list_imports WHERE id = ?").get(importId)) {
      const r = db
        .prepare("UPDATE list_imports SET status = 'error', error = ?, owner = NULL, finished_at = datetime('now') WHERE id = ? AND status = 'running' AND owner = ?")
        .run(message, importId, owner);
      if (giveUpIfNotOwned(r)) return;
    }
    // A "no data intercepted / re-authentication" failure means the session died.
    if (/re-authentication|No data intercepted/i.test(message) && job.account_id) {
      try {
        const { markNeedsReauth } = await import("@/lib/linkedin/session");
        await markNeedsReauth(job.account_id);
      } catch { /* ignore */ }
    }
  }
}

/**
 * Reschedules imports whose runner died mid-batch (running with a heartbeat
 * older than IMPORT_STALE_MS) so they resume from the first unverified page —
 * never re-fetching a page whose profiles are already durably checkpointed.
 * Quarantines (fails closed, no further auto-retry) after 3 interrupted runs.
 */
export function recoverInterruptedImports(db: DB, now: number = Date.now()): { recovered: string[]; quarantined: string[] } {
  const cutoff = new Date(now - IMPORT_STALE_MS).toISOString().slice(0, 19).replace("T", " ");
  return withLease(db, () => {
    const stale = db
      .prepare(
        `SELECT id, page, start_page, recovery_count, total, cancel_requested
         FROM list_imports WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`
      )
      .all(cutoff) as Array<{
        id: string; page: number | null; start_page: number; recovery_count: number;
        total: number | null; cancel_requested: number;
      }>;
    const recovered: string[] = [];
    const quarantined: string[] = [];
    for (const r of stale) {
      // Ruling I-5: a stale row already flagged for cancellation is truthfully
      // canceled, not rescheduled — nobody is coming back to finish it.
      if (r.cancel_requested) {
        db.prepare(`UPDATE list_imports SET status = 'canceled', finished_at = datetime('now'), owner = NULL WHERE id = ?`).run(r.id);
        recovered.push(r.id);
        continue;
      }
      // Ruling I-2: the crash happened between the last onPage checkpoint and
      // the final 'done' write — every page of this window is already
      // durably verified, so finish it truthfully instead of rescheduling a
      // window with nothing left to fetch.
      const totalPages = r.total && r.total > 0 ? Math.ceil(r.total / PAGE_SIZE) : 0;
      if (totalPages > 0 && r.page !== null && r.page >= totalPages) {
        db.prepare(`UPDATE list_imports SET status = 'done', finished_at = datetime('now'), owner = NULL, error = NULL WHERE id = ?`).run(r.id);
        recovered.push(r.id);
        continue;
      }
      if (r.recovery_count >= 2) {
        db.prepare(
          `UPDATE list_imports SET status = 'error', owner = NULL, finished_at = datetime('now'), recovery_count = recovery_count + 1,
           error = 'quarantined after 3 interrupted runs — check the account session and retry manually' WHERE id = ?`
        ).run(r.id);
        quarantined.push(r.id);
      } else {
        const resumeFrom = r.page && r.page >= r.start_page ? r.page + 1 : r.start_page;
        db.prepare(
          `UPDATE list_imports SET status = 'scheduled', scheduled_for = NULL, owner = NULL, start_page = ?, recovery_count = recovery_count + 1,
           error = 'recovered after interrupted run (attempt ' || (recovery_count + 1) || ')' WHERE id = ?`
        ).run(resumeFrom, r.id);
        recovered.push(r.id);
      }
    }
    return { recovered, quarantined };
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insertProfiles(db: DB, listId: string, profiles: any[]): { imported: number; skipped: number } {
  const insertTarget = db.prepare(
    `INSERT INTO targets (
       id, linkedin_url, sales_nav_url, first_name, last_name, full_name,
       title, company, location, degree,
       object_urn, summary, open_link, company_industry, company_location,
       tenure_months, spotlight_badges
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(linkedin_url) DO UPDATE SET
       sales_nav_url = excluded.sales_nav_url,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       full_name = excluded.full_name,
       title = excluded.title,
       company = excluded.company,
       location = excluded.location,
       degree = excluded.degree,
       object_urn = excluded.object_urn,
       summary = excluded.summary,
       open_link = excluded.open_link,
       company_industry = excluded.company_industry,
       company_location = excluded.company_location,
       tenure_months = excluded.tenure_months,
       spotlight_badges = excluded.spotlight_badges`
  );
  const insertLink = db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)");
  const findTarget = db.prepare("SELECT id FROM targets WHERE linkedin_url = ?");

  let imported = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const p of profiles) {
      const url = p.linkedinUrl ?? p.salesNavUrl;
      insertTarget.run(
        randomUUID(), url, p.salesNavUrl,
        p.firstName, p.lastName, p.fullName,
        p.title, p.company, p.location, p.degree,
        p.objectUrn, p.summary, p.openLink ? 1 : 0,
        p.companyIndustry, p.companyLocation,
        p.tenureMonths, p.spotlightBadges
      );
      const target = findTarget.get(url) as { id: string };
      const result = insertLink.run(listId, target.id);
      if (result.changes > 0) imported++;
      else skipped++;
    }
  })();
  return { imported, skipped };
}
