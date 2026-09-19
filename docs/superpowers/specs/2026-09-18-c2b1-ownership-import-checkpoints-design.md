# C2-B1 — Worker ownership and truthful import checkpoints

Date: 2026-09-18. Phase: C2 (sub-project B1; last of C2).
Register: `docs/production-readiness.md` rows PR-09 (worker claims / browser ownership) and PR-06 (import recovery / false checkpoints). Authorized by the C2 sign-off.

## Goal

- Two processes (or two loops in one process) cannot both act as the runner; a
  process that lost ownership cannot write track state (PR-09).
- One LinkedIn account's browser is driven by at most one operation at a time —
  a runner step, an import scrape, an enrichment, a profile scrape — and a
  timeout ends the owned work rather than letting a replacement overlap it (PR-09).
- An import's durable checkpoint means "profiles through this page are inserted";
  a missing page never counts as progress or exhaustion; an interrupted import is
  recovered from its checkpoint or quarantined; cancellation leaves truthful counts
  (PR-06).

Non-goals: horizontal scaling (the app remains single-runner; this phase makes
that safe rather than optional), changing scrape pacing, changing the daily
import cap semantics beyond truthfulness.

## 1. Runner lease (`lib/linkedin/lease.ts`, new)

Storage: `app_settings` key `runner_lease`, value JSON `{ "owner": string, "expires_at": ISO }`.
`owner` = `${hostname}:${pid}:${8 random hex}` computed once per process (`RUNNER_OWNER`).

```ts
export const RUNNER_OWNER: string;
export const LEASE_TTL_MS = 600_000; // renewed on every fenced write and before each step; covers the worst single step
export function acquireRunnerLease(db, owner = RUNNER_OWNER, ttlMs = LEASE_TTL_MS): boolean;
export function readRunnerLease(db): { owner: string; expires_at: string } | null;
export function holdsRunnerLease(db, owner = RUNNER_OWNER): boolean;   // owner matches and not expired
export class LeaseLostError extends Error {}
export function withLease<T>(db, fn: () => T, owner = RUNNER_OWNER): T; // IMMEDIATE tx; throws LeaseLostError before fn if not held
export function releaseRunnerLease(db, owner = RUNNER_OWNER): void;    // only if owner matches
```

`acquireRunnerLease` is one `IMMEDIATE` transaction: read the row; if absent, expired
(`expires_at <= now`), or `owner === me`, write `{ owner: me, expires_at: now + ttl }`
and return true; otherwise return false. Time is `Date.now()` (ISO), comparable with
the stored string.

Loop integration (`lib/linkedin/runner.ts`):

- `runLoop`: at the top of every iteration, `acquireRunnerLease(db)`. On failure the
  loop is in **standby**: log once (`[runner] standby — lease held by <owner> until <t>`),
  write `runner_progress_phase = "standby"`, sleep `POLL_INTERVAL_MS`, retry. No tick,
  no imports, no inbox work while in standby. On success after standby, log `resumed`.
- `runnerWatchdogTick`: before reviving, if a fresh lease exists for another owner,
  do not revive (return false, log at most once per stale window).
- `trClaim` and the terminal verbs (`trAdvance`, `trWait`, `trReschedule`, `trSkip`,
  `trFail`) execute inside `withLease(db, …)`. A `LeaseLostError` propagates out of
  `executeStep` as a failed tick (logged, no write). The side-effect ledger (C2-A)
  still protects sends: intent rows are written before the act, inside `withLease`.
- Health: `GET /api/health` adds `runner.lease: { owner, mine: boolean, expires_in_s }`
  (reading only `app_settings`, keeping the endpoint dependency-free).
- Shutdown: `releaseRunnerLease` on `SIGTERM`/`SIGINT` (best-effort) so a restart does
  not wait out the TTL.

## 2. Browser ownership (`lib/linkedin/ownership.ts`, new)

```ts
export interface BrowserOwner {
  readonly accountId: string;
  readonly label: string;
  readonly signal: AbortSignal;                 // aborted on max-hold
  readonly context: BrowserContext;             // for helpers that take a context
  newPage(): Promise<Page>;                     // tracked page on that context
}
export class BrowserBusyError extends Error { constructor(accountId, heldBy: string) }
export async function withBrowserOwner<T>(accountId, label, opts: { maxHoldMs: number; waitMs?: number }, fn: (owner: BrowserOwner) => Promise<T>): Promise<T>;
export async function tryWithBrowserOwner<T>(accountId, label, opts: { maxHoldMs: number }, fn): Promise<{ ok: true; value: T } | { ok: false; heldBy: string }>;
export function browserOwnerState(accountId): { heldBy: string; since: string } | null;   // for logs/health
```

Semantics (per account, process-local — combined with §1 this is global):

- The slot claim is synchronous — reservation happens before any `await`, so two
  same-tick acquirers cannot both be admitted; the teardown gap is charged to the
  admitted waiter, whose gap timer is `ref`'d so it cannot drain the event loop.
