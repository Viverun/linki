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

## N7 — SEVERITY CORRECTED, P2 -> P0. The first correction that runs UPWARD.

The audit rated N7 **P2**, with reachability explicitly marked "NOT VERIFIED",
and stated it would be **P0 if reachability were ever demonstrated**.

Reachability is now demonstrated. The severity is corrected to **P0**.

### What was proved, and by what means — stated precisely

Two claims were merged in an early report of this work. They are not the same
claim and only one of them was proved by the reproduction.

| Claim | Status | Means |
|---|---|---|
| 1. The code path accepts a vanity-less URL and selects a **bystander's** CTA, clicking Send | **PROVED** | `FakePage` harness. `sendClicked = true` against a CTA whose href carried `vanityName=somebody-else` |
| 2. LinkedIn itself emits a `flagshipProfileUrl` lacking `/in/<vanity>` | **NOT PROVED** | the URL used was **synthesised** for the test |

**No LinkedIn interaction occurred at any point.** `FakePage` is an in-memory
object; the `playwright` import in that test file is `import type` and is erased
at runtime; no chromium process ran; and the database shows zero
`connection_requested_at` values and zero `logs` rows dated 2026-08-10. The four
recorded invitations remain the authorised QA sends of 2026-08-08/09.

An early report of this work said N7 was "reproduced live". That was wrong, and
wrong in the most expensive direction — it reads as "against production
LinkedIn", which would mean a real invitation sitting in an uninvolved person's
inbox and an incident to remediate. There is no such invitation.

### So why P0, if Claim 2 is unproved?

Because reachability does not depend on Claim 2. Asking that question surfaced a
second route, provable from code and confirmed by execution:

- `resolveLinkedinUrl` (`lib/linkedin/runner.ts:655`) gates on
  `target.linkedin_url?.includes("/in/")`. That is a **substring test, not a
  shape test**.
- `POST /api/targets` (`pages/api/targets/index.ts`) validates only that
  `linkedin_url` is **truthy**. No shape check at all.

So each of these is stored, passes the gate, and yields a null vanity:

```
https://www.linkedin.com/in/          gate=true   vanity=null
https://example.com/in/               gate=true   vanity=null
linkedin.com/in/?trk=x                gate=true   vanity=null
https://www.linkedin.com/in//         gate=true   vanity=null
```

Any operator pasting a truncated or wrong URL into the contact form reaches the
null-vanity condition. No attacker and no LinkedIn quirk is required. That is
production-reachable by an ordinary mistake, and it terminates in an
**irreversible invitation to a person nobody chose** — hence P0.

The CSV path is NOT affected: `lib/csv-import.ts:94-95` runs
`normalizeLinkedinUrl` and rejects a row whose URL is not a valid
`linkedin.com/in/` profile. Manual creation is the unguarded path.

No malformed row exists in the live database — all five targets carry valid
vanities — so the defect was never triggered here. Reachable is not the same as
triggered, and the severity reflects the former.

### Unknown #1 — STILL OPEN

*Can `flagshipProfileUrl` lack `/in/`?* Unresolved. It requires real observed
data and none was gathered. It stays listed as **structurally possible, not
demonstrated**, and nothing in this correction should be read as answering it.
N7's severity no longer depends on it.

### The asymmetry, which is the actual lesson

This is the **fourth** correction to the audit and the **first that runs
upward**. The previous three — F3 retracted, the transaction claim retracted,
F8 recharacterised — all *overstated*, and a habit had formed of expecting
corrections to deflate findings.

"NOT VERIFIED" was read as "probably not reachable". It means **nobody looked**.
Those are different statements, and an unverified-reachability finding is exactly
as likely to be under-rated as over-rated. Where the consequence is irreversible
and lands on a third party, the asymmetry in *cost* is severe: over-rating buys
an unnecessary guard, under-rating sends a stranger an invitation.

The rule this yields: an unverified reachability claim is not evidence of low
severity. Either look, or rate it as if it is reachable.

## N7b — the null-vanity CLASS, audited consumer by consumer

N7 closed the invitation path. The class stayed open: every consumer that treats
a vanity as present-or-absent has to decide what absence *means*, and the answers
were inconsistent.

### The consumer audit

| # | Site | Behaviour with a null vanity | Fails |
|---|---|---|---|
| 1 | `runner.ts` `resolveLinkedinUrl` (stored URL) | gated on `includes("/in/")` — a **substring** test — and returned the URL unvalidated | **open** → now guarded |
| 2 | `runner.ts` `resolveLinkedinUrl` (`flagshipProfileUrl`) | built and returned with no shape check at all | **open** → now guarded |
| 3 | `connect.ts` `openInviteDialog` case 1 | unscoped selector; could pick a bystander's CTA | **open** → closed by N7 |
| 4 | `connect.ts` `openInviteDialog` case 2 | already threw `InviteUiError` | closed |
| 5 | `connect.ts` `verifyInvitationSent` signal 2 | `vanity ? … : 0` would read as "not pending" | **unreachable** — see below |
| 6 | `sync-accepted.ts` add pass (`:119`) | `if (!c.vanity) continue` | closed |
| 7 | `sync-accepted.ts` **unmark pass** (`:151`) | `!v \|\| !seen.has(v)` — un-marked the contact | **open, destructive** → now guarded |
| 8 | `pages/api/accounts/[id]/sync-accepted.ts:39` | `if (!match) continue` | **already closed** |

