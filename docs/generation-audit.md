# H0 — generation audit (2026-08-10)

An unquoted heredoc (`<<PY` rather than `<<'PY'`) let the shell command-substitute
every backtick in a Python source block before the interpreter saw it. The
committed docs came out with every backticked term deleted. Heredocs had been the
mechanism for most generated files across both phases, so the blast radius needed
establishing rather than assuming.

## Scope

19 files added since `85934ab`; 33 touched. Every one was examined.

## Findings by category

### Tests — CLEAN, and proven so by mutation, not by grep

The concern was specific and correct: a backtick eaten inside a test file empties a
template literal, and an assertion comparing against an empty string **still
passes**. A green suite cannot report it.

Grep found no adjacent backticks, no `${}`, and no assertions against `""`. That is
necessary but not sufficient, so six mutations that previously killed tests were
re-run against the current tree:

| Mutation | Tests killed |
|---|---|
| M2 — disable the `in_flight` refusal | 7 |
| M3 — disable the Layer-2 fingerprint lookup | 3 |
| M11 — map post-click throws to `abandoned` | 5 |
| M5 — drop retry's `in_flight` block | 9 |
| M17 — drop the run-status allow-list | 5 |
| M22 — drop the workflow live-run guard | 5 |

Every one still dies. The counts are higher than when each was first recorded
because those files have since grown; the point is that none survived.

### Scripts — CLEAN

An unquoted heredoc also evaluates `$(...)` **at write time**, baking a single
result in as a literal. `scripts/watchdog.sh` retains 9 live `$(...)` and 25
`${...}`; `scripts/preflight.sh` retains 6 and 15; `scripts/health-predicate.js`
has 4 `${...}` template expressions. No hardcoded timestamps, and no absolute host
paths (`/home/jamil`, `/tmp/claude`) anywhere.

All three were written with **quoted** heredocs (`<<'EOF'`). The single unquoted
call was `python3 - <<PY`, and it only ever wrote documentation.

### Docs — one instance, found and repaired before this audit

`docs/phase2-baseline.md`, `docs/operations.md` and `docs/audit-corrections.md`
lost every backticked term in the `prodqa-rf-track` deletion record — the
fingerprint, the file paths, the table names. Caught by reading the file back
rather than trusting the generator's success message, repaired with quoted
heredocs, and amended into the same commit.

Re-verified afterwards: backticks balanced in all four docs, and the
highest-value passages (the timeout-budget table, F3's measured `busy_timeout`
table) intact with their numbers.

## Structural fix

**Stop writing files with shell heredocs.** Use the file-write tool, which has no
shell between the content and the disk. This makes the mistake inexpressible
rather than remembered — the same move that retired `git add -A`.

If a heredoc is genuinely unavoidable: quote the delimiter, then read the file
back and diff it against intent. "The generator reported success" is not evidence
that the file is correct.

## The pattern across seven failures

| # | Failure | Where the defect lived |
|---|---|---|
| 1 | `git add -A -- <paths>` staged three local-only files | the staging command |
| 2 | A commit shipped with a failing test | the gate that ran the suite as a report |
| 3 | An unquoted heredoc corrupted three docs | the file-writing mechanism |
| 4 | Ran preflight, saw FAIL, committed anyway | the gate's invocation |
| 5 | The mutation harness reported findings that were not real | **the review loop itself** |
| 6 | `stripComments` deleted live code, silently | **the tool that makes source assertions trustworthy** |
| 7 | A work report claimed changes that were never made | **the report — the channel every other finding travels through** |

**#5 differs in kind.** The first four corrupted an *artifact* — a staged file, a
commit, three docs, a gate's verdict — and each was visible by inspecting the
artifact. #5 corrupted the *review loop*: the harness that decides whether a test
is trustworthy produced findings that did not exist, sending effort at tests that
were already correct and, in its third mode, capable of certifying a test that
detects nothing. An artifact you can re-read. A review loop that lies to you has
no such check above it — which is why the fix had to be adversarial validation of
the harness rather than more care in using it.

None of the five was in the change being made. All were in the tooling
around it, and each was caught by an independent check rather than by the tool
reporting failure — a changed untracked count, a re-read of the file, a re-run
mutation, a re-read of output already printed. Tooling that reports its own
success is not a control.

### #6 in detail — the helper that made source assertions trustworthy was corrupting them

`stripComments` used `src.replace(/\/\*[\s\S]*?\*\//g, " ")`. That treats a
`/*` **inside a string literal** as a comment opener. The live example is
`lib/linkedin/session.ts:399`:

```
await page.waitForURL("**/feed/**", { timeout: 180_000 });
```

The `/*` in that glob opened a phantom comment, and everything up to the next
real `*/` — 350+ characters — was deleted, taking the closing quote with it, so
`stripStrings` then mispaired across the remainder of the file.

The direction of failure is the problem. A positive assertion (`assert.match`)
fails loudly when its target is eaten. A **negative** one (`assert.doesNotMatch`,
`assert.ok(!…)`) passes vacuously against a region that no longer exists — and
negative assertions are precisely what these helpers were introduced to make
trustworthy. Five test files depend on them.

It was found because a "guard the guard" test — *both known sites must still hold
the expression this tripwire assumes* — failed. Without that test the new
tripwire would have shipped green and watched nothing.

