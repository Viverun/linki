# C2-B2 — Reply hold and open-core out-of-office policy

Date: 2026-09-18. Phase: C2 (sub-project B2; B1 = PR-09/PR-06 follows).
Register: `docs/production-readiness.md` row PR-03. Authorized by the C1 sign-off.
Depends on C2-A (merged at `12f3953`): the email side-effect ledger is unchanged by this spec.

## Goal

A captured human email reply stops automated follow-ups **before the next send**,
in the open-core build as well as the premium one; a capture or classifier failure
can never silently authorize another send; the open-core out-of-office policy is
explicit, and the open-core LinkedIn limitation is visible.

Non-goals: LinkedIn reply detection in open-core (premium-only, stays so); any
change inside `ee/` (not in this repository); sentiment buckets beyond
"auto-reply vs a person answered".

## 1. Hold semantics

**Definition.** For a target, a reply is *undecided* when an `email_replies` row
exists with `dispatched_at IS NULL`. A decision is any write that sets
`dispatched_at` (premium's dispatcher, the open-core policy in §2, or an operator
action in §3). `targets.email_replied_at` keeps its meaning: *a person replied;
stop this contact's automation*.

**Runner** (`lib/linkedin/runner.ts`, the reply check at the top of `executeStep`,
today ~line 1017):

```
if targets.last_replied_at or targets.email_replied_at   → (unchanged) skip all
   tracks of the run_profile with 'Lead replied'
else if exists email_replies r where r.target_id = target.id and r.dispatched_at is null
                                                       → HOLD: trWait(db, tr, 1)
   and log "reply from <email> awaiting decision — holding <track> track"
else                                                   → proceed
```

The hold is applied to whichever track is executing (LinkedIn or email) — an
undecided email reply holds both channels, because a person who answered by
email must not receive a LinkedIn follow-up either. Hold is not terminal: a
later decision either lifts it (`ooo_continue`, `operator_continue`) or converts it
into the existing skip (`email_replied_at` stamped).

Premium behaviour is unchanged: its dispatcher already sets `dispatched_at`
(and `email_replied_at` for its skip buckets, `pending_reply_context` for OOO).
What changes for premium is only that a classifier failure (row left undecided)
now holds instead of continuing — which is the acceptance requirement.

## 2. Open-core reply policy

New module `lib/email/reply-policy.ts`. Invoked from `lib/email/inbox.ts` at the
point where `premium.replies.classifyAndDispatch(replyId)` is called today:

```ts
if (premium?.replies) await premium.replies.classifyAndDispatch(replyId);
else await decideReplyOpenCore(db, replyId);           // §2
```

and, once per inbox sync, `await retryUndecidedReplies(db)` (open-core only) so
replies whose judgment failed are retried on later ticks.

### 2.1 Judgment (TypeSafe / Jev)

State sent (JSON, named fields):

```json
{
  "reply": { "from": "...", "subject": "...", "body": "<body_text, first 4000 chars>", "received_at": "..." },
  "our_last_email": { "subject": "...", "body": "..." } | null,
  "today": "YYYY-MM-DD"
}
```

`our_last_email` comes from the email track of the reply's `run_id` for this target
(`run_profile_tracks.last_email_subject/last_email_body`), else `null`.

Questions (one `systemOne` request, fan-out):

- `is_auto_reply` — **Noul**. Instructions: "`reply` is an automatic
  out-of-office or auto-responder notice generated because the recipient is
  away, not a message a person wrote in response to `our_last_email`."
  Criteria `true`: "Vacation, leave, out-of-office, 'I am currently away',
  'limited access to email', auto-generated acknowledgement with a return date or
  alternative contact." Criteria `false`: "Anything a person typed as a response —
  including a one-line 'not interested', 'stop emailing me', a question, a
  forward to a colleague, or a delivery/bounce notice."
- `return_date` — **Choice**, only when code finds ≥ 1 candidate. Candidates are
  the date-like spans code extracts from the body (ISO dates, `12 March`,
  `March 12(th)`, `12/03/2026`, `Monday 3rd` forms; at most 8), plus `none`.
  Instructions: "Which candidate is the date the sender says they will be back
  or resume reading email? Choose `none` if no return date is stated." Code
  parses the chosen span into a date relative to `today`; unparseable → treated
  as `none`.