### #7 is the real one, and it is the mirror image of N7

`if (!v || !seenVanities.has(v))` reads as "no vanity, OR absent from the
authoritative list", treating those as the same thing. They are opposites:

- absence from the list is **evidence** the connection is gone;
- an unparseable URL is the **absence of evidence** — the contact could not be
  identified, so nothing was learned about them.

The selection is `linkedin_url LIKE '%/in/%'`, another substring test, so a row
like `https://www.linkedin.com/in/` **is** selected, fails to parse, and has its
`degree` and `connected_at` set to NULL on every verified-complete pass. A real,
accepted connection erased on a schedule, taking the record of when it was made
with it.

Where N7 acted on a stranger because it could not tell who the target was, #7
destroys data about the target for exactly the same reason. Same root cause,
opposite direction, and only one of the two was in the audit.

Now `shouldUnmarkPhantom` — extracted so the decision is testable without a
browser — and it fails closed: no vanity, no inference. A genuinely absent
contact is still un-marked, which is the control that stops the fix quietly
becoming "never un-mark anything" and reinstating the phantom-degree=1 problem
the pass exists to correct.

### #8 — the prediction that did not hold, recorded as such

The directive expected `pages/api/accounts/[id]/sync-accepted.ts:39` to mark a
target accepted on a null vanity, and to overwrite `connected_at` without
`COALESCE`. Neither holds:

- it does **not** call `vanityNameOf`; it inlines the same regex and guards with
  `if (!match) continue;`, so a null-vanity target is skipped;
- the `connected_at` overwrite is prevented by the selection itself, whose
  `WHERE` includes `AND connected_at IS NULL` — a row that already has a value is
  never a candidate.

No change was made there. Adding a `COALESCE` that cannot fire, or a guard that
duplicates one three lines above, would be motion rather than protection. The
correct instance was #7, in the runner's own implementation rather than the API
endpoint.

### #5 — unreachable, by ordering rather than by a check

`verifyInvitationSent`'s signal 2 compares a vanity against the sent-invitations
scrape, and `vanity ? … : 0` would read a null vanity as "not pending". Control
never arrives: `sendConnectionRequest` calls `openInviteDialog` first, which now
refuses. That is a property of **call order**, not of the function, so it is
asserted as one — a future edit that moves verification earlier, or catches
`InviteUiError` between the two, would make signal 2 live again. Both of those
edits are covered by mutation.

### Two independent guards, deliberately

`resolveLinkedinUrl` rejects at the source so no downstream consumer has to be
individually correct; `connect.ts` keeps N7's symmetric refusal. That duplication
is the same pattern as the side-effect ledger's two layers: the outer guard is
the one that should fire, and the inner one is what stands if a future caller
reaches `sendConnectionRequest` by another route.

Guard #2 also settles audit **Unknown #1** operationally without resolving it.
Whether LinkedIn can emit a `flagshipProfileUrl` lacking a vanity is still
unknown — and now does not matter, because that value is shape-checked before it
is used.

### Still open, deliberately not changed

`POST /api/targets` validates only that `linkedin_url` is truthy, and is the
production path by which a null vanity actually arrives. It is **not** fixed
here: rejecting URLs the endpoint previously accepted is an API contract change,
and it belongs to a decision about input validation rather than to null-vanity
handling. The CSV path is already guarded (`normalizeLinkedinUrl`). Recorded for
Phase 3.

## NF-9 — the gate validated a substring, not a host

N7b closed the case where a URL yields no vanity. It left open the worse one: a
URL that yields a perfectly good vanity on **somebody else's domain**.

```
https://example.com/in/bob            gate=true  vanity="bob"
https://linkedin.com.evil.tld/in/bob  gate=true  vanity="bob"
https://evil.tld/?x=.../in/bob        gate=true  vanity="bob"
```

All three cleared the `includes("/in/")` gate **and** the null-vanity guard,
because a vanity was parsed. Verified by execution, not by reading.

### Why this outranks the null case

A null vanity wastes a step, or invites a bystander — *on LinkedIn*. A foreign
host points the **authenticated browser** at attacker-chosen content. Cookies are
domain-scoped so the session itself does not leak, but the page loads in the same
browser as a live LinkedIn session, and the automation then interacts with
whatever it finds believing it is on a profile.

That is why the tests assert **zero navigation** on refusal rather than only that
an error was thrown. A throw after `page.goto` is not a defence; the hostile page
is already loaded.

### Where host validation did and did not exist

| Site | Before |
|---|---|
| `vanityNameOf` (connect.ts:90) | none — a regex on `/in/` |
| `normalizeLinkedinUrl` (csv-import.ts:57) | `includes("linkedin.com/in/")` — refuses `example.com`, accepts `evil.tld/?x=linkedin.com/in/bob`. CSV only |
| `gotoAuthenticated` (connect.ts:113) | none — `page.goto(url)` runs first, unconditionally |
| `resolveLinkedinUrl` | none |
| `isLoggedInAppUrl` (session.ts:514) | **a correct check** — but post-navigation, answering "did we land on the app?" |

