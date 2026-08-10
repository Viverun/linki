# Phase 1 baseline

Captured at commit `85934ab` on branch `linkedin-connection-reliability`, before
any Phase 1 change. Everything in Phase 1 is compared against these numbers; an
unexplained divergence is a stop-and-report event, not something to work around.

## Gates

| Gate | Baseline |
|---|---|
| `npx tsc --noEmit` | exit 0, **0 errors** |
| `npm test` | exit 0, **177 pass / 0 fail / 0 skipped** |
| `npm run build` | exit 0 |
| `npx eslint .` | exit 1, **40 problems (24 errors, 16 warnings)** — all pre-existing, none in scope |

## Test counts — track both separately

- **Local working tree: 177.**
- **Published tree: 151.**
- The 26-test difference is `tests/demo-harness.test.ts`, which is intentionally
  untracked because it depends on the intentionally untracked
  `scripts/demo-connect-message.ts`. Local = published + 26. Both numbers move
  independently and both must be stated when reporting a change.

### Per-file tripwires at baseline

| File | Top-level `test(` |
|---|---|
| `tests/slice-c-connection-state.test.ts` | 30 |
| `lib/linkedin/session.test.ts` | 15 |
| `tests/visit-degree-observation.test.ts` | 15 |
| `tests/runner-visit-degree.test.ts` | 13 |
| `lib/linkedin/connect.test.ts` | 11 |
| `tests/first-degree-detection.test.ts` | 11 |
| `tests/visit-topcard.test.ts` | 10 |
| `tests/enroll-scheduling.test.ts` | 9 |
| `tests/message-authorization.test.ts` | 8 |
| `tests/runner-claim.test.ts` | 8 |
| `tests/accounts-api.test.ts` | 5 |
| `tests/runner-connect-idempotence.test.ts` | 5 |
| *(untracked)* `tests/demo-harness.test.ts` | 26 |

### Coverage that did NOT exist at baseline

Confirmed zero at commit `85934ab`. These had no tripwire at all, so the tests
added in Phase 1 are the only thing standing between the change and a silent
regression:

- `pages/api/runs/[id]/retry.ts` — **0 tests**
- the runner's message step post-send sequence — **0 tests**
  (no test drove `step_type: "message"` through `executeStep`)
- `lib/db.ts` pragmas — **0 tests**
- `PATCH /api/runs/[id]` — **0 tests**
- `DELETE /api/workflows/[id]` — **0 tests**

## Database

| Property | Baseline |
|---|---|
| `data/linki.db` md5 | `3f9c2876bf30edf32957a62c27854816` |
| size / `-wal` / `-shm` | 335,872 B / 2,418,472 B / 32,768 B |
| `integrity_check` | ok |
| `foreign_key_check` | 0 violations |
| `user_version` | 0 (migrations are code-driven, not versioned) |
| `journal_mode` | wal |
| `wal_autocheckpoint` | 1000 pages @ 4096 B = 4 MB threshold |

Row counts: users 1 · accounts 1 · targets 5 · lists 4 · workflows 5 ·
workflow_steps 7 · runs 9 (7 completed / 2 paused) · run_profiles 9 ·
run_profile_tracks 9 (5 completed / 2 failed / 2 in_progress) · logs 40.

**Live LinkedIn state that must not change:** target `raise-faster` carries a
real pending invitation — `connection_requested_at = 2026-08-09T05:27:59.968Z`,
`degree = NULL`, `connected_at = NULL`.

### WAL size note

The 2.4 MB WAL against a 336 KB database is 590 pages against a 1000-page
auto-checkpoint threshold — it simply has not reached the threshold yet, so
SQLite has not recycled it. Nothing in the codebase performs an explicit
`wal_checkpoint`. This is normal bounded growth, but it is the input to Task 5:
adding a heartbeat write every 30 s raises the checkpoint frequency, and that
effect must be measured there rather than assumed.

## Pre-change backup

`data/backups/linki-prePhase1-20260809T155044Z.db` (md5
`125ea35efd0da516938503ab146b61d5`), created with `VACUUM INTO` and **opened to
verify**: `integrity_check = ok`, 5 targets, 9 runs, 9 tracks, 40 logs, live
invitation present. Covered by the existing `/data` gitignore rule.

