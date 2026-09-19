# C2-B1 Ownership and Import Checkpoints — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A DB-backed runner lease with fenced writes, a per-account browser owner that every browser consumer goes through, and import checkpoints that only advance on durably inserted pages with recovery/quarantine — register rows PR-09 and PR-06.

**Architecture:** `lib/linkedin/lease.ts` (pure, `app_settings`-backed) gates the loop, the watchdog and the track-write verbs. `lib/linkedin/ownership.ts` is a per-account async mutex whose max-hold aborts and force-closes the holder's pages; `getSessionPage` and the five context-bypass callers sit on it. `lib/import-jobs.ts` claims rows atomically, inserts per page inside an owner-fenced transaction via the scraper's new `onPage`, and recovers stale `running` rows from `page + 1`.

**Tech Stack:** Next.js 16 Pages Router, better-sqlite3 12, Playwright 1.58 (`BrowserContext`/`Page` types only in tests — fakes), Node 22 `node:test` with module mocks.

**Spec:** `docs/superpowers/specs/2026-09-18-c2b1-ownership-import-checkpoints-design.md`

## Global Constraints

- Gate: Node 22.23.0 isolated Docker (`npm run verify:c0`, lint mandatory); host preflight via `bash -lc` (nvm Node 24). Plain `node` outside `bash -lc` is broken.
- `node:test`, temp DB via `LINKI_DB_PATH`, no network, no real browser — fake context/page objects. Harness style: `tests/runner-watchdog.test.ts`, `tests/message-idempotency.test.ts`.
- Commit hook runs tsc + full suite + eslint; `--no-verify` banned; commit via `bash -lc 'git commit …'`. Push only to `origin`.
- Lease: `app_settings` key `runner_lease` = `{ "owner", "expires_at" }`; `LEASE_TTL_MS = 120_000`; `RUNNER_OWNER = "<hostname>:<pid>:<8 hex>"`; `withLease` throws `LeaseLostError` **before** running `fn` when the lease is not held.
- Ownership: one holder per account; `maxHoldMs` expiry → `signal.abort()` then close **all** `context.pages()`; release only after `fn` settles; `PAGE_TEARDOWN_GAP_MS = 3000` before the next holder. Max holds: step 120 s, salesnav-enrich 180 s, routes 600 s (wait 30 s), import 3 h.
- Runner step on a busy owner → `trReschedule(+5 min)` + log `browser owned by <heldBy> — rescheduling`.
- Import: claim `WHERE id=? AND status='scheduled' AND cancel_requested=0` (`changes===1`); at most one `running` per account; per-page transaction is owner-fenced (`… AND status='running' AND owner=?`, `changes===0` → `ImportOwnershipLostError`); `page` = last durably inserted page; stall never advances `page`; `IMPORT_STALE_MS = 600_000`; recovery `< 3` → rescheduled from `page+1`, `>= 3` → `error` quarantined.
- New columns: `list_imports.owner TEXT`, `heartbeat_at TEXT`, `recovery_count INTEGER NOT NULL DEFAULT 0`, `stall_reason TEXT` (appended to `migrations[]`).
- `/api/health` stays free of runner/session imports; it may import `lib/linkedin/lease.ts` (node built-ins only).

`RUN_ONE <files…>` = `bash -lc 'NODE_ENV=test node --experimental-strip-types --experimental-test-module-mocks --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --disable-warning=ExperimentalWarning --import ./scripts/test-setup.mjs --test <files…>'`

---

## File map

| File | Responsibility |
| --- | --- |
| `lib/linkedin/lease.ts` (new) | lease acquire/read/hold/withLease/release (Task 1) |
| `lib/linkedin/runner.ts` | standby loop, watchdog lease check, fenced verbs, busy-browser reschedule, salesnav-enrich owner, recovery calls (Tasks 2, 4, 6) |
| `pages/api/health.ts` | `runner.lease` field (Task 2) |
| `lib/linkedin/ownership.ts` (new) | per-account browser owner (Task 3) |
| `lib/linkedin/session.ts` | `getSessionPage` on the owner (Task 4) |
| `pages/api/lists/[id]/{enrich,sync-status}.ts`, `pages/api/targets/[id]/profile-scrape.ts` | owner wrap + 409 (Task 4) |
| `lib/linkedin/scraper.ts` | owner + `onPage` + stall result (Task 5) |
| `lib/import-jobs.ts`, `lib/db.ts` | claim, per-page durability, completion/stall/cancel, recovery, columns (Task 6) |
| `docs/operations.md`, `docs/production-readiness.md` | precondition enforced; C2-B1 record (Task 7) |
| tests: `runner-lease`, `health-lease`, `browser-ownership`, `runner-step-busy-browser`, `import-checkpoints`, `import-claim` | Tasks 1–6 |

---

### Task 1: Runner lease module

**Files:**
- Create: `lib/linkedin/lease.ts`
- Test: `tests/runner-lease.test.ts`

**Interfaces — Produces:**
```ts
export const RUNNER_OWNER: string;
export const LEASE_TTL_MS = 120_000;
export const LEASE_KEY = "runner_lease";
export class LeaseLostError extends Error {}
export function acquireRunnerLease(db: Database.Database, owner?: string, ttlMs?: number, now?: number): boolean;
export function readRunnerLease(db): { owner: string; expires_at: string } | null;
export function holdsRunnerLease(db, owner?: string, now?: number): boolean;
export function withLease<T>(db, fn: () => T, owner?: string): T;
export function releaseRunnerLease(db, owner?: string): void;
```

- [ ] **Step 1: Write the failing test**

Create `tests/runner-lease.test.ts`:

```ts
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-runner-lease-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-runner-lease-tests";

const lease = await import("@/lib/linkedin/lease");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

const clear = () => getDb().prepare("DELETE FROM app_settings WHERE key = 'runner_lease'").run();
const T0 = Date.parse("2026-09-18T10:00:00Z");

test("L1 RUNNER_OWNER has the host:pid:hex shape", () => {
  assert.match(lease.RUNNER_OWNER, /^[^:]+:\d+:[0-9a-f]{8}$/);
});

test("L2 first acquire succeeds and records owner + expiry", () => {
  clear();
  assert.equal(lease.acquireRunnerLease(getDb(), "A", 120_000, T0), true);
  assert.deepEqual(lease.readRunnerLease(getDb()), { owner: "A", expires_at: new Date(T0 + 120_000).toISOString() });
});

test("L3 a second owner is refused while the lease is fresh; the holder can renew", () => {
  clear();
  lease.acquireRunnerLease(getDb(), "A", 120_000, T0);
  assert.equal(lease.acquireRunnerLease(getDb(), "B", 120_000, T0 + 60_000), false);
  assert.equal(lease.acquireRunnerLease(getDb(), "A", 120_000, T0 + 60_000), true, "renewal");
  assert.equal(lease.readRunnerLease(getDb())!.expires_at, new Date(T0 + 180_000).toISOString());
});

test("L4 an expired lease is handed over", () => {
  clear();
  lease.acquireRunnerLease(getDb(), "A", 120_000, T0);
  assert.equal(lease.acquireRunnerLease(getDb(), "B", 120_000, T0 + 120_001), true);
  assert.equal(lease.readRunnerLease(getDb())!.owner, "B");
  assert.equal(lease.holdsRunnerLease(getDb(), "A", T0 + 120_001), false);
  assert.equal(lease.holdsRunnerLease(getDb(), "B", T0 + 120_001), true);
});

test("L5 withLease runs fn for the holder and throws LeaseLostError (no write) for anyone else", () => {
  clear();
  lease.acquireRunnerLease(getDb(), "A", 120_000);
  getDb().exec("CREATE TABLE IF NOT EXISTS lease_probe (n INTEGER)");
  let ran = 0;
  assert.equal(lease.withLease(getDb(), () => { ran++; getDb().prepare("INSERT INTO lease_probe (n) VALUES (1)").run(); return 42; }, "A"), 42);
  assert.throws(() => lease.withLease(getDb(), () => { ran++; getDb().prepare("INSERT INTO lease_probe (n) VALUES (2)").run(); }, "B"), lease.LeaseLostError);
  assert.equal(ran, 1, "fn must not run for a non-holder");
  assert.equal((getDb().prepare("SELECT COUNT(*) c FROM lease_probe").get() as { c: number }).c, 1);
});

test("L6 release only clears the holder's own lease", () => {
  clear();
  lease.acquireRunnerLease(getDb(), "A", 120_000);
  lease.releaseRunnerLease(getDb(), "B");
  assert.equal(lease.readRunnerLease(getDb())!.owner, "A");
  lease.releaseRunnerLease(getDb(), "A");
  assert.equal(lease.readRunnerLease(getDb()), null);
});

test("L7 a malformed stored value is treated as absent", () => {
  getDb().prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('runner_lease', 'not-json', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  assert.equal(lease.readRunnerLease(getDb()), null);
  assert.equal(lease.acquireRunnerLease(getDb(), "A", 120_000), true);
});
```

