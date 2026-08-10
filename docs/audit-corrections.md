# Audit corrections

Corrections to the Phase 1 forensic audit, recorded in the repo so they outlive
the session that produced them. Each entry states what was claimed, what was
measured, and what changes as a result.

---

## F3 — RETRACTED. "SQLite has no `busy_timeout`" is false.

**Claimed:** `lib/db.ts` sets only `journal_mode` and `foreign_keys`; a repo-wide
grep for `busy_timeout` returned zero hits; therefore any second writer throws
`SQLITE_BUSY` immediately. Rated P1, "mandatory, one line".

**Measured:** `better-sqlite3` applies `busy_timeout` from its `timeout`
constructor option, which defaults to 5000 ms.

```
node_modules/better-sqlite3/lib/database.js:34
  const timeout = 'timeout' in options ? options.timeout : 5000;
```

Observed on v12.6.2:

| Connection | effective `busy_timeout` |
|---|---|
| `new Database(path)` | **5000** |
| `new Database(path, { timeout: 0 })` | 0 |
| `new Database(path, { timeout: 12345 })` | 12345 |
| `new Database(path, { readonly: true })` | **5000** |

Every connection in this repo, including read-only ones, has always had a 5 s
busy timeout. **F3 does not reproduce.**

**How it was caught:** not by review. The reproduction suite included a *control*
test asserting that contention without the pragma throws immediately. The control
failed — it waited 5 s instead. An assertion written to prove the lock was real
is what exposed that the finding was not.

**What shipped instead:** an explicit `db.pragma("busy_timeout = ${BUSY_TIMEOUT_MS}")`
pinned to the library's own default, so it remains a provable no-op, plus
regression tests. It is a guard against a future `{ timeout: 0 }` on a connection
opened elsewhere or a library default change — not a fix. Two mutations
demonstrate exactly that: removing the pragma alone changes no behaviour (the
library default still applies); removing it *and* passing `{ timeout: 0 }` fails
the guard test.

### Failure-matrix row corrected

| Row | Audit said | Correct |
|---|---|---|
| DB locked | "immediate `SQLITE_BUSY` throw 🔴, no retry" | Contention **under 5 s waits and succeeds**. Only contention exceeding 5 s raises, and it raises cleanly. |

### F1's trigger narrowed

F1 (duplicate message) is real and the fix is correct, but the audit overstated
one of its two triggers:

- `saveSessionState()` throwing after a delivered message remains the **primary
  and test-exercised** path (`lib/linkedin/session.ts:285` performs a live
  browser IPC via `ctx.storageState()`).
- The `SQLITE_BUSY` path on the `message_sent_at` write requires **more than 5 s
  of write contention**, so it is materially less likely than the audit implied.

The window is narrower than stated; it is not closed. The commit message for
`c7f7d47` overstates it in the same way and should be read with this correction.

---

## "Transaction held open across network work" — RETRACTED (earlier, same class)

**Claimed:** `lib/linkedin/sync-accepted.ts` holds a transaction across a
page-scraping loop, widening the `SQLITE_BUSY` window.

**Measured:** the transaction at `sync-accepted.ts:149` wraps a **pre-collected
array** and is fully synchronous. An automated scan found **zero** `await`
statements inside any `db.transaction()` callback repo-wide — which better-sqlite3
would reject anyway, since its transactions are synchronous by construction.

---

## The lesson these two share

Both retracted findings were **absence-based inferences from grep**: "the string
is not in the source, therefore the behaviour is not present." Neither measured
the behaviour. One of them survived two audit passes.

**Rule adopted for the remainder of Phase 1:** a finding must be reproduced by a
test that fails against unmodified code, *for the reason the finding claims*,
before any fix is written. If the reproduction passes, the finding is retracted
rather than fixed. This is why N4, N5 and F8 each carry a reproduction step.

**Extended after F8.** F8 was not an absence-based grep — it was a
reading-comprehension inference about control flow, and it was wrong in the same
way. Three audit claims have now been corrected by measurement, and in two of
them the stated mechanism was wrong while a real defect sat next to it. So the
rule is not "don't trust greps". It is:

> **Don't trust any finding whose mechanism has not been executed.**

---

## F8 — RECHARACTERISED, not retracted

