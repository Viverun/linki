# Phases 0–5 — hardening record (2026-09-04)

Six workstreams against the production-readiness audit, on branch
`linkedin-connection-reliability`, base `4f4ea04`. Written after the last
commit, from the diffs — not from memory.

## Commits

| Commit | Phase | Subject |
|---|---|---|
| `1964a38` | 0+1 | fail-closed SSR page guard; todos/activity-logs routes; partial-update, duplicate and run-lifecycle fixes |
| `8abe779` | 2 | shared API guards; paging/FK crash fixes; 404/409 normalization; 405+Allow sweep; remove hello scaffold |
| `ca26ffa` | 3 | InMail side-effect ledger; LIKE escaping; id-list caps; FK 404s; secret-migration report; central email TLS decision |
| `e4da0e3` | 4 | target URL shape validation; run-create FK guards; LIKE escaping; id-list caps; safe lint-subset fixes |
| `e32bee5` | 5 | import-cancel 409; integration slug + tour allowlist; 404s; InMail mark_delivered; tour leaf split |

## Gates across the work

| Point | `tsc` | Tests | `lint` | `next build` |
|---|---|---|---|---|
| base `4f4ea04` | 0 errors | 403 pass | 40 problems (24 err / 16 warn) | pass |
| after 0+1 | 0 | 407 | 40, no new hits | pass |
| after 2 | 0 | 424 | 40, no new hits | pass |
| after 3 | 0 | 448 | 40, no new hits | pass |
| after 4 | 0 | 453 | **34** (21/13), no new hits | pass |
| after 5 | 0 | 458 | 34, no new hits | pass |

Every commit passed the pre-commit preflight (`tsc`, full suite, lint ≤
baseline) before it was created.

## Phase 0 — SSR pages served PII unauthenticated (HIGH, fixed)

All nine `getServerSideProps` (`settings`, `contacts/index`, `contacts/[id]`,
`companies/index`, `companies/[id]`, `lists/index`, `lists/[id]`,
`workflows/index`, `workflows/[id]`) queried the DB directly and embedded rows
in SSR HTML. `proxy.ts` gates `/api/*` only; the `AuthGuard` in `pages/_app.tsx`
is client-side. `curl <page>` returned data.

Fix: new `lib/page-auth.ts` (`requirePageSession`, fail-closed redirect to
`/login`), called first in all nine, via `getToken` — the same question
`lib/auth.ts` asks the edge gate — rather than `getServerSession +
authOptions`, whose `[...nextauth]` import chain is unloadable under plain
`node:test`. Proven live (temp DB, `next start`): seven SSR routes → `307
/login` unauthenticated, including unknown ids (no oracle); `/login` stays
`200`. Tests: `tests/ssr-auth.test.ts` (3 behavioral + 1 tripwire asserting the
guard precedes `getDb()` in all nine pages).

## Phase 1 — missing routes and run lifecycle

- **New routes** `POST /api/todos`, `PATCH/DELETE /api/todos/[id]`,
  `POST/PATCH/DELETE /api/activity-logs` (`?id=` per the UI contract). The
  contact page did full CRUD against them; every save 404'd. Tables predated
  the routes. Premium-gated calls (inbox reclassify/backfill,
  `openrouter/models`, `agent/preview`) were deliberately left: their buttons
  render only when `hasPremium`, and ee/ is absent here — not contract bugs.
- **PUT wipe:** `companies/[id]` and `steps/[stepId]` wrote `field ?? null`
  for every column, nulling anything a partial update omitted. Now only keys
  present in the body are written (explicit null still clears), mirroring the
  workflows-prompt precedent. `email-accounts/[id]` got the same treatment in
  Phase 2 (`from_name/reply_to/imap_host/imap_username/signature` → COALESCE).
- **Duplicate** dropped the campaign `prompt` and the step
  `track`/`email_signature`/`enabled`, and ran outside a transaction. All
  preserved now, wrapped in one.
- **Run lifecycle:** `start` 409s `completed` (was resurrecting finished
  campaigns, defeating the PATCH terminal guard); `enroll` 409s non-live runs;
  `remove` validates strictly, 404s, and clears orphaned `logs` in a
  transaction; `runs DELETE` 409s live runs + 404s; `lists DELETE`
  transactional + 404s. `targets DELETE` was **not** changed — see §7.

## Phase 2 — shared guards and status normalization

- New `lib/api-validate.ts`: `methodNotAllowed` (405+Allow),
  `isStringArray`, `pageParams` (clamped ints — `page=abc/limit=-5` reached
  SQL as NaN/negative → 500).
- `runs POST`: FK existence 404s + `workflow_already_active` 400 → **409**.
  Missing-account 400 → **404** on import/apollo-enrich/sync-status
  (present-but-unauthed stays 400). DELETE/PUT 404s on email-accounts,
  templates, accounts.
- 405+Allow sweep over all 28 routes missing the header (mechanical; one
  broke on a multi-line import, fixed). Deleted the `hello.ts` scaffold (zero
  callers) — which broke the Y4 corpus test (it enumerates `git ls-files`;
  fixed with `git rm`) — and completed one test mock (`setHeader`) that the
  sweep exposed.

## Phase 3 — the last F1-class defect and input hardening

