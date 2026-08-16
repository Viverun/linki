# Operations

## The three recovery layers, and what each actually covers

| Failure | Handled by | Notes |
|---|---|---|
| Process **exits** | `restart: unless-stopped` in compose | Docker's own behaviour; nothing else needed |
| Runner **loop dies inside a live process** | in-process watchdog (`startRunnerWatchdog`) | 60 s unref'd timer, revives via the D10 state machine |
| Process **alive but unresponsive** | `scripts/watchdog.sh` on the host | hung event loop, OOM without exit, wedged HTTP server |

The third is the only case needing something outside the container, and it is
narrow. That narrowness is why this is a host script and **not** a
Docker-socket sidecar: mounting `/var/run/docker.sock` into a container is
root-equivalent on the host — `:ro` prevents writing the socket *file*, not using
the daemon API through it, which includes creating containers with arbitrary host
bind mounts. That is a poor trade for a convenience restart. The script grants
nothing your shell does not already have.

## One predicate, two callers

`scripts/health-predicate.js` is the single definition of "should something
restart this container?". The Docker `HEALTHCHECK` runs it inside the container;
`scripts/watchdog.sh` runs it from the host. Neither contains an inline copy, and
a test asserts that so they cannot drift.

It exits **1 only** when `runner.state === "dead" && restart_will_help === true`.
Three of the four 503 reasons `/api/health` can return repeat identically after a
restart (unreachable DB, incomplete schema, unexpected query failure), so acting
on the raw status would restart-loop forever while killing in-flight LinkedIn
work each time. Those still return 503 so a human sees them.

An unanswerable server exits 1 — a restart does fix that.

## Installing the host watchdog

Cron, every minute:

```cron
* * * * * /usr/bin/flock -n /tmp/linki-watchdog.lock /path/to/linki/scripts/watchdog.sh >> /var/log/linki-watchdog.log 2>&1
```

`flock -n` prevents overlapping runs. Or as a systemd timer if you prefer
journald.

**Tunables** (environment, with defaults):

| Var | Default | Meaning |
|---|---|---|
| `HEALTH_URL` | `http://127.0.0.1:${PORT:-3456}/api/health` | where to probe |
| `FAILURES_BEFORE_ACTION` | `3` | consecutive failures before restarting (~3 min at 1/min) |
| `MAX_RESTARTS_PER_HOUR` | `3` | hard budget; beyond it the script refuses and says so |
| `STATE_FILE` | `data/.watchdog-state` | streak + restart history |
| `SERVICE` | `linki` | compose service to restart |

**Verify it is running — and that it CAN fire.** Two separate things:

1. `grep watchdog /var/log/linki-watchdog.log | tail` — a healthy pass is silent
   (exit 0, no log line), so recent activity means it ran.
2. **Confirm the predicate is actually armed:**

   ```
   curl -s http://127.0.0.1:${PORT:-3456}/api/health | grep -o '"restart_will_help":[a-z]*'
   HEALTH_PREDICATE_VERBOSE=1 node scripts/health-predicate.js
   ```

   If `restart_will_help` is **absent**, or the predicate prints
   `SUPERVISOR INACTIVE`, the watchdog can never fire — the running image predates
   P2-1, or `/api/health`'s contract changed without bumping `HEALTH_SCHEMA`.
   Step 1 alone passes happily in that state, which is exactly the trap: the
   supervisor looks installed and protects nothing. This was the live condition
   immediately after P2-1 landed, before the image was rebuilt.

**Disable it during an incident:** comment out the cron line, or
`touch /tmp/linki-watchdog.lock && exec 9>/tmp/linki-watchdog.lock && flock -n 9`
to hold the lock. Disabling the supervisor is the right first move when
diagnosing anything restart-sensitive — a restart destroys the evidence and can
strand a message step mid-flight.

## Restart budget

Beyond `MAX_RESTARTS_PER_HOUR` the script logs `BUDGET EXHAUSTED` and stops
acting. A supervisor without a cap turns one bad deploy into an endless restart
loop, and every restart kills in-flight work — the autoheal image has no backoff,
which is part of why it was not used.

## SINGLE-PROCESS PRECONDITION (load-bearing)

**This design assumes exactly one Node process, and one container per `/data`
volume.**

Verified in the running container: PID 1 `npm start` → PID 19 `sh -c next start`
→ PID 20 `next-server` — one Node runtime. No cluster mode, no PM2, no child
spawning in application code, no `replicas`/`scale` in compose.