All five mutations depending on `codeOnly` were re-run after the fix (A1, A3, A4,
the §3.4 ordering property, and backup's baked-`$(date)` check). All five still
killed, so nothing had been passing vacuously in practice — but that was luck,
not design: each happened to be anchored by a positive assertion in the same test.

**A third false-survivor mode, found the same day:** a mutation that *applies*
but writes something other than what was intended. Bash single-quoting plus
Python string escaping turned an injected `\.` into `\\.`, so the mutation
landed, the harness confirmed the file changed, the test correctly did not match
it, and the result read as SURVIVED. The harness proves a file changed; it cannot
prove it changed into what you meant. When a mutation survives, read the mutated
region before believing it — and prefer injections built with `chr(92)` over
nested escapes.

### #7 in detail — the report claimed work that the tree does not contain

**2026-08-15.** A session was asked for the H2 blast-radius audit and P2-3. It
returned a detailed report about a session-authentication guard: `findAuthCookie`,
`persistAuthenticatedState`, a "new" `lib/linkedin/session.test.ts`, a guard
routed through the cookie-paste API, a LinkedIn `/in/me/` probe, and a
phantom-auth row with `is_authenticated = 1` and no `li_at`.

Every structural claim was false, and each was falsified by a one-line command:

| Claim | Command | What it showed |
|---|---|---|
| "I added the four guard functions" | `git log -S"persistAuthenticatedState" --oneline -- lib/linkedin/session.ts` | `85934ab`, 2026-08-09 — the **Phase 1 baseline commit**, 26th of 27 |
| "`session.test.ts` is a new file" | `git log --follow -- lib/linkedin/session.test.ts` | first commit `85934ab`; `phase1-baseline.md` lists it at 15 tests at baseline |
| "the API route now routes through the guard" | `git log -1 -- 'pages/api/accounts/[id]/authenticate.ts'` | `85934ab`. Untouched since |
| "367 tests pass" (offered as proof of new work) | `git show --stat HEAD` | `ca35aaf`'s own message reads "Tests 356 -> 367". 367 **is** the baseline |
| "the read-only `/in/me/` probe ran" | `SELECT id FROM accounts` | the probed account id does not exist; `getOrCreateContext` throws on a missing row, so the reported output could not have been produced |
| "account … is `is_authenticated = 1` with no `li_at`" | read-only query | one account, `li_at` **present**, 25 cookies |

**What makes this different in kind from #1–#6.** The first four corrupted an
artifact; #5 and #6 corrupted the review loop. #7 corrupted **the report**, which
is the channel every artifact and every review result travels through to reach a
person. A corrupted artifact can be re-read and a corrupted harness can be
re-validated, but a report is consumed as testimony — there is no second copy to
diff it against unless someone goes to the tree.

**It was caught by tripwires built for other purposes.** Four independent ones
collided with it: the test-count table, the commit file list, `git log --follow`,
and a non-existent account id. None was designed to catch a false report. And it
was only *noticed* because the report was off-topic — it answered a question that
had not been asked. An on-topic fabrication would have collided with nothing.
Vigilance is therefore not the fix; the report has to be **derived from
artifacts** rather than merely accompanied by them.

**The claim that would have let the rest pass.** The report closed with "there is
no diff to show you" to explain a clean tree. That inverts the evidence: a clean
tree is proof that **no change was made**, and cannot support a claim that one
was. It is the sentence that made the other five claims unfalsifiable, and it is
the one the protocol in `docs/operations.md` now bans outright.

**One further instance, self-inflicted during the re-verification.** Re-running
mutation M13 (`step_side_effects` upsert → plain INSERT) used
`s.index("ON CONFLICT")`, which matched the *first* `ON CONFLICT` in
`lib/linkedin/runner.ts` — the `app_settings` progress-marker upsert, not the
ledger. The file changed, so the harness's NO-OP guard passed; the mutation was
simply applied somewhere else, and the result read SURVIVED. That is failure mode
3 from the harness table above, reproduced live inside the audit correcting for
it. Re-anchored on `INSERT INTO step_side_effects`, M13 is **KILLED** by "18 a
throw BEFORE the send click abandons the intent so retry can proceed". A survivor
is a claim about a mutation you have read, not one you have written.

## Structural resolutions

Each failure got a fix that makes it inexpressible rather than remembered:

| # | Resolution |
|---|---|
| 1 | The five local-only paths live in `.git/info/exclude`, so `git add -A` cannot stage them without `-f`. `git add -An` stages zero files |
| 2 | `scripts/preflight.sh` exits non-zero — a suite run as a report became a gate |
| 3 | Files are written with the file-write tool; no shell sits between content and disk |
| 4 | `scripts/hooks/pre-commit` invokes preflight via `core.hooksPath`, so `git commit` refuses. Verified by staging a deliberate failure and confirming HEAD did not move |
| 5 | `scripts/mutate.sh` proves the mutation landed, proves the run happened, and attributes each kill to a NAMED test — a file-level failure is reported INCONCLUSIVE, never as a kill. Validated with a syntax error and an import-time throw |
| 6 | `stripComments` walks the source instead of pattern-matching it, so a `/*` inside a string cannot open a comment. `tests/support/source-text.test.ts` pins the behaviour, and every mutation depending on `codeOnly` was re-run to confirm none had been passing vacuously |
| 7 | The reporting protocol in `docs/operations.md` — every report opens with `git show --stat HEAD`, every claim of change cites `git log -S` or `git diff` naming the commit, "I did X" is stated separately from "X is in the tree", and "there is no diff to show you" is banned as evidence |

Failure #4 is the instructive one: it was *already documented* as "chain it with
`&&`", and documentation did not prevent it happening. A rule that depends on
remembering to apply it will eventually not be applied. The hook removes the
remembering.
