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

## Banned: `git add -A`

**With or without a path filter.** Six local-only paths live in
`.git/info/exclude` (not `.gitignore`, so QA-artifact filenames do not leak into a
public repo), and `git add -A` cannot stage an ignored file without `-f`. That is
the control. The habit is not.

The scar: `git add -A -- lib pages scripts docs ... tests` in Phase 2 swept in
`lib/linkedin/runner.ts.bak`, `scripts/demo-connect-message.ts` and
`tests/demo-harness.test.ts`. The last two would have broken fresh-clone
self-containment — `demo-harness` imports `demo-connect-message`, and the
published tree is asserted to be free of both. Caught only because the untracked
count changed from 6 to 3. The count itself was a weak tripwire; it is now an
identity check over the six specific paths, in `scripts/preflight.sh`.

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

Checks: the six local-only paths exist and are ignored (identity, not count); no
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