**Claimed:** `globalLoop()`'s outer `.catch()` logs and stops the runner forever,
so an unexpected throw anywhere kills it while HTTP keeps serving.

**Measured.** Every `await` inside `while (true)` is already guarded:

| line | await | guarded? |
|---|---|---|
| `runner.ts:1279` | `tick(db)` | `try/catch`, logs and continues |
| `runner.ts:1284-5` | `import` + `processScheduledImports` | own `try/catch` |
| `runner.ts:1289` | `sleep(POLL_INTERVAL_MS)` | a `setTimeout` promise; cannot reject |

**A throw from inside `tick` does not stop the loop.** The audit's mechanism was
wrong.

The one reachable fatal path is `getDb()` at `runner.ts:1275` — inside
`globalLoop`, outside the `while`. Reachable via an unreadable or corrupt DB
file, or a missing `NEXTAUTH_SECRET` surfacing while migrating stored secrets.

**And the severity is worse than claimed in one respect:**
`g.__linkiGlobalRunnerStarted` is set *before* the failure and never reset, so
`ensureGlobalRunnerStarted()` is a permanent no-op afterwards. Verified: after
the fault is cleared, a second call performs zero `getDb()` calls. The runner
cannot be revived in-process by `POST /api/runs/[id]/start` or anything else —
only a process restart. Narrower than claimed on tick failures; worse than
claimed on recoverability.

---

## NF-4 — a permanently-throwing `tick` is invisible (not in the audit)

Because `tick` is wrapped inside `while (true)`, a tick that throws on *every*
iteration — persistent `SQLITE_CANTOPEN` inside tick, a browser that will not
launch, a plain code bug — leaves the loop spinning forever, logging, and
accomplishing nothing. Nothing surfaces it: the process is alive, HTTP serves,
and a loop-start heartbeat advances the whole time.

This is the real "wedged but alive" runner. The guard reset does nothing for it.
It is the failure the heartbeat actually earns its keep against, and it requires
distinguishing *loop liveness* from *tick completion* — one marker cannot express
it.

---

## NF-7 — the watchdog makes the per-process guard load-bearing

The runner's single-loop guard (`g.__linkiRunner`) is a **per-process** global.
Before Phase 2 that was a latent limitation: a second process meant a second loop
only if something started one. The P2-1 watchdog *actively re-establishes* loops
on a timer, so two processes now produce two loops **by default** — two Chromium
stacks on one LinkedIn account, duplicate outreach, and the deployment matrix's
"container duplication" row arriving by accident rather than by mistake.

Verified today: exactly one Node process (`next-server`, PID 20 under
`sh -c next start` under `npm start`), no cluster mode, no PM2, no child spawning,
no `replicas`/`scale` in compose. Recorded as a precondition in
`docs/operations.md` and beside the watchdog registration.

**Phase 3 candidate:** a cross-process lease — an `app_settings` row holding
owner + expiry, refreshed by the live loop and only claimable when stale, or an
advisory lock on the database. Not built now; the precondition is documented
instead.

---

## NF-6 — the loop reset has exactly one in-process caller, and it is operator-driven

M26 showed the `.finally` reset in `ensureGlobalRunnerStarted` is unreachable
while `runLoopWithRecovery` never resolves. Defence in depth, not a mechanism.

Callers of `ensureGlobalRunnerStarted()` in the process:

| Caller | When |
|---|---|
| `instrumentation.ts:6` | once per process, at boot |
| `pages/api/runs/[id]/start.ts:19` | whenever an operator starts a run |

So revival after a hard loop exit **is** possible in-process — but only if an
operator starts a run. Nothing polls, and `/api/health` deliberately does not:
it is read-only, and an unauthenticated endpoint must never be able to start
work.

**Therefore F8's claim is: in-process RETRY of the known fatal path (`getDb()`),
plus observability.** Not "automatic recovery". A loop exit outside the retry
path waits for an operator action or a process restart. A small authenticated
"revive" route, or reusing `runs/[id]/start`, is the Phase 2 candidate.

---

## F7 — the mechanism that keeps its severity unchanged

Terse phrasing ("read once but compensated") does not survive a reader. The
mechanism:

`connectsSentToday` / `messagesSentToday` are computed **once** per tick from the
`logs` table (`runner.ts:1436-1452`). The planning loop then walks every due
track and maintains `connectsPlanned` / `messagesPlanned`, gating each admission
on `sentToday + planned >= limit` and incrementing `planned` for every track it
admits (`runner.ts:1642`). **The stale read is corrected by the in-tick planned
counter**, so a tick that runs for an hour across ten tracks still cannot admit
more than `limit - sentToday` sends: admission is decided up front, in one pass,
before any step executes.

Two-line reproduction of the invariant:

```
limit 30, sentToday 28  ->  planned admits exactly 2 of N due connect tracks
                            (toReschedule receives the rest, before trClaim)
```

**Midnight straddle — stated explicitly.** A tick that begins at 23:58 UTC
allocates against the *old* day's count, and sends land after 00:00 on the new
day. Those sends are therefore not counted against the new day either, because
the next tick re-reads `logs` filtered by `date(created_at) = date('now')` and
the rows carry the new date. Net effect: a straddling tick can overshoot by at
most the slots it had already allocated (`limit - sentToday`), and never more —
it cannot allocate twice. This is bounded and is **not** the N6 defect. N6 is the
separate, larger problem that the cap window is UTC while the schedule window is
timezone-aware, so a non-UTC account whose working hours cross UTC midnight gets
two full allocations in one local working day.

F7's severity is unchanged: caps remain bypassable only by calling `executeStep`
directly, never by ordinary operation under load.

---

## NF-5 — `tick()` has no cap on due tracks

`tick()` executes every due track sequentially with no batch limit, so a single
tick's duration scales with workload: ~61 min at ten due tracks, unbounded in
principle. Consequences: liveness cannot be measured by tick completion (hence
per-step progress markers), and every tick-level activity queues behind a large
tick.

**Question raised for F7/N6, answered but deliberately NOT fixed in Phase 1:**
is the daily-cap counter re-read per track inside the loop, or once before it?

**Answered: read once, but compensated.** `connectsSentToday` /
`messagesSentToday` are computed once at `runner.ts:1436-1452`, before the
planning loop. However the planning loop maintains `connectsPlanned` /
`messagesPlanned` and gates on `sentToday + planned >= limit`
(`runner.ts:1642`), incrementing `planned` for every track it admits. So within
a single tick the cap **is** correctly enforced despite the stale read.

F7's severity is therefore **unchanged**: caps remain bypassable only by calling
`executeStep` directly, not by ordinary operation under load.

---

## F2 — rating rests on a recovery route that Task 3 removes

The audit downgraded F2 (a sent-but-unrecorded invitation permanently failing its
track) from P2-high to **P2 because a manual recovery path exists**: re-arm the
failed track via `POST /api/runs/[id]/retry`.

That justification is incomplete for the tracks that actually exhibit it. Both
`failed` tracks in the live database belong to **completed** runs, and:

- `tick()` selects only `status = 'running'` runs, so a re-armed track on a
  completed run is never picked up. Simulated on a copy of production data: after
  re-arming all failed tracks, `tick()`'s own queries returned **0 active runs,
  0 due tracks**. Re-arming there was always a silent no-op.
- The route that made recovery genuinely possible was therefore
  `PATCH /api/runs/[id]` setting `completed → running` — which is **N4**, the
  unvalidated status transition. **Task 3 closes it by design.**

**Net position after Task 3:** F2's residual divergence (LinkedIn shows pending,
DB shows `connection_requested_at = NULL`) is **inert** on a completed run —
nothing executes, so nothing duplicates — and **self-heals on re-enrolment**: a
new run's connect step hits `assertConnectable` → `PendingInviteError` →
`COALESCE(connection_requested_at)` with zero clicks.

No new feature is being added for this. If it ever matters operationally, the
Phase 2 fix is an operator-assertion stamp for `connect`, symmetric with the
`resolve: "mark_delivered"` added for messages in Task 1b.

---

## Standing correction to how findings are rated

Two of the audit's findings fell to measurement. Ratings derived from reading
code without executing it should be treated as hypotheses until a failing
reproduction exists. That applies to the findings still open (F4–F7, N3, N6, N7,
N8) as much as it did to F3.