This is an ad-hoc snapshot for this work only. A real backup/restore procedure
for `/data` remains an open gap.

## Timeout budget (D15)

Derived from the code's own timeouts. Two invariants depend on it, so changing
any of these numbers invalidates both.

| Phase | Source | Worst case |
|---|---|---|
| `gotoAuthenticated` | goto 30s + `settleAuthRedirect` 45s + 2.5s + settle 45s | **122.5 s** |
| `assertConnectable` + `openInviteDialog` | click 10s + dialog 10s + Send wait 20s | **40 s** |
| `verifyInvitationSent` | `gotoAuthenticated` again 122.5s + pending scrape ~60s | **182.5 s** |
| **One connect step** | sum of the above | **≈ 345 s** |
| `syncAcceptedConnections` | `MAX_PAGES=60` × (API + 0.9–1.6s gap) + nav 35s | **≈ 180 s** |
| `randomDelay` between tracks | `PROFILE_DELAY_MIN/MAX` 8–20 s | **20 s** |

### Invariant 1 — the 15-minute `trClaim` lease is the ceiling on a single step

`CLAIM_LEASE_MINUTES = 15` (900 s). Worst case 345 s sits comfortably under it
today. A step that could exceed the lease would let a second worker claim a track
mid-execution, which is the one thing `trClaim` exists to prevent. **Anyone
raising a Playwright timeout must check the new total against 900 s.** This is
also commented beside the timeout constants themselves.

### Invariant 2 — the 600 s liveness threshold is derived from this table

`LIVENESS_THRESHOLD_MS` in `pages/api/health.ts` covers the worst gap between
progress markers: one step (345 s) + `randomDelay` (20 s) ≈ 365 s, with ~64 %
margin. Changing a timeout above invalidates the threshold; the health route
cross-references back here.

### Why markers are per-step and not per-tick

`tick()` runs `for (const tr of toExecute) { await executeStep(...); await
randomDelay(...) }` with **no cap on due tracks** (NF-5), so tick duration scales
with workload — ~61 min at ten due tracks, unbounded in principle. A threshold
above an unbounded quantity is not slow detection, it is no detection: it cannot
distinguish a busy runner from a dead one. Per-step markers make staleness
independent of tick length.

## Standing test rule — multi-site coverage

Derived from two surviving mutants in Task 1 (M8, M16), both the same error: a
test covered **one** emission site of a code path that has **two**, so a mutation
to the uncovered site changed nothing observable.

> When a mutation targets code that runs at more than one call site, branch, or
> push, the test must exercise **every** site — or the mutation-table entry must
> name which sites are covered and why the others are unreachable.

Worked examples: `retry.ts` pushes outcomes from five places (non-ledger re-arm,
confirmed-advance, in-flight blocked, forced resend, mark_delivered), so a test
asserting a field on outcomes must hit more than one of them.
`stepRefOf` is called from both `runner.ts` and `retry.ts`.

## Reproduce-before-fixing rule

Two Phase 1 findings (F3, and the earlier "transaction across network work")
were retracted because both were absence-based inferences from grep rather than
measurements. See `docs/audit-corrections.md`.

> A finding must be reproduced by a test that fails against unmodified code, for
> the reason the finding claims, before any fix is written. If the reproduction
> passes, retract the finding instead of fixing it.

## `step_ref` scheme (Task 1)

`step_side_effects.step_ref` is a **scheme-prefixed identity**, currently
`"pos:<message_position>"`.

`workflow_steps.id` is deliberately **not** used: saving a campaign deletes every
step (`pages/workflows/[id].tsx`) and re-inserts it with a fresh `randomUUID()`
(`pages/api/workflows/[id]/steps.ts`), which would orphan every ledger row on any
workflow edit and silently disable the duplicate guard. `message_position` is
recomputed deterministically on save and is the identity a human means by
"follow-up #2".

The `"pos:"` prefix reserves room for `"stepid:<uuid>"` once steps gain stable
ids (the real fix for N3), so both schemes can coexist with no data migration.

---

# Phase 1 closure addenda

## Findings table — scope qualifiers travel with the row