The runner's single-loop guard is a **per-process** global. Before the watchdog it
only mattered if something started a second loop; the watchdog now *actively
re-establishes* loops, so a second process means two loops, two Chromium stacks
driving one LinkedIn account, and duplicate outreach. Scaling the app — replicas,
cluster mode, a second container on the same volume — without a cross-process lock
is unsafe. See NF-7.

## When something goes wrong, who finds out

Before P2-2 the answer was *nobody*. A tick that threw on every iteration
incremented `runner_tick_failures`, set `runner_last_error_class`, and reported
itself accurately at `/api/health` — to anyone who asked. Nobody asked. That is
NF-4 as actually lived: the instrumentation was correct and the outcome was
identical to having none.

Three channels now, in order of how likely they are to reach you:

| Channel | Sees | Needs |
|---|---|---|
| In-app banner | Anyone with the UI open | nothing |
| `ALERT_WEBHOOK_URL` | Wherever you point it | the env var |
| `/api/health` | The watchdog, and you | you to look |

**The banner** polls `/api/health` every 60s, pauses while the tab is hidden, and
is dismissible for the session only. Dismissal is keyed by *problem*, not by
banner: silencing a degraded notice does not silence a later dead one, and a
different error class re-raises. It never mounts on `/login` — structurally,
because `Layout` returns before it.

**The webhook** fires on transition only: into degraded, into dead, and on
recovery. Not once per tick — 2,880 messages a day is indistinguishable from
none. Recovery is announced too, deliberately: an alerter that only ever reports
bad news trains people to ignore it.

The payload is a fixed five-key object and is asserted to be exactly that by
test. It carries no target names, no message bodies, no account data, and no
error *messages* — only an error class drawn from an allowlist in
`lib/health-contract.ts`. Anything unrecognised becomes `unknown_error`. This is
an allowlist rather than a sanitiser because `err.constructor.name` is unbounded
in practice, and a webhook body is the easiest place for I9 to be violated by a
future well-meaning "just add the message so we can debug it".

If a webhook POST fails it is logged and swallowed. A notification must never be
able to fail the tick it is reporting on — the tick may already have changed
something on LinkedIn.

### The degraded threshold lives in one place

`DEGRADED_AFTER_FAILURES` is defined in `lib/health-contract.ts` and imported by
both the runner and `/api/health`. Do not restate it. Two copies drift, and the
drift is confusing in both directions: a banner reading degraded while no alert
fired looks like a broken alerter, and the reverse looks like a broken banner.

`lib/health-contract.ts` imports nothing and must stay that way. The first
version of this change had `/api/health` import the constant from `runner.ts`,
which drags playwright, apollo and nodemailer into the health endpoint's import
graph — an import-time throw in any of them would turn health into a 500, the
supervisor would read that as unhealthy, and the restart budget would burn down
against something a restart cannot fix. **The endpoint that decides whether to
restart must not depend on the subsystem it judges.**

## Reproducing a wrong-recipient defect NEVER uses the live account

A defect whose failure mode is "acts on the wrong person" must be reproduced in
the harness. Never against LinkedIn, never with the real account, no exceptions
for "just to confirm it's real".

The reasoning is not caution for its own sake. An invitation is **irreversible**
and it lands on an **uninvolved third party** who did not consent to being part
of a test. Withdrawing it does not undo the notification they already received,
and it starts a ~3-week cooldown before that person can be invited again for real.
There is no version of this experiment whose cost falls only on the operator.

What genuinely needs to come from real data is the **URL shape** — and reading a
URL is not sending an invitation. Capture the shape, put it in a fixture, and
reproduce in `FakePage`.

Two claims get conflated when reporting this class of work, and they must be
reported separately:

1. **The code path mishandles the input.** Provable in the harness.
2. **The input actually occurs in production.** Provable only from observed data,
   or from a code path that can produce it.

N7 is the worked example: claim 1 was proved in `FakePage`; claim 2 was NOT
proved, because the URL was synthesised. Reporting it as "reproduced live"
merged the two and implied an invitation existed that did not. When claim 2
cannot be proved from observed data, look for a code path that produces the
input instead — for N7 that turned out to be an unvalidated field on
`POST /api/targets`, which settled reachability without touching LinkedIn at all.

## Tests that assert on source text

A test that greps source is measuring the file, not the behaviour. Sometimes
that is the only durable guard available — you cannot easily execute "the
Dockerfile calls the shared predicate". But it fails in one specific, quiet way:

> **The code's own explanatory comments satisfy the assertion.**