- [ ] **Step 2: Run to verify it fails** — `RUN_ONE tests/runner-lease.test.ts` → module not found.

- [ ] **Step 3: Implement `lib/linkedin/lease.ts`**

```ts
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Runner lease (C2-B1 / PR-09).
 *
 * The loop guard, the watchdog and the import flag are per-process globals, so a
 * second process (replica, PM2 cluster, a second container on the same volume)
 * silently yields two runners driving one LinkedIn account. This lease lives in
 * the database and is the only thing that decides who the runner is. Every
 * track-state write goes through withLease(), so a process that lost the lease
 * mid-step cannot write stale state either.
 */
export const LEASE_KEY = "runner_lease";
export const LEASE_TTL_MS = 120_000;
export const RUNNER_OWNER = `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;

export class LeaseLostError extends Error {
  constructor(owner: string, holder: string | null) {
    super(`runner lease not held by ${owner} (holder: ${holder ?? "none"})`);
  }
}

export function readRunnerLease(db: Database.Database): { owner: string; expires_at: string } | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(LEASE_KEY) as { value: string } | undefined;
  if (!row?.value) return null;
  try {
    const v = JSON.parse(row.value) as { owner?: unknown; expires_at?: unknown };
    if (typeof v.owner !== "string" || typeof v.expires_at !== "string" || Number.isNaN(Date.parse(v.expires_at))) return null;
    return { owner: v.owner, expires_at: v.expires_at };
  } catch { return null; }
}

function write(db: Database.Database, owner: string, expiresAtMs: number) {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(LEASE_KEY, JSON.stringify({ owner, expires_at: new Date(expiresAtMs).toISOString() }));
}

/** Take the lease if absent, expired, or already ours. One IMMEDIATE transaction. */
export function acquireRunnerLease(db: Database.Database, owner = RUNNER_OWNER, ttlMs = LEASE_TTL_MS, now = Date.now()): boolean {
  return db.transaction(() => {
    const current = readRunnerLease(db);
    if (current && current.owner !== owner && Date.parse(current.expires_at) > now) return false;
    write(db, owner, now + ttlMs);
    return true;
  }).immediate();
}

export function holdsRunnerLease(db: Database.Database, owner = RUNNER_OWNER, now = Date.now()): boolean {
  const current = readRunnerLease(db);
  return !!current && current.owner === owner && Date.parse(current.expires_at) > now;
}

/** Runs fn inside an IMMEDIATE transaction only if the lease is held; otherwise throws before fn. */
export function withLease<T>(db: Database.Database, fn: () => T, owner = RUNNER_OWNER): T {
  return db.transaction(() => {
    if (!holdsRunnerLease(db, owner)) throw new LeaseLostError(owner, readRunnerLease(db)?.owner ?? null);
    return fn();
  }).immediate();
}

export function releaseRunnerLease(db: Database.Database, owner = RUNNER_OWNER): void {
  db.transaction(() => {
    const current = readRunnerLease(db);
    if (current?.owner === owner) db.prepare("DELETE FROM app_settings WHERE key = ?").run(LEASE_KEY);
  }).immediate();
}
```

- [ ] **Step 4: Run** — L1–L7 PASS. Note: `withLease` nested inside an outer `db.transaction` becomes a savepoint in better-sqlite3 — that is intended (Task 2 wraps verbs that may already run inside a transaction).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add lib/linkedin/lease.ts tests/runner-lease.test.ts
bash -lc 'git commit -q -m "C2-B1/PR-09: DB-backed runner lease with fenced withLease"'
```

---

### Task 2: Lease in the loop, watchdog, verbs, and health

**Files:**
- Modify: `lib/linkedin/runner.ts` (`globalLoop` ~1870, `runnerWatchdogTick` ~1785, `trClaim` ~672, verbs ~630-660, `ensureGlobalRunnerStarted` ~1760)
- Modify: `pages/api/health.ts` (~89-125)
- Test: extend `tests/runner-lease.test.ts` (watchdog cases), create `tests/health-lease.test.ts`