Client: `@typesafe-ai/sdk` `TypeSafeClient({ apiKey, timeout: 10_000 })` built per
call from the decrypted `integrations.key = 'typesafe'` row. Model: the client
default (`jev-latest`); the model id returned by the API is recorded in the
decision. No API key configured → judgment error (handled below), not a crash.

### 2.2 Policy (code, not the model)

Threshold `reply_ooo_threshold` in `app_settings` (default **0.9**; valid range
0.5–0.99). Decision table:

| Condition | Decision | Writes |
| --- | --- | --- |
| `noul(is_auto_reply) ≥ threshold` | `ooo_continue` | `dispatched_at = now`, `dispatch_result_json`; if `return_date` chosen with `confidence ≥ 0.7` and parses to a future date: for the email track(s) of the reply's run for this target that are `in_progress`/`pending`, `next_step_at = max(next_step_at, return_date + 1 day 09:00 UTC)`; `activity_logs` entry "Out-of-office reply — follow-up continues after <date|unchanged schedule>" |
| `noul(is_auto_reply) < threshold` | `human_reply` | `dispatched_at = now`, `dispatch_result_json`; `targets.email_replied_at = COALESCE(email_replied_at, now)`; `activity_logs` entry "Reply received — follow-ups stopped" |
| SDK/network/auth error, missing key, malformed answer | *undecided* (no `dispatched_at`), `classification_error = <message>`, `open_core_attempts += 1` | held by §1; retried by `retryUndecidedReplies` on later syncs |
| `open_core_attempts ≥ 3` and still undecided | `human_reply` with `reason: "judgment failed 3 times — failing closed"` | as `human_reply` |

`dispatch_result_json` shape (open-core):
`{ "source": "open-core", "decision": "ooo_continue" | "human_reply" | "operator_continue", "p_ooo": 0.97, "threshold": 0.9, "model": "jev-...", "return_date": "2026-10-02" | null, "attempts": 1, "reason"?: "..." }`.
`classification_json` is written as `{ "kind": "out_of_office" | "human_reply", "summary": "<one line>" }` so the existing inbox UI (`reply_kind`) renders it like premium's.

Schema: `ALTER TABLE email_replies ADD COLUMN open_core_attempts INTEGER NOT NULL DEFAULT 0` (in `migrations[]`, tolerated as duplicate on re-run per C2-A).

### 2.3 Idempotency and ordering

- The policy runs inside one `db.transaction(...).immediate()` per reply after the
  judgment returns; the judgment itself (network) runs outside any transaction.
- `decideReplyOpenCore` first re-reads the row and returns immediately if
  `dispatched_at` is already set (an operator may have acted while the judgment
  was in flight); operator decisions win over model decisions.
- No send is ever triggered by this module; it only records decisions and adjusts
  `next_step_at`/`email_replied_at`. The runner's ledger (C2-A) remains the only
  path to a send.

## 3. Operator controls

- **`POST /api/inbox/[replyId]/resume-followup`** (mirror of `cancel-followup`):
  404 if the reply is unknown; sets `dispatched_at = now` and
  `dispatch_result_json = { source: "open-core", decision: "operator_continue" }`
  (only if `dispatched_at` was null or the prior decision was `human_reply`),
  clears `targets.email_replied_at`, re-arms this run's email and LinkedIn tracks
  for the target that are `skipped` with `error_message = 'Lead replied'` back to
  `in_progress` with `next_step_at = NULL`, writes an `activity_logs` entry
  "Follow-ups resumed from inbox". Returns `{ ok: true, rearmed: <n> }`.
- **Inbox page** (`pages/inbox.tsx`): a "Resume follow-ups" button next to the
  existing "Cancel follow-up", shown when the reply's decision is `human_reply`
  or the contact has `email_replied_at`; the decision line shows
  `out of office (p=0.97)` / `person replied` / `awaiting decision` / `operator: …`.