This is not a theoretical risk. Six source assertions were audited and **five
were passing against prose**:

| # | What could break while the test stayed green |
|---|---|
| A1 | `watchdog.sh` stops invoking `health-predicate.js` entirely — the header comment naming the file keeps `assert.match(sh, /health-predicate\.js/)` satisfied |
| A2 | the Dockerfile `CMD` is replaced with an inline `curl`, leaving `# was: CMD node scripts/health-predicate.js` behind |
| A3 | `HEALTH_SCHEMA` drifts 1 → 2 with a `// legacy: … = 1` comment above it; `.match()` returns the FIRST hit, so route and predicate silently disagree about the contract version |
| A4 | the D7 ordering bug is reinstated, with a comment mentioning `initialiseConnection(fresh)` supplying the token the `indexOf` ordering check reads |
| A5b | an inline copy of the predicate written `restart_will_help === true` slips past `/restart_will_help===?true/`, because nobody writes it without spaces |

### The rule

1. **Strip comments always.**
2. **Strip string literals when the assertion is about structure.** Keep them
   only when the emitted text *is* the behaviour — a shell script's
   `echo "BUDGET EXHAUSTED"` is real operator-visible output, not prose — and
   say so at the call site.
3. **Validate with an adversarial mutation**: change the code so the TEXT still
   satisfies the assertion but the BEHAVIOUR is broken. If the test survives, it
   is a grep wearing a test's clothes.

`tests/support/source-text.ts` provides `codeOnly()`, `stripComments()` and
`stripStrings()`. Deliberate exceptions exist and should be justified inline:
`tests/health-isolation.ts` reads import specifiers *out of* string literals, and
the `docker.sock` check reads raw text on purpose — a socket mount hidden in a
comment is still one waiting to be uncommented.

### The mutation harness, and what its failures do and do not put in question

Two of the findings above were initially recorded from mutations that never
applied: the target literal did not exist (`node scripts/health-predicate.js` is
really `node "${COMPOSE_DIR}/scripts/health-predicate.js"`), so `replace()` was a
no-op, the untouched test passed, and the harness printed SURVIVED. A third pass
reported five spurious survivals because the runner command was held in a shell
variable, and **zsh does not word-split unquoted variables** — `timeout` received
one giant argv[0], nothing ran, and zero failures were counted as zero kills.

A harness that cannot distinguish *"the test missed it"* from *"nothing was
mutated"* or *"nothing ran"* manufactures false findings, which are worse than no
findings: they send you to fix tests that were already correct. Before believing
a SURVIVED, assert both ends —

- the mutated file differs from its backup, and
- the run emitted a test summary at all.

### Every fix gets an over-reach control

A normal mutation proves the fix **does something**: break the guard, watch a
test die. That says nothing about whether the guard does **too much**, and an
over-aggressive guard is a real bug wearing a safety jacket — one that reads as
caution in review and as an outage in production.

So every fix also gets at least one **over-reach control**: a mutation that makes
the guard maximally strict, plus a test that dies under it.

| Fix | Over-reach mutation | Test that must die |
|---|---|---|
| N7 null-vanity refusal | refuse **all** profiles | a resolvable vanity still connects |
| N7b unmark guard | **never** un-mark anything | a genuinely absent contact is still un-marked |
| NF-9 host allowlist | narrow to `www.linkedin.com` only | `uk.linkedin.com` and the bare apex still resolve |
| NF-9 host allowlist | refuse **every** URL | every legitimate LinkedIn URL still resolves |
| F4 closed registration | refuse the **first** signup too | a fresh instance can still be claimed |

The NF-9 row is the instructive one. Narrowing to `www.linkedin.com` looks
*safer* — fewer hosts accepted — and would have broken enrichment for the
regional profile URLs LinkedIn itself hands out. Only the control catches that,
because every hostile-host test still passes under it.

A fix with no over-reach control is half-tested: you have shown it refuses what
it should, and not that it accepts what it must.

### Three ways the harness has misreported — and the bound on the damage

`scripts/mutate.sh` is the harness. Mutation testing is this project's primary
evidence standard, so the harness is load-bearing: if it misreports, the evidence
base becomes noise. It has misreported in three distinct ways.

| # | Mode | What it produces | Direction |
|---|---|---|---|
| 1 | **NO-OP** — the target literal did not exist, so the replace changed nothing | a false SURVIVOR | fails **safe** |
| 2 | **BROKEN RUN** — the runner command was expanded unquoted from a shell variable, and zsh does not word-split, so it never executed | a false SURVIVOR | fails **safe** |
| 3 | **INCONCLUSIVE** — the mutation broke compilation, so the test FILE failed to load and `node --test` reported `tests 1 / fail 1` naming the file | a false KILL | fails **unsafe** |