**Interfaces — Consumes:** Task 1. **Produces:** `runner_progress_phase = "standby"` while not holding the lease; `runnerWatchdogTick` returns false under a fresh foreign lease; verbs throw `LeaseLostError` without writing; health `runner.lease`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/runner-lease.test.ts` (this file loads the runner with the same mocks as `tests/runner-watchdog.test.ts` — copy that file's `@/lib/db` mock block and `session`/`message` mocks so no browser opens):

```ts
// ── watchdog + verbs (runner loaded with browser modules mocked, as in runner-watchdog.test.ts)
const runner = await import("@/lib/linkedin/runner");
const setMarker = (iso: string) => getDb().prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('runner_progress_at', ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(iso);
const stale = () => new Date(Date.now() - 11 * 60_000).toISOString();

test("L8 the watchdog does not revive while another owner holds a fresh lease", () => {
  clear(); setMarker(stale());
  lease.acquireRunnerLease(getDb(), "other-process", 120_000);
  assert.equal(runner.runnerWatchdogTick(getDb()), false);
  assert.equal(runner.runnerState().running, false);
});

test("L9 trClaim under a foreign lease throws LeaseLostError and claims nothing", () => {
  clear();
  lease.acquireRunnerLease(getDb(), "other-process", 120_000);
  const db = getDb();
  db.prepare("INSERT INTO workflows (id, name) VALUES ('wf-l9', 'x')").run();
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES ('run-l9', 'wf-l9', 'running')").run();
  db.prepare("INSERT INTO targets (id, linkedin_url) VALUES ('t-l9', 'https://www.linkedin.com/in/l9/')").run();
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES ('rp-l9', 'run-l9', 't-l9')").run();
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES ('tr-l9', 'rp-l9', 'linkedin', 'in_progress', 0)").run();
  assert.throws(() => runner.trClaim(db, "tr-l9"), lease.LeaseLostError);
  assert.equal((db.prepare("SELECT next_step_at FROM run_profile_tracks WHERE id = 'tr-l9'").get() as { next_step_at: string | null }).next_step_at, null);
  lease.acquireRunnerLease(getDb(), lease.RUNNER_OWNER, 120_000, Date.now() + 200_000); // hand over (expired) so later tests can claim
  assert.equal(runner.trClaim(db, "tr-l9"), true);
});
```

Create `tests/health-lease.test.ts`:

```ts
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-health-lease-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-health-lease-tests";

const { default: health } = await import("@/pages/api/health");
const lease = await import("@/lib/linkedin/lease");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

function get() {
  const captured = { status: 200, body: undefined as unknown };
  const res = { status(c: number) { captured.status = c; return this; }, json(p: unknown) { captured.body = p; return this; }, setHeader() { return this; }, end() { return this; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  health({ method: "GET", query: {}, headers: {} } as any, res as any);
  return captured.body as { runner?: { lease?: { owner: string | null; mine: boolean; expires_in_s: number | null } } };
}

test("HL1 health reports no lease when none is stored", () => {
  getDb().prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('runner_progress_at', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(new Date().toISOString());
  assert.deepEqual(get().runner?.lease, { owner: null, mine: false, expires_in_s: null });
});

test("HL2 health reports a foreign lease as not mine with a positive expiry", () => {
  lease.acquireRunnerLease(getDb(), "other:1:deadbeef", 120_000);
  const l = get().runner!.lease!;
  assert.equal(l.owner, "other:1:deadbeef");
  assert.equal(l.mine, false);
  assert.ok(l.expires_in_s! > 100 && l.expires_in_s! <= 120);
});

test("HL3 health reports our own lease as mine", () => {
  lease.acquireRunnerLease(getDb(), lease.RUNNER_OWNER, 120_000, Date.now() + 200_000);
  assert.equal(get().runner!.lease!.mine, true);
});
```

(If `health.ts` returns 503 "dead" because no progress marker exists, HL1 sets a fresh marker first — as written.)

- [ ] **Step 2: Run to verify failure** — L8 fails (revives), L9 fails (claims), HL* fail (no `lease` field).

- [ ] **Step 3: Implement**

`lib/linkedin/runner.ts`:

1. Import: `import { acquireRunnerLease, holdsRunnerLease, readRunnerLease, releaseRunnerLease, withLease, LeaseLostError, RUNNER_OWNER } from "@/lib/linkedin/lease";`
2. `trClaim`: wrap the UPDATE in `withLease(db, () => …)`:
```ts
export function trClaim(db: ReturnType<typeof getDb>, trackId: string): boolean {
  const leaseUntil = new Date(Date.now() + CLAIM_LEASE_MINUTES * 60_000).toISOString();
  return withLease(db, () => {
    const claimed = db.prepare(
      `UPDATE run_profile_tracks SET next_step_at = ?
       WHERE id = ? AND state = 'in_progress'
         AND (next_step_at IS NULL OR datetime(next_step_at) <= datetime('now'))`
    ).run(leaseUntil, trackId);
    return claimed.changes === 1;
  });
}
```
3. Verbs `trAdvance`, `trWait`, `trReschedule`, `trSkip`, `trFail` (and the deleted-step `completed` write at ~1003): wrap each function body's DB writes in `withLease(db, () => { … })`. Keep signatures. `trRecordContext` (context only, not state) is left unfenced.
4. `globalLoop`: at the top of the `while (true)` body, before `recordProgress(db, "loop")`:
```ts
    if (!acquireRunnerLease(db)) {
      const holder = readRunnerLease(db);
      if (!standbyLogged) {
        console.warn(`[runner] standby — lease held by ${holder?.owner ?? "?"} until ${holder?.expires_at ?? "?"}; this process does no runner work`);
        standbyLogged = true;
      }
      putSetting(db, HEARTBEAT_KEYS.progressPhase, "standby");
      await sleepUnref(POLL_INTERVAL_MS);
      continue;
    }
    if (standbyLogged) { console.log(`[runner] resumed — lease acquired by ${RUNNER_OWNER}`); standbyLogged = false; }
```
with `let standbyLogged = false;` declared before the loop. (`putSetting` exists; check its signature with `grep -n "function putSetting" lib/linkedin/runner.ts`.)
5. `runnerWatchdogTick`: after the `runnerState().running` check and before the marker check:
```ts
    const foreign = readRunnerLease(db);
    if (foreign && foreign.owner !== RUNNER_OWNER && Date.parse(foreign.expires_at) > Date.now()) return false; // another process is the runner
```
6. `executeStep` outer catch: `LeaseLostError` → log `warn` `lease lost mid-step — no state written` and `return` (no `trFail`, which would itself throw). Place this before the generic `trFail(db, tr, msg)`.
7. `ensureGlobalRunnerStarted`: register once `process.once("SIGTERM", …)`/`"SIGINT"` → `try { releaseRunnerLease(getDb()); } catch {}` (guard with a module flag so tests registering multiple loops don't stack listeners).

`pages/api/health.ts`: import `{ readRunnerLease, RUNNER_OWNER } from "@/lib/linkedin/lease"` (built-ins only — verify with `RUN_ONE tests/health-isolation.test.ts`), compute
```ts
    const lease = readRunnerLease(db);
    const leaseInfo = {
      owner: lease?.owner ?? null,
      mine: !!lease && lease.owner === RUNNER_OWNER && Date.parse(lease.expires_at) > Date.now(),
      expires_in_s: lease ? Math.max(0, Math.round((Date.parse(lease.expires_at) - Date.now()) / 1000)) : null,
    };
```
and add `lease: leaseInfo` to the `runner` object in both the 503 "dead" and 200 responses. Bump `HEALTH_SCHEMA` only if `tests/health-endpoint.test.ts` asserts the exact key set — check; if it does an exact `deepEqual` on `runner`, update that test to include `lease` and note it.

- [ ] **Step 4: Run** — `RUN_ONE tests/runner-lease.test.ts tests/health-lease.test.ts tests/runner-watchdog.test.ts tests/runner-loop-survival.test.ts tests/health-isolation.test.ts tests/health-endpoint.test.ts tests/runner-connect-idempotence.test.ts tests/message-idempotency.test.ts tests/email-idempotency.test.ts` → all PASS. Existing runner suites that drive `executeStep` without a lease must still pass: the verbs now require the lease — check whether those suites need `acquireRunnerLease(getDb())` in setup; if so, add exactly that one line to each affected suite's setup and list them in the report (the lease is a real precondition now).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add lib/linkedin/runner.ts pages/api/health.ts tests/runner-lease.test.ts tests/health-lease.test.ts tests/*.test.ts
bash -lc 'git commit -q -m "C2-B1/PR-09: loop standby without the lease; watchdog respects a foreign lease; track verbs fenced; health reports the lease"'
```

---

### Task 3: Browser ownership module

**Files:**
- Create: `lib/linkedin/ownership.ts`
- Test: `tests/browser-ownership.test.ts`

**Interfaces — Produces:**
```ts
export const PAGE_TEARDOWN_GAP_MS = 3000;
export interface BrowserOwner { readonly accountId: string; readonly label: string; readonly signal: AbortSignal; readonly context: BrowserContext; newPage(): Promise<Page>; }
export class BrowserBusyError extends Error { readonly heldBy: string; }
export interface AcquireOptions { maxHoldMs: number; waitMs?: number }   // waitMs undefined = wait indefinitely; 0 = do not wait
export async function acquireBrowserOwner(accountId: string, label: string, opts: AcquireOptions): Promise<{ owner: BrowserOwner; release: () => Promise<void> }>;
export async function withBrowserOwner<T>(accountId, label, opts, fn: (owner: BrowserOwner) => Promise<T>): Promise<T>;
export async function tryWithBrowserOwner<T>(accountId, label, opts: { maxHoldMs: number }, fn): Promise<{ ok: true; value: T } | { ok: false; heldBy: string }>;
export function browserOwnerState(accountId): { heldBy: string; since: string } | null;
export function setBrowserContextProvider(p: (accountId: string) => Promise<BrowserContext>): void; // tests + session.ts wiring
```

- [ ] **Step 1: Write the failing test**

Create `tests/browser-ownership.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

const own = await import("@/lib/linkedin/ownership");

// ── fake browser objects ────────────────────────────────────────────────────
type FakePage = { closed: boolean; close: () => Promise<void>; isClosed: () => boolean };
type FakeCtx = { pages: () => FakePage[]; newPage: () => Promise<FakePage>; _pages: FakePage[] };
function fakeContext(): FakeCtx {
  const ctx: FakeCtx = {
    _pages: [],
    pages: () => ctx._pages.filter(p => !p.closed),
    newPage: async () => { const p: FakePage = { closed: false, isClosed: () => p.closed, close: async () => { p.closed = true; } }; ctx._pages.push(p); return p; },
  };
  return ctx;
}
const contexts = new Map<string, FakeCtx>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
own.setBrowserContextProvider(async (id) => (contexts.get(id) ?? (contexts.set(id, fakeContext()), contexts.get(id)!)) as any);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("O1 a second acquirer waits until the first releases (no overlap)", async () => {
  const order: string[] = [];
  const a = own.withBrowserOwner("acct-1", "first", { maxHoldMs: 10_000 }, async (o) => { order.push("a-start"); await o.newPage(); await sleep(50); order.push("a-end"); });
  await sleep(5);
  const b = own.withBrowserOwner("acct-1", "second", { maxHoldMs: 10_000 }, async () => { order.push("b-start"); });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
});

test("O2 accounts are independent", async () => {
  const order: string[] = [];
  await Promise.all([
    own.withBrowserOwner("acct-2", "x", { maxHoldMs: 10_000 }, async () => { order.push("2-start"); await sleep(30); order.push("2-end"); }),
    own.withBrowserOwner("acct-3", "y", { maxHoldMs: 10_000 }, async () => { order.push("3-start"); }),
  ]);
  assert.equal(order[1], "3-start", "acct-3 did not wait for acct-2");
});

test("O3 tryWithBrowserOwner reports the holder instead of waiting", async () => {
  const hold = own.withBrowserOwner("acct-4", "import", { maxHoldMs: 10_000 }, async () => { await sleep(60); });
  await sleep(5);
  const r = await own.tryWithBrowserOwner("acct-4", "step", { maxHoldMs: 1000 }, async () => "ran");
  assert.deepEqual(r, { ok: false, heldBy: "import" });
  assert.equal(own.browserOwnerState("acct-4")?.heldBy, "import");
  await hold;
  const r2 = await own.tryWithBrowserOwner("acct-4", "step", { maxHoldMs: 1000 }, async () => "ran");
  assert.deepEqual(r2, { ok: true, value: "ran" });
  assert.equal(own.browserOwnerState("acct-4"), null);
});

test("O4 max-hold aborts the holder, closes every page of the context, and admits the next only after the holder settled", async () => {
  const events: string[] = [];
  let observedAbort = false;
  const a = own.withBrowserOwner("acct-5", "slow", { maxHoldMs: 40 }, async (o) => {
    const p1 = await o.newPage(); await o.context.newPage(); // one tracked, one opened directly on the context
    o.signal.addEventListener("abort", () => { observedAbort = true; });
    await sleep(120);                                         // outlives maxHold
    events.push(`a-end pages-open=${o.context.pages().length} p1-closed=${p1.isClosed()}`);
  });
  await sleep(5);
  const b = own.withBrowserOwner("acct-5", "next", { maxHoldMs: 1000 }, async () => { events.push("b-start"); });
  await Promise.all([a, b]);
  assert.equal(observedAbort, true);
  assert.deepEqual(events, ["a-end pages-open=0 p1-closed=true", "b-start"]);
});

test("O5 waitMs expiry throws BrowserBusyError naming the holder", async () => {
  const hold = own.withBrowserOwner("acct-6", "import", { maxHoldMs: 10_000 }, async () => { await sleep(80); });
  await sleep(5);
  await assert.rejects(own.withBrowserOwner("acct-6", "route", { maxHoldMs: 100, waitMs: 20 }, async () => {}), (e: unknown) => e instanceof own.BrowserBusyError && (e as { heldBy: string }).heldBy === "import");
  await hold;
});

test("O6 a throwing holder still releases", async () => {
  await assert.rejects(own.withBrowserOwner("acct-7", "x", { maxHoldMs: 1000 }, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(own.browserOwnerState("acct-7"), null);
  const r = await own.tryWithBrowserOwner("acct-7", "y", { maxHoldMs: 1000 }, async () => 1);
  assert.deepEqual(r, { ok: true, value: 1 });
});

test("O7 acquire/release handle: release after the teardown gap admits the next holder", async () => {
  const t0 = Date.now();
  const h = await own.acquireBrowserOwner("acct-8", "step", { maxHoldMs: 1000 });
  const next = own.withBrowserOwner("acct-8", "n", { maxHoldMs: 1000 }, async () => Date.now() - t0);
  await sleep(5);
  await h.release();
  const elapsed = await next;
  assert.ok(elapsed >= own.PAGE_TEARDOWN_GAP_MS - 5, `next holder admitted only after the gap (elapsed ${elapsed})`);
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement `lib/linkedin/ownership.ts`**

> **SUPERSEDED by 02568cb / a142d1d** — the reference code below claims the slot after an
> `await` (two same-tick acquirers were both admitted) and unref's the gap timer (Node 22
> drained the loop mid-await); see `lib/linkedin/ownership.ts` for the corrected implementation.

```ts
import type { BrowserContext, Page } from "playwright";

/**
 * Per-account browser ownership (C2-B1 / PR-09).
 *
 * B6 (CPU-spike incident) serialised page OPENS through one queue with a 120 s
 * safety valve. That valve is exactly what let an import scrape and a runner
 * step drive the same Chromium at once: after 120 s the queue moved on while the
 * import still held its page. Ownership replaces the valve: one holder per
 * account; when the max hold expires the holder is ABORTED — its signal fires and
 * every page of the account's context is closed, so its pending Playwright calls
 * reject — and the next holder is admitted only after the previous one settled.
 * Timeout ends owned work; it never overlaps a replacement.
 */
export const PAGE_TEARDOWN_GAP_MS = 3000;

export interface BrowserOwner {
  readonly accountId: string;
  readonly label: string;
  readonly signal: AbortSignal;
  readonly context: BrowserContext;
  newPage(): Promise<Page>;
}
export interface AcquireOptions { maxHoldMs: number; waitMs?: number }
export class BrowserBusyError extends Error {
  constructor(accountId: string, public readonly heldBy: string) { super(`browser for account ${accountId} is owned by ${heldBy}`); }
}

interface Holder { label: string; since: string; abort: AbortController; settled: Promise<void> }
interface Slot { holder: Holder | null; queue: Array<{ resolve: () => void; reject: (e: Error) => void; label: string }> }
const slots = new Map<string, Slot>();
const slot = (id: string) => slots.get(id) ?? (slots.set(id, { holder: null, queue: [] }), slots.get(id)!);

let contextProvider: (accountId: string) => Promise<BrowserContext> = async () => { throw new Error("browser context provider not wired (session.ts sets it)"); };
/** session.ts wires the real provider; tests wire fakes. */
export function setBrowserContextProvider(p: (accountId: string) => Promise<BrowserContext>): void { contextProvider = p; }

export function browserOwnerState(accountId: string): { heldBy: string; since: string } | null {
  const h = slots.get(accountId)?.holder;
  return h ? { heldBy: h.label, since: h.since } : null;
}

const sleep = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); });

async function waitForTurn(accountId: string, label: string, waitMs: number | undefined): Promise<void> {
  const s = slot(accountId);
  if (!s.holder && s.queue.length === 0) return;
  if (waitMs === 0) throw new BrowserBusyError(accountId, s.holder?.label ?? s.queue[0]?.label ?? "queued");
  await new Promise<void>((resolve, reject) => {
    const entry = { resolve, reject, label };
    s.queue.push(entry);
    if (waitMs !== undefined) {
      const t = setTimeout(() => {
        const i = s.queue.indexOf(entry);
        if (i >= 0) { s.queue.splice(i, 1); reject(new BrowserBusyError(accountId, s.holder?.label ?? "queued")); }
      }, waitMs);
      (t as { unref?: () => void }).unref?.();
    }
  });
}

function admitNext(accountId: string) {
  const s = slot(accountId);
  const next = s.queue.shift();
  if (next) next.resolve();
}

export async function acquireBrowserOwner(accountId: string, label: string, opts: AcquireOptions): Promise<{ owner: BrowserOwner; release: () => Promise<void> }> {
  await waitForTurn(accountId, label, opts.waitMs);
  const s = slot(accountId);
  const abort = new AbortController();
  let settle!: () => void;
  const settled = new Promise<void>(r => { settle = r; });
  s.holder = { label, since: new Date().toISOString(), abort, settled };
  let context: BrowserContext;
  try {
    context = await contextProvider(accountId);
  } catch (err) {
    s.holder = null; settle(); admitNext(accountId);
    throw err;
  }
  const closeAll = async () => { for (const p of context.pages()) { try { await p.close(); } catch { /* already gone */ } } };
  const timer = setTimeout(() => { abort.abort(new Error(`max hold ${opts.maxHoldMs} ms exceeded by ${label}`)); void closeAll(); }, opts.maxHoldMs);
  (timer as { unref?: () => void }).unref?.();
  const owner: BrowserOwner = { accountId, label, signal: abort.signal, context, newPage: () => context.newPage() };
  let released = false;
  const release = async () => {
    if (released) return; released = true;
    clearTimeout(timer);
    if (abort.signal.aborted) await closeAll();      // the holder was cut off — make sure nothing of it survives
    await sleep(PAGE_TEARDOWN_GAP_MS);
    s.holder = null; settle(); admitNext(accountId);
  };
  return { owner, release };
}

export async function withBrowserOwner<T>(accountId: string, label: string, opts: AcquireOptions, fn: (owner: BrowserOwner) => Promise<T>): Promise<T> {
  const { owner, release } = await acquireBrowserOwner(accountId, label, opts);
  try { return await fn(owner); } finally { await release(); }
}

export async function tryWithBrowserOwner<T>(accountId: string, label: string, opts: { maxHoldMs: number }, fn: (owner: BrowserOwner) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; heldBy: string }> {
  try {
    const value = await withBrowserOwner(accountId, label, { ...opts, waitMs: 0 }, fn);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof BrowserBusyError) return { ok: false, heldBy: err.heldBy };
    throw err;
  }
}
```

- [ ] **Step 4: Run** — O1–O7 PASS (O7 takes ~3 s by design).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add lib/linkedin/ownership.ts tests/browser-ownership.test.ts
bash -lc 'git commit -q -m "C2-B1/PR-09: per-account browser owner — abortable max hold, no overlapping replacement"'
```

