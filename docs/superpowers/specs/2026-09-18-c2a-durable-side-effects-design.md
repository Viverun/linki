# C2-A — Durable side effects and atomic writes

Date: 2026-09-18. Phase: C2 (first of two sub-projects; C2-B covers PR-09, PR-06, PR-03).
Register: `docs/production-readiness.md` rows PR-02, PR-12, PR-11, PR-04.
Authorized by the C1 sign-off recorded there.

## Goal

After any crash, lock error, or post-action bookkeeping failure, the database can
answer "did this already happen?" for every irreversible action the runner takes,
and every multi-row write is either fully applied or absent. Concretely:

- An automated email is never sent twice by an ordinary retry; ambiguous delivery
  is held for explicit operator resolution (PR-02).
- Retry acts on the step the runner would run, resolved by stable identity, or
  blocks explicitly — it never substitutes a step by index (PR-12).
- Run creation leaves zero rows on any failure and is atomic on success (PR-11).
- A non-duplicate migration failure stops startup visibly and never publishes a
  half-initialised connection; the next start resumes from the same state (PR-04).

Non-goals: delivery confirmation beyond SMTP transport acceptance (bounce
detection stays as is); LinkedIn ownership/leasing (C2-B); UI redesign.

## 1. PR-02 — email joins the side-effect ledger

### Ledger schema

`step_side_effects.action` widens from `('message','inmail')` to
`('message','inmail','email')`. SQLite cannot alter a CHECK constraint, so:

- Fresh databases get the widened `CREATE TABLE IF NOT EXISTS` directly.
- Existing databases are detected by `sqlite_master.sql` for `step_side_effects`
  lacking the literal `'email'`; they are rebuilt: `CREATE TABLE
  step_side_effects_new (...)`, `INSERT INTO ... SELECT ...`, `DROP TABLE`,
  `ALTER TABLE ... RENAME`, then both indexes recreated. This runs inside the
  transactional migration loop from §4, so a failure leaves the old table intact.

No other columns change. `step_ref` keeps the `stepid:<uuid>` scheme with the
`pos:<n>` legacy fallback; `body_fingerprint` for email is the sha256 of
`subject + "\n\n" + finalBody` after the same whitespace normalisation as
`bodyFingerprint`.

### Sender contract (`lib/email/sender.ts`)

```ts
export interface SendResult { accepted: string[]; rejected: string[]; messageId: string | null }
export async function sendEmail(account, to, subject, body): Promise<SendResult>
export type SmtpFailureClass = "pre_send" | "rejected" | "ambiguous";
export function classifySmtpFailure(err: unknown): SmtpFailureClass
```

`sendEmail` returns nodemailer's `info` fields; it no longer returns `void`.
Callers other than the runner (`send-test`, tests) ignore the result.

`classifySmtpFailure` reads nodemailer's error metadata (`code`, `command`,
`responseCode`) and this repo's own pre-connection errors:

