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

**Verify it is running:** `grep watchdog /var/log/linki-watchdog.log | tail`, and
confirm a healthy pass is silent (it exits 0 without logging).

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