---

### Task 4: Every browser consumer goes through the owner

**Files:**
- Modify: `lib/linkedin/session.ts:143-215` (`getSessionPage`, page queue removal, provider wiring)
- Modify: `lib/linkedin/runner.ts` (`executeStep` browser-step preflight + `BrowserBusyError` catch; `ensureSalesNavEnriched` ~870-880)
- Modify: `pages/api/lists/[id]/enrich.ts:~40`, `pages/api/lists/[id]/sync-status.ts:~36`, `pages/api/targets/[id]/profile-scrape.ts:~34`
- Test: `tests/runner-step-busy-browser.test.ts`

**Interfaces — Consumes:** Task 3. **Produces:** `getSessionPage(accountId, opts?: { label?: string; waitMs?: number; maxHoldMs?: number })` (defaults `"step"`, indefinite wait, 120 s); routes answer `409 { error: "browser_busy", held_by }`.

- [ ] **Step 1: Write the failing test**

Create `tests/runner-step-busy-browser.test.ts` — same harness as `tests/message-idempotency.test.ts` (mock `@/lib/linkedin/message` and mock `@/lib/linkedin/session` **except** `getSessionPage`, which must be the real one; wire `setBrowserContextProvider` to a fake context whose `newPage()` records a call):

```ts
// (imports, temp DB, mockModule as in message-idempotency.test.ts)
const own = await import("@/lib/linkedin/ownership");
let pagesOpened = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
own.setBrowserContextProvider(async () => ({ pages: () => [], newPage: async () => { pagesOpened++; return { close: async () => {}, isClosed: () => false }; } }) as any);
const lease = await import("@/lib/linkedin/lease");
const { executeStep } = await import("@/lib/linkedin/runner");
const { getDb } = await import("@/lib/db");
lease.acquireRunnerLease(getDb());
// scenario(): one linkedin 'visit' step (visit needs the least mocking; check the visit branch's dependencies and mock `@/lib/linkedin/visit` (or whichever module it calls) to a no-op that resolves)

test("B1 a step for an account whose browser is owned by an import is rescheduled ~5 min out and opens no page", async () => {
  const s = scenario();
  const hold = own.withBrowserOwner("acct-x", "import", { maxHoldMs: 10_000 }, async () => { await new Promise(r => setTimeout(r, 80)); });
  await new Promise(r => setTimeout(r, 5));
  pagesOpened = 0;
  await run(s); // executeStep(..., accountId "acct-x", ...)
  const t = track(s.ids.track);
  assert.equal(t.state, "in_progress");
  assert.ok(t.next_step_at && new Date(t.next_step_at).getTime() - Date.now() > 4 * 60_000);
  assert.equal(pagesOpened, 0);
  assert.match(lastLog(s.ids.run), /browser owned by import — rescheduling/);
  await hold;
});

test("B2 with the browser free the step opens its page and proceeds", async () => {
  const s = scenario(); pagesOpened = 0;
  await run(s);
  assert.equal(pagesOpened, 1);
});
```