The correct expression already existed, one module away, doing a different job
too late to help.

### The fix

`lib/linkedin-url.ts` — a dependency-free leaf — with a suffix-anchored host
test, applied at **both** exits of `resolveLinkedinUrl`: the stored URL, and the
`flagshipProfileUrl` LinkedIn hands back. The second exit matters because that
value is not under the runner's control; a mutation removing its check survived
the whole first round of tests, which had only ever reached exit 1.

`linkedin.com` and any subdomain are accepted. Deliberately **not** narrowed to
`www.linkedin.com`: regional forms like `uk.linkedin.com` are real, and an
over-tight allowlist breaks enrichment for legitimate profiles. That is enforced
by an over-reach control, not by intention.

### Defence in depth, not input validation — and the debt

This guard sits where the URL is about to steer a browser. It is **not** input
validation, and it does not make the system's inputs trustworthy.

`POST /api/targets` still validates only that `linkedin_url` is truthy, and
remains the production path by which a bad URL arrives. Fixing it is an API
contract change — it rejects values the endpoint previously accepted — and is
**still owed**, recorded for Phase 3. The CSV path is guarded, though by a
substring test that a query-parameter payload can defeat; folding it onto the
same predicate belongs with that work.

## F5 — PARTIALLY CORRECTED. The mechanism was real; the location was not.

The audit cited `pages/api/accounts/[id]/sync-accepted.ts:39` and attributed a
missing `COALESCE` on `connected_at` to it.

**That site is correct as written**, and nothing was changed there:

- it does not call `vanityNameOf`; it inlines the regex and guards with
  `if (!match) continue;`, so a null-vanity target is skipped rather than
  inferred about;
- the `connected_at` overwrite cannot occur, because the selection's `WHERE`
  already includes `AND connected_at IS NULL` — a row with a value is never a
  candidate;
- and the runner's own `markAccepted` (`lib/linkedin/sync-accepted.ts:93`)
  already reads `connected_at = COALESCE(connected_at, ?)`.

Adding a `COALESCE` that cannot fire, or a guard three lines below one that
already exists, would have been motion rather than protection.

**The mechanism the audit described is real, at a different location.** It lives
in the runner's implementation, `lib/linkedin/sync-accepted.ts:151` — the unmark
pass — and is now fixed under N7b. See that entry for the detail; in short,
`!v || !seenVanities.has(v)` conflated "cannot identify this contact" with
"this contact is gone", and wiped `degree` and `connected_at` on rows it could
not parse.

### What survives of F5

The API endpoint's *"not in the pending list any more -> accepted (or expired,
but treat as accepted)"* inference is a **separate claim from the COALESCE one,
and it still stands on its own terms**: a withdrawn or expired invitation leaves
the pending list exactly as an accepted one does, so that endpoint will record a
connection that was never made — untouched here, and still owed a fix.

### The tally, and what these five share

| # | Finding | Correction |
|---|---|---|
| 1 | F3 — "SQLite has no `busy_timeout`" | **RETRACTED** — the constructor already defaults it to 5000 |
| 2 | "Transaction held open across network work" | **RETRACTED** |
| 3 | F8 — the loop's outer `.catch()` | **RECHARACTERISED** — reachable only via `getDb()`, and it latched |
| 4 | N7 — unscoped invite fallback | **SEVERITY RAISED**, P2 -> P0 |
| 5 | F5 — missing `COALESCE` | **MIS-LOCATED** — right mechanism, wrong file |

Two retractions, one recharacterisation, one increase, one mis-location.

The common thread: **every audit claim carries a mechanism AND a location, and
both have to be executed.** Reading the mechanism and finding it plausible is not
verification — F3's mechanism was plausible and false; F5's was true but pointed
at a file that had already handled it. A claim is only confirmed when the
specific line named has been made to misbehave.

## Standing correction to how findings are rated

Two of the audit's findings fell to measurement. Ratings derived from reading
code without executing it should be treated as hypotheses until a failing
reproduction exists. That applies to the findings still open (F4–F7, N3, N6, N7,
N8) as much as it did to F3.

---

## Provenance for Phase 1's connection-sending claim

Phase 1 reported one real LinkedIn invitation sent end-to-end through the shipped
runner path to `raise-faster`. The run, run_profile, track and log rows that
recorded it were production-QA artifacts, deleted on 2026-08-10 by authorisation
(Phase 2 §2) because production-shaped QA data misleads later audits.

The evidence was exported before deletion to
`data/backups/prodqa-rf-provenance-20260810T100615Z.json`, containing the `runs`,
`run_profiles`, `run_profile_tracks`, `logs` and `step_side_effects` rows, plus a
snapshot of the `raise-faster` target.

The target row itself was **not** deleted, and remains the live evidence:
`connection_requested_at = 2026-08-09T05:27:59.968Z`, `degree = NULL`, with the
invitation still pending on LinkedIn.