- One holder at a time; waiters queue FIFO. `withBrowserOwner` waits up to `waitMs`
  (default: unbounded for imports, see §3; runner steps use `tryWithBrowserOwner`).
- `maxHoldMs` timer: on expiry the owner's `signal` aborts, then **every page of the
  account's context** is closed (`context.pages()`), which makes the holder's pending
  Playwright calls reject; the mutex is released only when `fn` settles. No overlap.
- On release, the existing `PAGE_TEARDOWN_GAP_MS` (3 s) is observed before the next
  holder proceeds (the B6 renderer-teardown reason survives).
- Dead-context handling stays in `getOrCreateContext` (B2): the owner obtains the
  context at acquisition time, so a recreated context is used by the next holder.

Call-site migration:

| Caller | Today | After |
| --- | --- | --- |
| `getSessionPage(accountId)` (runner ×6, sync-accepted, li-stats) | page queue with 120 s valve | acquires the owner (`label` from the caller, default "step", `maxHoldMs` 120 s); `page.close()` releases after the teardown gap. Signature unchanged. |
| runner `executeStep` browser steps | `getSessionPage` | unchanged API, but the step first calls `tryWithBrowserOwner`; on `{ ok: false, heldBy }` → `trReschedule(+5 min)` + log `browser owned by <heldBy> — rescheduling` and return. |
| runner Sales-Nav enrich (`ensureSalesNavEnriched`) | `getSessionContext` | `withBrowserOwner(id, "salesnav-enrich", { maxHoldMs: 180_000, waitMs: 0 })` — skipped when busy |
| `lib/import-jobs.ts` | `getSessionContext` + scraper opens pages | `withBrowserOwner(id, "import", { maxHoldMs: 3 * 3_600_000 })`, see §3 |
| `pages/api/lists/[id]/enrich.ts`, `sync-status.ts`, `targets/[id]/profile-scrape.ts` | `getSessionContext` | `withBrowserOwner(id, "<route>", { maxHoldMs: 600_000, waitMs: 30_000 })`; `BrowserBusyError` → HTTP 409 `{ error: "browser_busy", held_by }` |

`getSessionContext` remains exported for authentication/login flows (`authenticateAccount`
already serialises per account) but is no longer used to open work pages.

## 3. Import ownership, checkpoints and recovery (`lib/import-jobs.ts`, `lib/linkedin/scraper.ts`)

### Schema (`migrations[]`, tolerated duplicates)

```
ALTER TABLE list_imports ADD COLUMN owner TEXT
ALTER TABLE list_imports ADD COLUMN heartbeat_at TEXT
ALTER TABLE list_imports ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0
ALTER TABLE list_imports ADD COLUMN stall_reason TEXT
```

### Claim

`processScheduledImports` replaces the process-local `importRunning` flag with an
atomic claim: `UPDATE list_imports SET status='running', owner=?, heartbeat_at=now,
started_at=COALESCE(started_at, now) WHERE id=? AND status='scheduled' AND cancel_requested=0`;
proceed only when `changes === 1`. At most one `running` import per account at a
time (`SELECT 1 FROM list_imports WHERE account_id=? AND status='running'` → skip
this tick). The claim is inside `withLease` (§1) so a standby process never claims.

### Scraper contract

`scrapeNavigatorList`/`scrapeSavedSearch`/`scrapeNavigatorUrl` take an
`owner: BrowserOwner` instead of a `BrowserContext`, open their page via
`owner.newPage()`, check `owner.signal.aborted` and `isCanceled()` between pages, and
gain `onPage?: (pageNum: number, profiles: ScrapedProfile[]) => void` in `ScrapeOptions`,
called once per **verified** page (first page included) with that page's profiles.
Return value unchanged in shape, with one truthfulness change: `lastPage` is the last
*verified* page; a page whose intercept returned nothing after the retry ends the
window immediately with `stalled: { page, reason }` in the result and `exhausted: false`.
`exhausted` is true only when the verified `lastPage >= totalPages`.

### Per-page durability

`onPage` in `import-jobs` runs one `IMMEDIATE` transaction per page:
`insertProfiles(page's profiles)`; `UPDATE list_imports SET page = ?, imported = imported + ?,
skipped = skipped + ?, count = count + ?, total = ?, total_pages = ?, heartbeat_at = now,
phase = 'scraping' WHERE id = ? AND status = 'running' AND owner = ?` (owner-fenced; `changes === 0`
→ throw `ImportOwnershipLostError`, which aborts the scrape). `page` therefore means
"profiles through this page are inserted". `importedToday` keeps its query; `imported`
now grows per page instead of at the end, which is what makes the count truthful.

### Completion, continuation, stall, cancel