- **InMail ledger** (`runner.ts` sales_inmail branch): the `step_side_effects`
  table already allowed `'inmail'`, but the branch never wrote one — a crash
  between send and `inmail_sent_at` retried the send. Full Layer-1/Layer-2
  flow mirrored from `message` (subject+body fingerprint), including `.catch`
  on `page.close`/`saveSessionState`, where a post-delivery throw used to fail
  the step into a resend. `tests/inmail-idempotency.test.ts` (5 tests).
  Untestable without stubbing `premium.inmail` at the `lib/premium` boundary
  (ee/ absent) — that stub is what makes the branch reachable in tests.
- **LIKE escaping** (`escapeLike` + `ESCAPE '\'`) on companies search,
  targets search, remove-members patterns. **Id-list caps** (500) +
  **unknown-id filtering** on add-members/enroll/move-targets/remove.
- **Plaintext secrets:** passthrough kept (migration-covered), but the
  migration now counts encrypted rows and warns on leftovers — the silent case
  is observable. **TLS:** `rejectUnauthorized:false` kept for corp-server
  compat, centralized in `lib/email/tls.ts` with a tripwire test failing on
  any new inline occurrence.

## Phase 4 — boundary validation

- `POST /api/targets` rejects null-vanity, foreign-host and non-URL values
  via `profileVanityOf()` (new leaf in `lib/linkedin-url.ts`: host allowlist
  composed with the vanity expression, so the route validates without
  importing the browser graph) — closing the N7b production path (manual
  contact creation was the unguarded one; CSV already validated). Unknown
  `list_id` → 404 (was silently ignored). Explicit unknown `target_ids` on
  run create → 400 (was an FK-throw 500 after half-creating the run).
- Lint subset, zero-risk only: `prefer-const`, dead interface/import
  removals, `any`→proper types in the two local-only diag scripts. 40 → 34.
  Hooks rules in giant pages, CJS `require`s, and anything touching behavior
  were left alone.

## Phase 5 — papercuts and the InMail operator stamp

- Import cancel 409s terminal imports (was lying `ok:true`). Integration keys
  must be short slugs (a closed allowlist would freeze out future ee/ keys).
  Tour pages validated against `ALL_TOUR_PAGES` — which required extracting
  the ids to leaf `lib/tour-pages.ts`, because `lib/tour.ts` is `"use client"`
  with a CSS import that crashes `node:test`. 404s on workflows PATCH and
  companies DELETE.
- `retry mark_delivered` extended to InMail (stamps both sent-at columns,
  advances) — the symmetric operator stamp the F2 note anticipated. Two
  `retry-ledger` assertions that pinned the old inmail-blocked behavior were
  rewritten to the new intended behavior, not deleted.

## Deliberately not changed

- Premium-gated UI calls with no open-core route (inbox reclassify/backfill,
  openrouter/agent) — unreachable without ee/, hidden by `hasPremium`.
- `targets DELETE` cascade gaps the audit claimed — refuted against schema
  (`list_targets`/`todos`/`activity_logs`/`email_replies` are all
  `ON DELETE CASCADE`); no change made.
- `unenroll` on terminal runs — already an honest 404 via zero-changes.
- Legacy `pos:` ledger reads — load-bearing for pre-switch rows.
- `POST /api/targets` still requires `linkedin_url` (email-only contacts go
  through CSV) — a contract decision of its own, not a defect fix.
- Create-vs-enroll empty-result inconsistency (400 vs 200) — changing either
  side moves UI behavior; left for an operator request.
- Lint remainder (21/13) — behavior-risky churn in giant pages; documented,
  not attempted.

## Corrections to the earlier audit, found by doing the work

1. "Targets DELETE misses list_targets/activity_logs/email_replies" — wrong;
   cascades cover all three (§Phase 1).
2. "deleteSelected is dead code" — wrong; it is live and calls the DELETE
   route Phase 4 hardened.
3. "Third host expression unknown" — the drift tripwire plus `rg` show
   `isAllowedLinkedinUrl` (leaf) and `isLoggedInAppUrl` (post-navigation,
   different question); consolidation deferred, not missing.
4. Mode-only worktree noise (`100644→100755`, 173 files) was reverted before
   the first commit so history holds content only; the 17 files touched by
   Phases 0–1 carry the worktree's 755 bit (matches surrounding convention,
   not introduced by the edits).

## Operator-visible behavior changes

- Unauthenticated page visits now redirect to `/login` (were serving data).
- Malformed LinkedIn URLs are rejected at contact creation with a 400
  explaining the expected shape.
- Retrying/completing/deleting runs, cancelling imports, and deleting
  lists/templates/accounts/lists-targets now fail loudly (404/409) where
  they previously succeeded silently or crashed to 500.
- A duplicate campaign now actually duplicates (prompt, track, signature,
  enabled flag).
- `mark_delivered` works for InMail tracks.
- Import cancel on a finished import, oversized id lists (>500), unknown
  tour pages, and non-slug integration keys are refused with reasons.

## Residual risks (not worked)

- Merge toward `main`/`upstream` — review-sized decision, not taken here.
- Deploy verification on a live container (the Phase-0 live-server proof ran
  against a temp DB, not production data).
- The `pos:` legacy read path has no production rows (D-7) but also no
  expiry plan.