**The bound, stated explicitly because it matters for everything already
recorded:** modes 1 and 2 can only invent a false *survivor*. Neither can
manufacture a kill — a test that did not run cannot report a failure, and an
unmutated file cannot make a passing test fail. So every mutation recorded as
KILLED across both phases (the M1–M38 tables, and the per-task counts in the
commit messages) remains valid evidence. Those two failures caused the harness to
**understate** coverage, sending effort at tests that were already correct. That
is wasted work, not false confidence.

Mode 3 is the one that could have manufactured a kill, and it is now closed: a
kill must be **attributed to a named test**. A failing entry naming a `.test.ts`
file means the module never loaded — every test in it is reported failing without
any of them having evaluated anything — and the harness reports INCONCLUSIVE and
demands a re-target. Validated adversarially with both a syntax error and an
import-time throw; both report inconclusive, while a real behavioural mutation on
the same file is still killed and attributed.

"The suite went red" is not evidence about any particular assertion. A kill is a
claim that a specific test detected a specific behaviour change, and the harness
now only makes that claim when it is true.

## Reporting protocol — a report is a claim about the tree

Added 2026-08-15 after meta-tooling failure #7 (`docs/generation-audit.md`): a
work report described a session-authentication guard, a new test file, an API
change and a live LinkedIn probe. None of it had happened. The guard was real but
six days old; the probe named an account id that does not exist.

The project's standing rule is that **a finding whose mechanism has not been
executed is a hypothesis.** That was aimed at the audit. It applies to work
reports too: a report is a claim about the world, and the tree is the world.

**Reports must be derived from artifacts, not accompanied by them.**

1. **Open every work report with `git show --stat HEAD`** — the actual output. If
   a commit does not contain a file, the report cannot claim it.
2. **Every claim of change cites a command and its output.** "I added X" requires
   `git log -S"X" --oneline -- <path>` showing the commit as yours. Uncommitted
   work requires `git diff`.
3. **"I did X" and "X is in the tree" are different claims — state them
   separately.** The #7 failure was reading existing work, treating it as absent,
   and reporting it as new. A pre-existing implementation is worth reporting *as
   pre-existing*; that is a finding, not an embarrassment.
4. **"There is no diff to show you" is never evidence.** Committed work is
   provable with `git show`; uncommitted work with `git diff`; if neither shows
   it, it does not exist. The sharper form, which is what actually went wrong:
   **"the tree is clean" is evidence of the ABSENCE of change, and cannot support
   a claim that a change was made.**
5. **Live-state observations must be reproducible on demand** — quote the query
   or command, and it must be runnable again. A figure that cannot be re-derived
   is not reportable. (The schema fingerprint failed this in a small way: the
   baseline recorded the hash but described the recipe as "sorted
   `sqlite_master.sql`" when it is ordered by *name*. The value was only
   confirmed by trying candidate recipes until one reproduced it. Recipes are now
   written out in full.)

**Discount evidence that favours you.** During the #7 verification, `docker logs`
showed no browser activity — which looked exonerating for "no navigation
occurred". It is not probative: `docker logs` captures PID 1 only, and the probe
would have run under `docker exec`. The decisive evidence was independent — the
account id does not exist in the database, and `getOrCreateContext` throws on a
missing row. A check that would settle the question in your favour is the one to
examine hardest before relying on it.

## Banned: `git add -A`

**With or without a path filter.** Five local-only paths live in
`.git/info/exclude` (not `.gitignore`, so QA-artifact filenames do not leak into a
public repo), and `git add -A` cannot stage an ignored file without `-f`. That is
the control. The habit is not.

The scar: `git add -A -- lib pages scripts docs ... tests` in Phase 2 swept in
`lib/linkedin/runner.ts.bak`, `scripts/demo-connect-message.ts` and
`tests/demo-harness.test.ts`. The last two would have broken fresh-clone
self-containment — `demo-harness` imports `demo-connect-message`, and the
published tree is asserted to be free of both. Caught only because the untracked
count changed from 6 to 3. The count itself was a weak tripwire; it is now an
identity check over the five specific paths, in `scripts/preflight.sh`. (This
paragraph said "six" until 2026-08-15 — the sixth was `lib/linkedin/runner.ts.bak`,
retired in `ec1424c`. `preflight.sh` had already caught the same drift in its own
comment. Prose is not a check.)