| ID | Status |
|---|---|
| F1 | **CLOSED (OSS build) / PARTIAL (premium paths)** — Layer 2's body fingerprint cannot catch a position shift when the body is non-deterministic, i.e. the AI writer (`runner.ts:707-723`) or the random multi-template pick (`runner.ts:727`). Neither is reachable without `ee/` and templates, but anyone reading this row with `ee/` present must see the caveat here, not three sections away. Retired by Phase 2 item 3 (stable step ids ⇒ `step_ref` becomes `"stepid:<uuid>"`). |
| N1, N2, N4, N5 | CLOSED |
| F3 | RETRACTED |
| F8 | PARTIAL — in-process retry of the `getDb()` fatal path plus observability; nothing acts on the healthcheck without a supervisor (NF-6) |

## Test reconciliation — complete

| Commit | Tracked | Δ | Contents |
|---|---|---|---|
| `85934ab` | 151 | — | baseline |
| `c7f7d47` | 176 | +25 | message ledger |
| `a288f92` | 184 | +8 | fail-closed + mark_delivered |
| `2cd0814` | 192 | +8 | F3 retraction |
| `10e23f6` | 203 | +11 | run status (10) + D4.3 self-heal in an existing file (1) |
| `b965d04` | 209 | +6 | workflow delete guard |
| `ed49581` | 215 | +6 | resend + scoping |
| `4c40c9d` | 220 | +5 | db-init-atomicity (3) + runner-loop-survival (2) |
| `da52810` | **238** | +18 | health (9) + proxy (5) + runner-loop-survival D14/D13 (4) |

**238 tracked + 26 untracked (`demo-harness`) = 264**, matching `npm test`.

The 241 → 246 step after D7 was **+5, not +3**: `db-init-atomicity.test.ts` (3)
plus `runner-loop-survival.test.ts` (2). The earlier report said "three tests",
counting one file and not the other. Recorded because the phase's own rule is
that unreconciled arithmetic is a finding.

## Restart risk profile — verified, not assumed

`tick()` early-returns at `runner.ts:1428` (`if (activeRuns.length === 0) return`)
**before** the first `shouldSyncAccepted` call at `:1440`. Both runs in the
database are `paused` and zero runs are `running`.

**Therefore the restart performs no LinkedIn navigation at all.** It is a schema
migration and nothing else.

Two facts the checklist depends on:

- **An idle tick still writes its progress marker.** `recordProgress(db, "loop")`
  runs at iteration start, before `tick()`, so the marker advances every 30 s
  even with no running runs. `/api/health` therefore returns 200 on an idle
  instance — step 6 of the checklist is valid.
- **Both armed tracks sit on a `connect` step, not a message step**, and both
  targets already have `connection_requested_at` set (`zahidhamdule`
  2026-08-08T15:35:31Z; `raise-faster` 2026-08-09T05:27:59Z). If either run is
  resumed, the connect branch takes the DB-only "already requested" recheck path
  (`runner.ts:639-650`) and calls `trWait` — **no invitation is sent, no browser
  opens.** `prodqa-rf-track` is the production-QA execution from earlier in the
  session; it was never cleaned up because cleanup was never authorised.

## What a future reader should take from Phase 1

Of the most serious problems found in this phase, **three were created or exposed
by the remediation itself, not by the original audit**: the unconditional
`abandoned` classification, `resend` delivering nothing, and the poisoned
`getDb()` singleton that the planned F8 retry would have been built on top of.

That is the argument for the gates. Reproduce before fixing — three audit claims
were corrected by measurement, one of them a control-flow inference rather than a
grep. Write the negative-path test — five of five found a defect, two of which the
audit never saw.

## Phase 2 order

1. Supervisor acting on `dead` only, plus NF-6's missing automatic caller.
2. NF-4 degraded response — alert, not restart (D14).
3. **N3 + NF-1 stable step ids** — retires N3, NF-1, NF-3 and F1's premium caveat
   together, because `step_ref` migrates to `"stepid:<uuid>"` (the scheme prefix
   exists for exactly this).
4. `/data` backup/restore — the only irrecoverable failure in the system.
5. F4 signup disable — five lines against the P0-on-exposure.
6. N6 — must land *before* any non-UTC account is added, not after.
7. Then F7, F5, F6, N7, N8's remaining sites, and the lint sweep.