- [ ] **Step 2: Run to verify failure** — B1 fails (page opened / no reschedule).

- [ ] **Step 3: Implement**

`lib/linkedin/session.ts`: delete `PAGE_TEARDOWN_GAP_MS`, `PAGE_MAX_HOLD_MS`, `pageQueueTail` and the queue logic; keep `getOrCreateContext` (with its B2 dead-context retry) and wire it: `setBrowserContextProvider(getOrCreateContext)` at module load (import from `@/lib/linkedin/ownership`). Replace `getSessionPage`:

```ts
/**
 * A page on the account's browser, owned for the life of the page. Ownership is
 * released (after the teardown gap) when the caller closes the page — the same
 * contract as before, now backed by lib/linkedin/ownership.ts instead of a queue
 * with a safety valve.
 */
export async function getSessionPage(accountId: string, opts: { label?: string; waitMs?: number; maxHoldMs?: number } = {}): Promise<Page> {
  const { owner, release } = await acquireBrowserOwner(accountId, opts.label ?? "step", { maxHoldMs: opts.maxHoldMs ?? 120_000, waitMs: opts.waitMs });
  let page: Page;
  try {
    page = await owner.newPage();
  } catch (err) {
    await release();
    throw err;
  }
  const originalClose = page.close.bind(page);
  page.close = (async (options?: Parameters<Page["close"]>[0]) => {
    try { return await originalClose(options); } finally { await release(); }
  }) as Page["close"];
  return page;
}
```