- **Settings → Integrations**: add `{ key: "typesafe", label: "TypeSafe (Jev)",
  help: "Open-core out-of-office detection for email replies" }` to the
  integrations list; it uses the existing encrypted `integrations` storage and
  the existing `POST /api/integrations` slug rule. **Settings → General**: a
  numeric field for `reply_ooo_threshold` backed by a new
  `GET/PUT /api/settings/reply-policy` route (same shape as `import-cap`).

## 4. Visible open-core LinkedIn limit

- `GET /api/premium-status` returns `{ hasPremium, capabilities: {
  linkedinReplyDetection: hasPremium, emailReplyClassification: hasPremium ? "premium" : "open-core" } }`.
- Inbox page and campaign detail page render, when `linkedinReplyDetection` is
  false, one line: "LinkedIn replies are not detected in this build. LinkedIn
  follow-ups stop only when you unenroll the contact or an email reply is
  received."
- Runner logs once per run start (`runs/[id]/start` path): "LinkedIn reply
  detection unavailable in this build — LinkedIn follow-ups are not auto-stopped".

## 5. Dependency

`@typesafe-ai/sdk` **0.6.0** exact, added to `dependencies`. Resolution per the
PR-10 discipline: `npm install --package-lock-only --ignore-scripts --no-audit
--no-fund --strict-peer-deps`, then `npm audit --package-lock-only
--ignore-scripts --json` full and `--omit=dev` both recorded (expected 0/0; the
package has no dependencies and requires Node ≥ 20). Imported only by
`lib/email/reply-policy.ts`.

## 6. Tests (synthetic, temp DB, no network)

| File | Proves |
| --- | --- |
| `tests/reply-hold.test.ts` | Runner through `executeStep` with mocked send: undecided reply → `trWait` (track `in_progress`, `next_step_at` ≈ +1 h, zero sends, on both tracks); decided `ooo_continue` → proceeds and sends; stamped `email_replied_at` → skipped 'Lead replied' (unchanged); `last_replied_at` path unchanged. |
| `tests/reply-policy.test.ts` | `decideReplyOpenCore` with an injected `judge(state, questions)` function: p=0.97 → `ooo_continue`, `dispatched_at` set, `email_replied_at` still null; with a parsed return date → email track `next_step_at` moved to return+1d, never earlier than the existing value; p=0.3 → `human_reply`, `email_replied_at` stamped, tracks not modified here (runner skips later); judge throws → undecided + `classification_error` + attempts=1; third failure → `human_reply` with reason; `dispatched_at` already set → no-op; threshold read from `app_settings`; missing API key → same as judge error; `dispatch_result_json`/`classification_json` shapes exact. |
| `tests/inbox-resume-followup.test.ts` | 404 unknown; clears `email_replied_at`, re-arms exactly the 'Lead replied' skipped tracks of that run/target, leaves other tracks; records `operator_continue`; idempotent second call. |
| `tests/premium-status-capabilities.test.ts` | Open-core response shape (`hasPremium: false`, `linkedinReplyDetection: false`). |
| `tests/inbox-sync-opencore-dispatch.test.ts` | The inbox sync calls `decideReplyOpenCore` when premium is absent and `premium.replies.classifyAndDispatch` when present (module mock), and calls `retryUndecidedReplies` once per sync. |

`scripts/typesafe-smoke.mjs`: reads `TYPESAFE_API_KEY` from the environment,
sends three fixed sample replies (a clear OOO with a date, a curt human "not
interested", a bounce-like notice), prints `p_ooo` and the chosen date. Manual
only; not part of any gate; exits 2 if the key is missing.

## 7. Acceptance and evidence

C2-B2 is accepted when the five suites pass in the isolated Node 22 gate with
lint mandatory, host preflight passes, the dependency audit is recorded 0/0, and
`docs/production-readiness.md` moves PR-03 to **Observed** with the boundary
"open-core OOO detection is a calibrated judgment with an explicit threshold,
validated on synthetic samples only; LinkedIn reply detection remains premium".
The smoke script's live output, if the maintainer runs it, is recorded as
**Observed (manual)**; otherwise the judgment quality is **Unverified** on real
mail.

## Deferred (C2-B1)

Runner lease, browser ownership (PR-09); import checkpoints and recovery (PR-06).