| Class | Condition | Ledger outcome |
| --- | --- | --- |
| `pre_send` | `command` in `CONN`, `EHLO`, `STARTTLS`, `AUTH`, `MAIL FROM`, `RCPT TO`, `API`; or `code` in `EAUTH`, `EENVELOPE`, `ECONNECTION` **with** a pre-`DATA` command; or a TLS policy error raised by `lib/email/tls.ts` (identity/trust/expiry) | `abandoned` — ordinary retry re-arms |
| `rejected` | `command === "DATA"` and a numeric `responseCode >= 400` (the server answered and refused the body; includes nodemailer's `EMESSAGE` "Message failed" cases) | `abandoned` — ordinary retry re-arms |
| `ambiguous` | `command === "DATA"` with no response code (`ETIMEDOUT`, `ESOCKET`, `ECONNECTION`, connection closed); any error without recognised metadata; any non-Error throw | stays `in_flight` — retry blocks until an operator resolves |

Default is `ambiguous`: unknown means possibly delivered.

A resolved `sendMail` whose `accepted` does not include the recipient (all
recipients rejected without a throw) is treated as `rejected`.

### Runner email step (`lib/linkedin/runner.ts`)

Mirrors the message step exactly, in this order:

1. Existing pre-checks (body present, account present, daily limit) unchanged and
   still before any ledger write.
2. `stepRef = stepRefOf(step)`, `legacyRef = legacyStepRefOf(step)`,
   `fingerprint = bodyFingerprint(subject + "\n\n" + finalBody)`.
3. `sideEffectFor(..., "email", legacyRef)`:
   - `confirmed` → finish bookkeeping (`trRecordContext`, `trAdvance`), log
     "already delivered — skipping send", return.
   - `in_flight` → throw `UnresolvedSideEffectError` (track fails with the
     ledger reason; retry will block).
   - `conflictingFingerprint` hit → throw `UnresolvedSideEffectError`.
4. `sideEffectBegin(db, tr, stepRef, "email", fingerprint)` — committed before
   the send.
5. `sendEmail(...)`. On throw: `classifySmtpFailure(err)`; `pre_send`/`rejected`
   → set `abandoned` with the error message; `ambiguous` → keep `in_flight`, set
   `error_message = "left in_flight — may have been delivered: ..."`, log a
   `warn`. Then rethrow (existing catch → `trFail`).
6. On resolve: if the recipient is not in `accepted` → treat as `rejected`
   (abandoned, `trFail` with the rejection). Otherwise, inside one transaction,
   set `confirmed` + `confirmed_at`; then `trRecordContext`, `trAdvance`, log
   "Email sent". Bookkeeping failures after `confirmed` are logged as
   `error` ("WAS delivered but bookkeeping failed") and never rethrown.

The daily-limit ground-truth query (`logs.message LIKE 'Email sent%'`) is
unchanged; a confirmed ledger row whose "Email sent" log never landed is at most
one message under-counted, which is the safe direction.

### Retry (`pages/api/runs/[id]/retry.ts`)

`action` mapping gains `email` → `"email"`. Every branch that today says
"message/InMail" (`mark_delivered` allowed set, error strings) includes email.
`mark_delivered` on an email row stamps `confirmed` with `OPERATOR_ASSERTION`
and advances. There is no `targets.*_sent_at` column for email and none is
added: the ledger row is the record (the message/InMail branches keep their
existing `message_sent_at`/`inmail_sent_at` stamps). `resend` marks
the row `abandoned` with `OPERATOR_FORCED_RESEND` and re-arms, as for messages.

UI: `pages/workflows/[id].tsx` `retryProspect(runId, targetId, resolve?)` already
sends `resolve`; the only change is that the buttons offering `mark_delivered`/
`resend` show for email steps too (widen the step-type predicate that gates
them). No new components.

## 2. PR-12 — retry resolves by identity

`retry.ts` replaces

```ts
const step = (c.current_step_id && steps.find(x => x.id === c.current_step_id)) || steps[c.current_step];
```

with `resolveStep({ current_step, current_step_id, ... }, steps)` imported from
`lib/linkedin/runner.ts` (already exported):

| Resolution | Retry outcome |
| --- | --- |
| `deleted` | `blocked`, reason "the step this track was pinned to no longer exists — edit the campaign to restore it, or unenroll" |
| `done` | `blocked`, reason "track is past the last step" |
| `resolved` | proceed with `{ step, index }` |

All subsequent uses of `c.current_step` inside the loop use the resolved `index`
instead: `advance.run(index + 1, stepIdAt(..., index + 1), c.id)`. The plain
`rearm` for a track whose `current_step_id` is NULL additionally pins
`current_step_id = step.id` (and `current_step = index`) so the row stops being
legacy. Ledger lookups use `stepRefOf(step)` from the resolved step, as today.

`resolveStep` itself is unchanged; a legacy NULL-id row resolves by index in both
runner and retry, so the two can never disagree.

## 3. PR-11 — atomic run creation

`pages/api/runs/index.ts` POST is restructured into: **validate → compute →
write**.

- Validate (no writes): body shape, `idListError`, workflow/list/account
  existence (existing FK guards), unknown `target_ids`, active-run 409.
- Compute (reads only): candidates, `alreadyEnrolled`, `activeElsewhere`,
  filtered `targets`, `emailAssignment`, `workflowTracks`, `firstStepIdFor`.
  `targets.length === 0` → 400 `all_already_enrolled` **before** any insert.
- Write: a single `db.transaction(() => { insert run; for each target insert
  profile + tracks })` invoked with `.immediate()`. The active-run check is
  re-executed inside the transaction (cheap `SELECT`) and throws a typed
  `WorkflowAlreadyActiveError` → 409, so two concurrent creates serialise on the
  write lock and the loser gets the contract response instead of a second run.

The `DELETE FROM runs WHERE id = ?` cleanup disappears. Any throw inside the
transaction (including an injected child-insert failure) rolls back everything;
the handler's existing error path returns 500 with zero new rows.

## 4. PR-04 — migrations fail closed

`runMigrations(db)` in `lib/db.ts`:

```ts
const isAlreadyApplied = (err: unknown) =>
  err instanceof Error && /duplicate column name|already exists/i.test(err.message);
db.transaction(() => {
  for (const sql of migrations) {
    try { db.exec(sql); } catch (err) { if (!isAlreadyApplied(err)) throw err; }
  }
  rebuildStepSideEffectsIfNeeded(db); // §1, same transaction
}).immediate();
```

- Duplicate-column / already-exists errors are the only tolerated class.
- Any other error propagates out of `initialiseConnection`; `getDb()` already
  closes the orphan handle and leaves the singleton unset, so the process fails
  loudly (API 500s, runner does not start) and a later `getDb()` re-runs from an
  unchanged schema.
- The transaction is `IMMEDIATE` so a concurrent reader cannot observe a
  half-migrated schema and a lock error surfaces as a real error (it is not in
  the tolerated class) instead of being swallowed.
- `initDb` (the `CREATE TABLE IF NOT EXISTS` block) is unchanged; the
  `session_version` guard added in C1 stays as is.

## 5. Tests

All tests use a temp `LINKI_DB_PATH`, mocked browser/session modules, and a
mocked or loopback transport. No network, no real provider.

| File | Covers |
| --- | --- |
| `tests/email-idempotency.test.ts` | Runner email step through `executeStep` with `sendEmail` mocked and every send recorded: pre-send throw → `abandoned`, retry re-arms, exactly one later send; ambiguous throw → `in_flight`, retry `blocked`, `mark_delivered` advances with zero sends, `resend` sends exactly once more; explicit reject → `abandoned`; `accepted` missing recipient → `abandoned`; bookkeeping failure after acceptance → row `confirmed`, retry `advanced`, zero second send; identical subject+body under a renumbered step → refused. |
| `tests/smtp-failure-classification.test.ts` | Table-driven `classifySmtpFailure` over nodemailer error shapes (each command × code × responseCode, plus non-Error, plus TLS policy errors); live loopback SMTP via `tests/support/mail-tls-fixture.ts` extended with two behaviours: drop socket after `DATA` (→ `ambiguous`) and reply `554` to the body (→ `rejected`). |
| `tests/retry-step-identity.test.ts` | Pinned step reordered → resolved by id, `advance` uses resolved index; pinned step deleted → `blocked`, no ledger read, no re-arm; legacy NULL-id row → resolved by index and pinned on re-arm; message ledger rows still block after reorder. |
| `tests/run-create-atomic.test.ts` | Counts of `runs`, `run_profiles`, `run_profile_tracks` before/after: unknown target id → 400 and counts unchanged; all-enrolled → 400 and unchanged; injected failure in track insert (mock `randomUUID` to throw on the Nth call, or a trigger) → 500 and unchanged; success → exactly N profiles and the expected tracks; two sequential creates for one workflow → second is 409 with no new rows. |
| `tests/migrations-fail-closed.test.ts` | Fresh DB vs synthetic pre-`'email'` ledger schema converge to identical `sqlite_master` for `step_side_effects` and indexes with rows preserved; inject a failing migration (append a bad statement via a test hook `__setExtraMigrationsForTest`) → `getDb()` throws, second `getDb()` throws again (no cached handle), removing the fault → succeeds; a `duplicate column name` error alone → tolerated. |

Existing suites `tests/retry-ledger.test.ts`, `tests/step-identity.test.ts`,
`tests/message-idempotency.test.ts`, `tests/inmail-idempotency.test.ts` must keep
passing unchanged; they are the regression net for the shared ledger helpers.

## 6. Acceptance and evidence

C2-A is accepted when: the five new suites pass; the isolated Node 22 gate
(`npm run verify:c0`, lint mandatory) exits 0; host preflight passes; and a C2-A
record is appended to `docs/production-readiness.md` with the register rows
PR-02/PR-12/PR-11/PR-04 moved to **Observed** with their acceptance boundaries
(transport acceptance ≠ delivery; single-process retry contract; migration
convergence measured on synthetic schemas only).

## Out of scope / deferred to C2-B

Worker lease and browser ownership (PR-09), import checkpoint truthfulness
(PR-06), open-core reply suppression (PR-03).