Keep the B2 comment and behaviour inside `getOrCreateContext` (the provider). `getSessionContext` stays exported.

`lib/linkedin/runner.ts`:
- Near the top of `executeStep`, after the reply-hold block and before `const step = resolution.step;`… actually after `const step` is known: if `step.step_type` is one of `visit | connect | message | sales_inmail` (browser steps):
```ts
  const heldBy = browserOwnerState(accountId)?.heldBy;
  if (heldBy && heldBy !== "step") {
    log(db, runId, target.id, "info", `browser owned by ${heldBy} — rescheduling ${name} 5 minutes out`);
    trReschedule(db, tr, new Date(Date.now() + 5 * 60_000).toISOString());
    return;
  }
```
- Every `getSessionPage(accountId)` call in the step branches becomes `getSessionPage(accountId, { waitMs: 60_000 })`; in the outer catch add, before the generic `trFail`:
```ts
    if (err instanceof BrowserBusyError) {
      log(db, runId, target.id, "info", `browser owned by ${err.heldBy} — rescheduling ${name} 5 minutes out`);
      trReschedule(db, tr, new Date(Date.now() + 5 * 60_000).toISOString());
      return;
    }
```
- `ensureSalesNavEnriched`: replace `const ctx = await getSessionContext(accountId); await enrichProfile(ctx, …)` with
```ts
    const r = await tryWithBrowserOwner(accountId, "salesnav-enrich", { maxHoldMs: 180_000 }, (o) => enrichProfile(o.context, { … }));
    if (!r.ok) console.log(`[runner] Sales Nav enrichment skipped — browser owned by ${r.heldBy}`);
```
Imports: `import { browserOwnerState, tryWithBrowserOwner, BrowserBusyError } from "@/lib/linkedin/ownership";`

Routes — each replaces `const ctx = await getSessionContext(id); await X(ctx, …)` with:
```ts
    try {
      await withBrowserOwner(id, "<enrich|sync-status|profile-scrape>", { maxHoldMs: 600_000, waitMs: 30_000 }, (o) => X(o.context, …));
    } catch (err) {
      if (err instanceof BrowserBusyError) return res.status(409).json({ error: "browser_busy", held_by: err.heldBy });
      throw err;
    }
```
For `enrich.ts` (responds immediately, work in background) the 409 cannot be returned after the response — check for the busy state up front with `browserOwnerState(account_id)` and return 409 before responding 202; keep the background call wrapped in `withBrowserOwner` with `waitMs: 30_000`.

- [ ] **Step 4: Run** — `RUN_ONE tests/runner-step-busy-browser.test.ts tests/browser-ownership.test.ts tests/message-idempotency.test.ts tests/inmail-idempotency.test.ts tests/runner-connect-idempotence.test.ts tests/runner-visit-degree.test.ts tests/host-allowlist.test.ts tests/pr07-csv-navigation.test.ts` → PASS. Suites that mock `@/lib/linkedin/session` wholesale (`getSessionPage: async () => ({ close })`) are unaffected.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add lib/linkedin/session.ts lib/linkedin/runner.ts "pages/api/lists/[id]/enrich.ts" "pages/api/lists/[id]/sync-status.ts" "pages/api/targets/[id]/profile-scrape.ts" tests/runner-step-busy-browser.test.ts
bash -lc 'git commit -q -m "C2-B1/PR-09: getSessionPage and every context bypass go through the browser owner; busy browser reschedules the step; routes answer 409"'
```

---

### Task 5: Scraper takes an owner, reports per verified page, never counts a missing page

**Files:**
- Modify: `lib/linkedin/scraper.ts` (`ScrapeOptions` ~137, `scrapeNavigatorList` ~157-240, `scrapeSavedSearch` ~245-328, `scrapeNavigatorUrl` ~334)
- Test: `tests/scraper-checkpoints.test.ts`

**Interfaces — Produces:**
```ts
export interface ScrapeOptions { startPage?: number; maxPages?: number; onProgress?; isCanceled?; onPage?: (pageNum: number, profiles: ScrapedProfile[]) => void | Promise<void>; }
export interface WindowedScrapeResult { profiles; lastPage; knownTotal; exhausted; stalled?: { page: number; reason: string } }
export async function scrapeNavigatorUrl(owner: BrowserOwner, url: string, opts?): Promise<WindowedScrapeResult>  // same for List/SavedSearch
```

- [ ] **Step 1: Write the failing test**

Create `tests/scraper-checkpoints.test.ts`. The scrapers drive a page via `page.goto` + a `"response"` listener; fake a page whose `goto(url)` synchronously emits a fake response for the page number in the URL, from a script the test controls (`pages: Record<number, elements[] | null>`; `null` = no intercept). Replace `page.waitForTimeout` with an immediate resolve. Assert:

- `SC1`: pages 1–3 present → `onPage` called 3× with the right page numbers and element counts; `lastPage = 3`; `exhausted` true when `knownTotal = 75`.
- `SC2`: page 2 missing (null twice, i.e. retry also empty) → `onPage` called once (page 1); `lastPage = 1`; `stalled = { page: 2, reason: /no data intercepted/ }`; `exhausted = false`; `profiles` contains only page 1.
- `SC3`: `owner.signal` aborted before page 2 → loop stops after page 1; `lastPage = 1`; no throw.
- `SC4`: `isCanceled` true before page 2 → same as SC3 without `stalled`.

(Construct the fake page/owner in the test; `owner = { accountId, label, signal, context: fakeCtx, newPage: async () => fakePage }`.)

- [ ] **Step 2: Run to verify failure** — TypeScript/runtime: scrapers expect a `BrowserContext`; `onPage`/`stalled` absent.

- [ ] **Step 3: Implement** (both scrapers identically):

- Signature `owner: BrowserOwner`; `const page = await owner.newPage();`.
- First page: after verification, `await onPage?.(startPage, firstData.elements.map(el => profileToResult(el, …)))` (dedupe within the page with `seen` as today; `seen` stays across pages so `allElements` is unchanged).
- Loop: before each page `if (owner.signal.aborted) break;` (alongside the existing `isCanceled` checks). After the retry, if `!pageData || (pageData.elements?.length ?? 0) === 0`:
```ts
      stalled = { page: pageNum, reason: "no data intercepted after retry" };
      console.warn(`[scraper] page ${pageNum} still empty after retry — ending window at verified page ${lastPage}`);
      break;                                  // lastPage is NOT advanced