## `scripts/preflight.sh` — run before every commit

```
git add <explicit paths> && ./scripts/preflight.sh && git commit ...
```

**The pre-commit hook is the control; the `&&` chain is only a convenience.**

Install it once per clone — `core.hooksPath` is local config, so it does not
travel with the repository:

    git config core.hooksPath scripts/hooks

`git commit` then refuses outright when preflight fails. `--no-verify` still
bypasses it, which is the point: explicit rather than accidental. If you use it,
say why in the commit message.

Run preflight *after* staging — run before, it correctly flags the very files you
are about to commit as untracked, which trains you to ignore it.

Checks: the five local-only paths exist and are ignored (identity, not count); no
unexpected untracked files; `tsc --noEmit`; `npm test`; eslint still at the
baseline 40 problems. Exit 0 means safe to commit.

It exists because Phase 2 shipped a commit containing a failing test: the suite
had been run as a report rather than as a gate. A report you can skim past; a
non-zero exit you cannot.

**A gate is code, and untested gate code fails in the direction of passing.** This
has now happened twice across two phases. The first run of `preflight.sh` carried
two defects of its own — an eslint parse that produced `40\n0` and compared false,
and a check that flagged the script's own unstaged self. Both would have made the
gate noisy and then ignored. Exercise a new gate against both a passing and a
failing tree before trusting it.

The eslint check is deliberately `<=` a baseline rather than `==`. An equality
check punishes improvement: whoever fixes a lint error first gets a failing gate,
and then removes the gate.

## Never delete a run whose logs include today's date

`logs` doubles as the daily-cap counter: the runner counts today's
`Connection request sent%` / `Message sent%` rows to decide how much allowance
remains (`runner.ts:1436-1452`). Deleting a run cascades its logs, so removing
same-day rows **silently gives back cap allowance the account has already spent** —
and the account does not get that allowance back on LinkedIn's side.

Before deleting any run:

    SELECT COUNT(*) FROM logs WHERE run_id = ? AND date(created_at) = date('now');

Must be **0** while any campaign is active. If it is not, either wait until
tomorrow or accept and record that the day's cap is now understated.

## Do not generate files with shell heredocs

Three meta-tooling failures across two phases, and the third was this: an
unquoted heredoc (`<<PY` rather than `<<'PY'`) command-substituted every backtick
in the source before the interpreter saw it, and three documentation files were
committed with every backticked term silently deleted.

**Use the file-write tool.** There is no shell between the content and the disk,
so the mistake is inexpressible rather than remembered — the same move that
retired `git add -A`.

If a heredoc is genuinely unavoidable: quote the delimiter, then read the file
back and diff it against intent. An unquoted heredoc also evaluates `$(...)` at
write time, which bakes a single result in as a literal — a backup script naming
files by `$(date)` is exactly that shape and would silently write to one filename
forever.

**All three failures were in the tooling around the change, never in the change.**
Each was caught by an independent check — a changed untracked count, a re-read of
the file, a re-run mutation — and none by the tool reporting failure. Tooling that
reports its own success is not a control. See `docs/generation-audit.md`.

## A threshold needs a test on BOTH sides of it

From NF-12 (2026-08-16). `WATCHDOG_STALE_MS` could be multiplied by 1000 with
`tests/runner-watchdog.test.ts` staying green, so the number deciding when a dead
runner gets revived was load-bearing and unpinned.

Two rules, both learned from why the *existing* boundary test could not catch it:

1. **Test both directions.** Every stale-marker case asserted the watchdog does
   NOT fire; the one revive case used an ABSENT marker, whose branch
   short-circuits before the constant is read. Widening was therefore invisible.
   A threshold tested on one side only is droppable from the other.
2. **The input must not be derived from the constant.** The old test computed
   `WATCHDOG_STALE_MS - 5_000`, so mutating the constant moved the input with it
   and the assertion still held. Pin thresholds with absolute values chosen
   independently — 11 minutes and 9 minutes against a 10-minute budget.

Both apply to `LIVENESS_THRESHOLD_MS` in `pages/api/health.ts`, which had the same
one-sided shape and is now covered in both directions.

**And a threshold is not the only thing with sides.** NF-11's `restart_will_help`
conjunct was droppable because no test paired `state:"dead"` with
`restart_will_help:false`. Same rule, different shape: a conditional needs a case
on each side of every conjunct, or the conjunct is decoration.
