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