```
  else push elements, `await onPage?.(pageNum, pageProfiles)`, **then** `lastPage = pageNum`.
- Return `{ profiles, lastPage, knownTotal, exhausted: !stalled && lastPage >= totalPages, ...(stalled ? { stalled } : {}) }`.
- `scrapeNavigatorUrl(owner, url, opts)` forwards.

- [ ] **Step 4: Run** — SC1–SC4 PASS; `RUN_ONE tests/pr07-csv-navigation.test.ts tests/host-allowlist.test.ts` PASS (they may construct scrapers with a context — adapt those tests to pass a minimal owner `{ context, newPage: () => context.newPage(), signal: new AbortController().signal, accountId, label }` and note it).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add lib/linkedin/scraper.ts tests/scraper-checkpoints.test.ts tests/*.test.ts
bash -lc 'git commit -q -m "C2-B1/PR-06: scraper reports each verified page; a missing page ends the window without advancing"'
```

---

### Task 6: Import claim, per-page durability, completion/stall/cancel, recovery

**Files:**
- Modify: `lib/db.ts` (`migrations[]` — four ALTERs), `lib/import-jobs.ts` (`processScheduledImports` ~120-137, `runBatch` ~139-235), `lib/linkedin/runner.ts` (`globalLoop`: call `recoverInterruptedImports(db)` once at start and hourly)
- Test: `tests/import-checkpoints.test.ts`, `tests/import-claim.test.ts`

**Interfaces — Consumes:** Tasks 1, 3, 5. **Produces:**
```ts
export const IMPORT_STALE_MS = 600_000;
export class ImportOwnershipLostError extends Error {}
export function claimScheduledImport(db, importId: string, owner?: string): boolean;
export function recoverInterruptedImports(db, now?: number): { recovered: string[]; quarantined: string[] };
export async function runBatch(importId: string, deps?: { scrape?: typeof scrapeNavigatorUrl; owner?: string }): Promise<void>;   // deps for tests
```

- [ ] **Step 1: Write the failing tests**

