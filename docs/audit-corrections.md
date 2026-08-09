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