- Window done (`exhausted` or `maxPages` reached, no stall): one transaction sets
  `status='done', finished_at=now, owner=NULL` and, if not exhausted, inserts the
  next-day `scheduled` continuation with `start_page = lastPage + 1` — same statement
  group as today, now atomic.
- Stalled (missing page after retry): `status='done'` for this window with
  `stall_reason = "<reason> at page N"`, `exhausted=false`, and the continuation is
  scheduled from `lastPage + 1` (the missing page is retried next window, not skipped).
  If the stall happened on the **first** page of the window (nothing verified), the
  window is `status='error'` with the reason (as today's "No data intercepted" path)
  and no continuation.
- Cancelled (checked per page): `status='canceled', finished_at=now, owner=NULL`;
  `imported`/`page` already reflect what was durably inserted.
- Scrape error (throw): `status='error', error=<msg>, owner=NULL`; re-auth detection
  unchanged.

### Recovery (at loop start and once per hour inside the loop)

`recoverInterruptedImports(db)`: rows with `status='running'` whose `heartbeat_at` is
older than `IMPORT_STALE_MS = 600_000` (10 min; a page takes ≤ ~2.5 min):

- `recovery_count < 3` → `status='scheduled', scheduled_for=NULL, start_page = COALESCE(page, start_page - 1) + 1`
  (when `page` is NULL/0 nothing was verified → keep `start_page`),
  `recovery_count = recovery_count + 1`, `owner = NULL`, `error = "recovered after interrupted run (attempt N)"`.
- `recovery_count >= 3` → `status='error', owner=NULL, error = "quarantined after 3 interrupted runs — check the account session and retry manually"`.

Runs under `withLease` so only the active runner recovers. Because `page` is only
advanced after durable inserts, recovery from `page + 1` neither duplicates nor skips
profiles (`insertProfiles` also de-duplicates by URL, which stays as belt-and-braces).

## 4. Documentation

`docs/operations.md` "single-process precondition" section: state that the lease
now enforces it (second process = standby, visible in `/api/health`), and how to
clear a stuck lease (`DELETE FROM app_settings WHERE key='runner_lease'`, only when
the owner process is confirmed dead).

## 5. Tests (synthetic, temp DB, fake browser objects, no network)

| File | Proves |
| --- | --- |
| `tests/runner-lease.test.ts` | acquire/renew; second owner refused while fresh; expired lease handed over; `holdsRunnerLease`; `withLease` throws `LeaseLostError` for a stale owner and performs no write (counted); `releaseRunnerLease` only for the owner; `runnerWatchdogTick` does not revive under a fresh foreign lease and does revive under an expired one. |
| `tests/browser-ownership.test.ts` | fake context/page objects: second `withBrowserOwner` waits until the first releases (order recorded); `tryWithBrowserOwner` returns `{ ok: false, heldBy }` while held; `maxHoldMs` aborts `signal`, closes all context pages, and the next holder starts only after the first settled; `waitMs` expiry → `BrowserBusyError`; `getSessionPage` + `page.close()` releases after the gap (fake timers). |
| `tests/runner-step-busy-browser.test.ts` | runner `executeStep` on a connect step while an owner holds the account → `trReschedule` ≈ +5 min, no page opened, log line; when free → proceeds. |
| `tests/import-checkpoints.test.ts` | fake scraper via injected `scrape` function producing pages: per-page inserts and `page`/`imported` advance together; missing page → window ends, `page` unchanged, `stall_reason` set, continuation from `page+1`; simulated crash (throw between pages) then `recoverInterruptedImports` after a stale heartbeat → rescheduled from `page+1`, re-run inserts no duplicates and skips nothing; third recovery → quarantined `error`; cancel between pages → `canceled` with truthful `imported`; owner fence: an `onPage` for a row whose `owner` changed throws and inserts nothing. |
| `tests/import-claim.test.ts` | atomic claim: two claims for one row → one wins; a second `running` import for the same account is not started; standby (no lease) claims nothing. |
| `tests/health-lease.test.ts` | `/api/health` reports `runner.lease` from `app_settings` only. |

Existing suites that must keep passing unchanged: `tests/runner-watchdog.test.ts`,
`tests/runner-loop-survival.test.ts`, `tests/runner-connect-idempotence.test.ts`,
`tests/message-idempotency.test.ts`, `tests/email-idempotency.test.ts`,
`tests/health-isolation.test.ts`, `tests/host-allowlist.test.ts`, import/enrich suites.

## 6. Acceptance and evidence

C2-B1 is accepted when the six suites pass in the isolated Node 22 gate (lint
mandatory), host preflight passes, and `docs/production-readiness.md` moves PR-09 and
PR-06 to **Observed** with the boundaries: ownership verified with fake browser
objects and a single-process lease, not with two real Chromium stacks; recovery
verified on synthetic imports, not against live Sales Navigator.

## Deferred

C3 (lifecycle and truthful UI behaviour) and C4 (operational recovery, alerting,
test isolation, quality gates) remain unauthorized.