`tests/import-claim.test.ts`:
```ts
// temp DB; import { claimScheduledImport, processScheduledImports } and lease
test("C1 two claims for one scheduled row: exactly one wins", () => { /* insert list + list_imports scheduled; claimScheduledImport(db,id,"A") true; claimScheduledImport(db,id,"B") false; row.owner === "A", status running, heartbeat_at set */ });
test("C2 a cancelled scheduled row cannot be claimed", …);
test("C3 processScheduledImports starts nothing while the runner lease is not held (standby)", …);   // no lease → no row changes status
test("C4 processScheduledImports skips an account that already has a running import", …);
```
`tests/import-checkpoints.test.ts` (fake `scrape` injected via `runBatch(id, { scrape })` that calls `opts.onPage` for scripted pages and returns the result shape; `lease.acquireRunnerLease(getDb())` in setup; `setBrowserContextProvider` fake):
```ts
test("I1 each verified page is inserted and checkpointed together", …);           // after page 2 of 3: page=2, imported=50; end: status done, page=3, exhausted → no continuation
test("I2 a missing page ends the window without advancing; continuation from page+1", …); // scripted stalled at 2 → page=1, stall_reason set, status done, new scheduled row start_page=2
test("I3 a crash between pages leaves a stale running row; recovery reschedules from page+1 without duplicates", …); // scrape throws after page 1's onPage... simulate "crash" by making scrape hang? Use: scrape resolves onPage(1) then throws a synthetic ProcessDied error caught by runBatch → status error? No: simulate crash = set heartbeat_at old + status running directly, then recoverInterruptedImports → scheduled, start_page = 2, recovery_count 1; re-run with pages 2..3 → targets count = 75 exactly (no dup of page 1), page = 3
test("I4 third recovery quarantines", …);                                          // recovery_count 2 → recover → status error, message contains "quarantined"
test("I5 cancel between pages: status canceled, imported reflects durable inserts", …);
test("I6 owner fence: an onPage for a row whose owner changed inserts nothing and aborts", …); // change owner mid-scrape → ImportOwnershipLostError, target count unchanged
```
Write these fully in the file (fixtures: `lists`, `accounts`, `list_imports` rows; profiles generated as `{ linkedin_url: https://www.linkedin.com/in/p-${n}/, full_name, … }` matching `insertProfiles`' expected shape — read `insertProfiles` at `lib/import-jobs.ts:241` for the exact fields).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`lib/db.ts` `migrations[]` (append):
```ts
    // C2-B1 (PR-06/PR-09): import ownership and truthful checkpoints.
    "ALTER TABLE list_imports ADD COLUMN owner TEXT",
    "ALTER TABLE list_imports ADD COLUMN heartbeat_at TEXT",
    "ALTER TABLE list_imports ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE list_imports ADD COLUMN stall_reason TEXT",
```

`lib/import-jobs.ts`:

```ts
export const IMPORT_STALE_MS = 600_000;
export class ImportOwnershipLostError extends Error {}

export function claimScheduledImport(db: DB, importId: string, owner = RUNNER_OWNER): boolean {
  return db.prepare(
    `UPDATE list_imports SET status = 'running', owner = ?, heartbeat_at = datetime('now'), started_at = COALESCE(started_at, datetime('now'))
     WHERE id = ? AND status = 'scheduled' AND cancel_requested = 0`
  ).run(owner, importId).changes === 1;
}

export async function processScheduledImports(db: DB): Promise<void> {
  if (!holdsRunnerLease(db)) return;                         // standby processes never claim
  const due = db.prepare(`SELECT * FROM list_imports WHERE status = 'scheduled' AND cancel_requested = 0
      AND (scheduled_for IS NULL OR scheduled_for <= date('now'))
      AND account_id NOT IN (SELECT account_id FROM list_imports WHERE status = 'running' AND account_id IS NOT NULL)
    ORDER BY scheduled_for ASC, batch_index ASC LIMIT 1`).get() as ImportRow | undefined;
  if (!due) return;
  if (!claimScheduledImport(db, due.id)) return;
  runBatch(due.id).catch((e) => console.error("[import] batch crashed:", e));
}
```
(`importRunning` is deleted.)

`runBatch(importId, deps = {})`: `const scrape = deps.scrape ?? scrapeNavigatorUrl; const owner = deps.owner ?? RUNNER_OWNER;` Wrap the scrape in `withBrowserOwner(job.account_id, "import", { maxHoldMs: 3 * 3_600_000 }, async (bo) => scrape(bo, job.sales_nav_url, { startPage, maxPages, onProgress, isCanceled: () => isCanceled() || bo.signal.aborted, onPage }))` where:

```ts
  const onPage = (pageNum: number, pageProfiles: unknown[]) => {
    db.transaction(() => {
      const { imported, skipped } = insertProfiles(db, job.list_id, pageProfiles);
      const r = db.prepare(
        `UPDATE list_imports SET page = ?, imported = imported + ?, skipped = skipped + ?, count = count + ?, heartbeat_at = datetime('now'), phase = 'scraping'
         WHERE id = ? AND status = 'running' AND owner = ?`
      ).run(pageNum, imported, skipped, pageProfiles.length, importId, owner);
      if (r.changes === 0) throw new ImportOwnershipLostError(`import ${importId} is no longer owned by ${owner}`);
    }).immediate();
  };
```
After the scrape resolves (`{ lastPage, knownTotal, exhausted, stalled }`): do **not** call `insertProfiles` again. One transaction:
- cancelled → `status='canceled', finished_at=now, owner=NULL`.
- `stalled` with `lastPage < job.start_page` (nothing verified) → `status='error', error=stalled.reason, owner=NULL` (+ re-auth detection as today).
- otherwise → `status='done', total=?, total_pages=?, finished_at=now, owner=NULL, stall_reason = stalled?.reason ?? NULL`, and if `!exhausted` insert the continuation row (`start_page = lastPage + 1`, `scheduled_for = tomorrow`, `batch_index + 1`, …) in the same transaction.
- catch: `ImportOwnershipLostError` → log and return (the row belongs to someone else now); other errors → `status='error', error, owner=NULL` as today; `BrowserBusyError` → put the row back to `scheduled` (`status='scheduled', owner=NULL`) with `error = 'browser busy — will retry'`.

```ts
export function recoverInterruptedImports(db: DB, now = Date.now()): { recovered: string[]; quarantined: string[] } {
  const cutoff = new Date(now - IMPORT_STALE_MS).toISOString();
  return withLease(db, () => {
    const stale = db.prepare(`SELECT id, page, start_page, recovery_count FROM list_imports WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`).all(cutoff) as Array<{ id: string; page: number | null; start_page: number; recovery_count: number }>;
    const recovered: string[] = [], quarantined: string[] = [];
    for (const r of stale) {
      if (r.recovery_count >= 2) {
        db.prepare(`UPDATE list_imports SET status = 'error', owner = NULL, finished_at = datetime('now'), recovery_count = recovery_count + 1,
                    error = 'quarantined after 3 interrupted runs — check the account session and retry manually' WHERE id = ?`).run(r.id);
        quarantined.push(r.id);
      } else {
        const resumeFrom = r.page && r.page >= r.start_page ? r.page + 1 : r.start_page;
        db.prepare(`UPDATE list_imports SET status = 'scheduled', scheduled_for = NULL, owner = NULL, start_page = ?, recovery_count = recovery_count + 1,
                    error = 'recovered after interrupted run (attempt ' || (recovery_count + 1) || ')' WHERE id = ?`).run(resumeFrom, r.id);
        recovered.push(r.id);
      }
    }
    return { recovered, quarantined };
  });
}
```
Note `heartbeat_at` is written with `datetime('now')` (format `YYYY-MM-DD HH:MM:SS`) — compare with the same format: build `cutoff` as `new Date(now - IMPORT_STALE_MS).toISOString().slice(0, 19).replace("T", " ")`. (Adjust the code above accordingly.)

`lib/linkedin/runner.ts` `globalLoop`: after acquiring the lease on the first iteration and then every 60 iterations (`iteration % 120 === 0` at 30 s polls = hourly), `try { const r = recoverInterruptedImports(db); if (r.recovered.length || r.quarantined.length) console.warn(`[import] recovery: rescheduled ${r.recovered.length}, quarantined ${r.quarantined.length}`); } catch (e) { console.warn(...) }`.

- [ ] **Step 4: Run** — `RUN_ONE tests/import-claim.test.ts tests/import-checkpoints.test.ts tests/phase5-guards.test.ts tests/runner-lease.test.ts tests/migrations-fail-closed.test.ts` → PASS; then `bash -lc 'npm test' | grep -E "^ℹ (pass|fail)"` → `fail 0`.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add lib/db.ts lib/import-jobs.ts lib/linkedin/runner.ts tests/import-claim.test.ts tests/import-checkpoints.test.ts
bash -lc 'git commit -q -m "C2-B1/PR-06: atomic import claim, per-page durable checkpoints under an owner fence, stall/cancel truthfulness, recovery and quarantine"'
```

---

### Task 7: Docs, gate, record

**Files:**
- Modify: `docs/operations.md` (single-process precondition section), `docs/production-readiness.md` (PR-06, PR-09 rows; checkpoint table; `## C2-B1 record (<date>)`)

- [ ] **Step 1: `docs/operations.md`** — in the single-process precondition section add: the runner lease (`app_settings.runner_lease`, TTL 120 s) now enforces it — a second process runs in standby (`/api/health` → `runner.lease.mine=false`, `runner.phase="standby"`); to clear a stuck lease after a confirmed-dead owner: `DELETE FROM app_settings WHERE key='runner_lease'`.

- [ ] **Step 2: Isolated gate** — `env PATH=/usr/bin:/bin /usr/bin/node scripts/c0-verify.mjs 2>&1 | tee /tmp/c2b1-gate.log | grep -E "^C0 (snapshot|isolation|RESULT|LINT|SUMMARY)|retained at"`; `grep -E "^# (pass|fail|skipped)" /tmp/c2b1-gate.log`. Expected: all `exitCode":0`, `gate: true`, `# fail 0`; count = 563 + 6 (R7) + new suites (record actual). Record the full 64-hex image id and snapshot hash.

- [ ] **Step 3: Host preflight** — `bash -lc 'bash scripts/preflight.sh'` → PASS; record counts.

- [ ] **Step 4: Register + record** — PR-09 → `**Observed (C2-B1 gate <date>)**: DB runner lease with standby and fenced track writes (`tests/runner-lease.test.ts`, `tests/health-lease.test.ts`); per-account browser owner with abortable max hold, no overlapping replacement; every context bypass migrated; busy browser reschedules the step (`tests/browser-ownership.test.ts`, `tests/runner-step-busy-browser.test.ts`). Verified with fake browser objects and one process — not with two real Chromium stacks. |`; PR-06 → `**Observed (C2-B1 gate <date>)**: atomic claim; per-page durable inserts + checkpoint under an owner fence; missing page never advances; stall/cancel truthful; stale running rows recovered from page+1 or quarantined after 3 (`tests/import-claim.test.ts`, `tests/import-checkpoints.test.ts`, `tests/scraper-checkpoints.test.ts`). Synthetic imports only — not live Sales Navigator. |`. Checkpoint table: C2-B1 implemented and gated on branch; C2 complete pending sign-off; C3 next (unauthorized). Append `## C2-B1 record (<date>)` with the standard fields; reviewer decision **Pending**.

- [ ] **Step 5: Commit (no push)**

```bash
git add docs/operations.md docs/production-readiness.md
bash -lc 'git commit -q -m "Docs: C2-B1 gate record; PR-06/PR-09 observed; lease documented in operations"'
```

---

## Self-review notes

- Spec §1 → Tasks 1–2; §2 → Tasks 3–4; §3 → Tasks 5–6; §4 → Task 7; §5 tests → Tasks 1–6; §6 → Task 7.
- Names consistent: `acquireRunnerLease`, `holdsRunnerLease`, `readRunnerLease`, `withLease`, `releaseRunnerLease`, `LeaseLostError`, `RUNNER_OWNER`; `acquireBrowserOwner`, `withBrowserOwner`, `tryWithBrowserOwner`, `browserOwnerState`, `setBrowserContextProvider`, `BrowserBusyError`, `PAGE_TEARDOWN_GAP_MS`; `claimScheduledImport`, `recoverInterruptedImports`, `runBatch(id, deps)`, `ImportOwnershipLostError`, `IMPORT_STALE_MS`; scraper `onPage`, `stalled`.
- Known plan-time uncertainties flagged for implementers: which existing suites need `acquireRunnerLease` in setup once verbs are fenced (Task 2 step 4); the visit branch's module dependencies for the busy-browser test (Task 4); exact `insertProfiles` profile shape (Task 6); `heartbeat_at` format vs cutoff comparison (Task 6, handled); whether `tests/health-endpoint.test.ts` does an exact key-set assertion (Task 2).
- Tasks 5 and 6 tests are specified by behaviour with named cases rather than full listings; implementers write them in the repo's harness style and the reviewer checks each named case exists and asserts DB state.
