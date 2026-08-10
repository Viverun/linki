# Backup and restore

## The backup set is TWO things

**A copy of `linki.db` is not a backup. Without `NEXTAUTH_SECRET`, every stored
LinkedIn session in that database is permanently undecryptable, and no account
can act — you will have restored a complete, intact, useless database.**

`accounts.cookies_json` is encrypted with AES-256-GCM under a key derived from
`NEXTAUTH_SECRET` via HKDF (`lib/crypto.ts`). The secret is not stored in the
database, by design — that is what makes a stolen `linki.db` worthless. It is
also what makes a backup without the secret worthless.

So the backup set is:

| Item | Where it lives | If you lose it |
|---|---|---|
| `linki.db` snapshot | `data/backups/linki-auto-*.db` | everything |
| `NEXTAUTH_SECRET` | `.env.local` on the host | every account must re-authenticate by hand |

`.env.local` is **not** copied by `scripts/backup.mjs`. It contains the login
password and other live credentials, and writing it into a snapshot directory
that may be synced elsewhere would spread them. Store it in a password manager
or an encrypted vault, and record where — the drill below proves what happens
without it.

## Taking backups

```
node scripts/backup.mjs
```

From cron, on the host:

```
0 3 * * *  cd /path/to/linki && node scripts/backup.mjs >> data/backups/backup.log 2>&1
```

| Variable | Default | Meaning |
|---|---|---|
| `LINKI_DB_PATH` | `./data/linki.db` | source database |
| `BACKUP_DIR` | `<db dir>/backups` | where snapshots go |
| `BACKUP_OFFSITE_DIR` | unset | second copy, see below |
| `BACKUP_RETAIN` | `7` | how many auto-snapshots to keep |

It runs against the **live** database. `VACUUM INTO` takes a consistent
point-in-time image inside a read transaction: it does not block writers and it
includes everything in the WAL. Verified by test, including a writer with
`busy_timeout = 0` that would fail instantly if the backup locked it out.

### Do not use `cp`

The database runs in WAL mode with a multi-megabyte WAL. `cp linki.db` copies
the main file *without* it, silently discarding every committed transaction
still in the WAL. The result opens cleanly and is stale. At the time of writing
the live WAL was 4.1 MB against a 344 KB main file — nearly the entire recent
history would have been lost by a copy that looked perfectly fine.

### Order of operations

```
check free space -> VACUUM INTO a .partial -> open and VERIFY -> rename -> prune
```

Each arrow is load-bearing, and each is held in place by a test:

- **Space first**, because a full disk produces a truncated file that looks like
  a backup in a directory listing.
- **`.partial` until verified**, so a crash mid-run leaves something obviously
  not a backup rather than a plausible-looking corpse.
- **Prune last.** Prune-then-verify means a failed verification plus retention
  equals zero good backups: retention would delete the good ones to make room
  for a broken one.
- **The newest is never deleted**, whatever the retention arithmetic says.
  `BACKUP_RETAIN=0` is a misconfiguration, not an instruction to leave the
  system with nothing.

Verification opens the snapshot and runs `integrity_check`, `foreign_key_check`,
a table-list comparison against the source, and a `COUNT(*)` over every table.
The `integrity_check` is not redundant: a corrupt **index** page passes a full
table scan — every row still counts — and only `integrity_check` notices. A
backup restored from that state returns wrong answers to indexed queries instead
of failing loudly.

Retention only ever touches files matching `linki-auto-<stamp>.db`. Hand-made
safety copies (`pre-prodqa-delete-*.db`, `linki-prePhase1-*.db`) are left alone
permanently — those are exactly what you reach for during an incident, and
retention eating them would be the worst possible timing.

## Where backups actually land

**By default, nowhere safe.** `BACKUP_DIR` defaults to `data/backups`, which is
*inside* the `./data` bind mount — the very volume these snapshots exist to
survive losing. `docker compose down -v`, a corrupted mount, or an `rm -rf` on
the wrong parent takes the database and every snapshot of it together.

`BACKUP_OFFSITE_DIR` is **opt-in and empty by default**. When it is unset the
script logs a `WARNING` on every run rather than exiting 0 in silence, because a
green cron job is otherwise indistinguishable from a protected system.

| | Default | Retention applies? | On failure |
|---|---|---|---|
| `BACKUP_DIR` | `data/backups` — **inside the volume** | yes | run fails, non-zero |
| `BACKUP_OFFSITE_DIR` | unset — **opt-in** | yes, same `BACKUP_RETAIN` | run fails **loudly**, non-zero; the on-volume snapshot survives |

Retention prunes **both** locations. Pruning only the primary would leave the
second directory growing without bound, ending as a full disk — which is the one
condition that stops new backups being written at all.

A missing or unwritable off-volume path fails the run. There is deliberately no
silent fallback to "we kept the on-volume copy": a second location that quietly
stopped receiving copies is something you discover during an incident, which is
the worst possible moment.

## "Off-volume", stated honestly

`/data` inside the container is a bind mount of `./data` on the host. So:

- `BACKUP_OFFSITE_DIR=/home/you/linki-offsite` is **off-volume**: it survives
  `docker compose down -v`, a container rebuild, or a corrupted bind mount.
- It is **not off-disk**. It is the same physical device, the same filesystem,
  and the same machine. A disk failure, a filesystem corruption, an accidental
  `rm -rf` on the wrong parent, ransomware, or the host dying takes both copies.
- It is **not off-site**. A fire, a theft, or a cloud instance being terminated
  takes everything.

Do not let the presence of a second directory read as redundancy it does not
have. There is exactly one copy of your data on exactly one disk.

### The manual off-host step (not automated)

Automating this would mean putting credentials for an external target on the
host, which is a larger decision than a backup script should make on its own.
Run it deliberately, on whatever cadence matches how much you would mind losing
the work:

```
rsync -av --delete data/backups/ /mnt/external/linki-backups/
# or
rclone copy data/backups/ remote:linki-backups/
```

And store `NEXTAUTH_SECRET` with them — separately encrypted, since the whole
point of the secret is that it does not travel with the database.

## RPO — how much work you can lose

With the nightly 03:00 cron, **RPO is up to 24 hours**. A failure at 02:59 loses
almost a full day of runs, invitations, messages and reply state.

### The part nobody expects: session cookies rotate

`saveSessionState` rewrites `accounts.cookies_json` as work proceeds — after
profile visits, after connection requests, after messages, after accepted-sync
(five call sites in `lib/linkedin/runner.ts` alone). LinkedIn also rotates its
own cookies over time.

**So a day-old backup carries day-old cookies.** The restore can succeed
completely — integrity fine, secret correct, everything decrypts — and the
sessions may still be stale, requiring each account to be re-authenticated
through the UI before automation can resume.

Plan for that. It is not a failure of the restore, and it is not something to
discover at 3am: budget for re-authenticating every account after any restore
older than a few hours, and treat a successful restore as "the data is back",
not "the system is running".

## Restoring

1. **Stop the app.** `docker compose down`. Restoring under a running runner
   invites two processes against one database — see the single-process
   precondition in `docs/operations.md`.
2. **Keep the corpse.** `mv data/linki.db data/linki.db.broken-$(date -u +%Y%m%dT%H%M%SZ)`
   — with the WAL and SHM files. You may need them, and a restore that destroys
   the evidence gives you one attempt.
3. **Put the snapshot in place.** `cp data/backups/linki-auto-<stamp>.db data/linki.db`
   There are no sidecar files to bring: `VACUUM INTO` produces one
   self-contained file, and the old `-wal` / `-shm` must NOT be carried over.
4. **Confirm `NEXTAUTH_SECRET` in `.env.local` is the one that matches this
   snapshot.** If it is not, stop — see the drill below for exactly what you are
   about to see.
5. **Start.** `docker compose up -d`, then check `/api/health` reports
   `runner.state: healthy` and `schema: ok`.
6. **Re-authenticate each account** if the snapshot is more than a few hours old.

### Rehearsing without touching production

```
node --experimental-strip-types --env-file=.env.local \
     --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --disable-warning=ExperimentalWarning \
     --import ./scripts/test-setup.mjs scripts/restore-drill.ts [snapshot.db]
```

Read-only with respect to the live database; everything happens on a copy in a
scratch directory which is deleted afterwards. It never prints a cookie value —
only how many cookies came back and which names are present.

## Drill report — executed 2026-08-10

Snapshot `linki-auto-20260810T150334Z.db` (352,256 B), taken by
`scripts/backup.mjs` against the **live** database while the container was up and
reporting healthy. 28 tables, 100 rows.

| Check | Result |
|---|---|
| `integrity_check` | ok |
| `foreign_key_check` | 0 violations |
| `step_side_effects` present | yes (the schema `/api/health` insists on) |
| Tables restored | 28 |
| Key tables readable | accounts=1 targets=5 workflows=5 runs=8 run_profile_tracks=8 logs=38 |
| `cookies_json` encrypted at rest | yes, `v1` envelope |
| **Account session decrypts with the correct secret** | **yes — 25 cookies, `li_at` present** |
| **Wrong secret cannot decrypt** | **correct — throws** |

8/8 passed.

The two account checks are the ones that matter, and they are why this drill
exists rather than a note saying "health returns 200". Reaching 200 on a restored
database proves the schema came back. Decrypting a real session cookie proves the
**account** came back — which requires the database and the secret to agree, and
is the entire reason the secret is in the backup set.

The negative case turns the warning at the top of this document from a claim into
a demonstration: same ciphertext, different key, decryption fails. If you restore
`linki.db` without `NEXTAUTH_SECRET`, that is exactly what every account will do.

The positive case also guards against a false pass: `decryptSecret` passes
*non-encrypted* values through unchanged, so a plaintext row would appear to
"decrypt" perfectly and prove nothing. The drill asserts the value is genuinely
enveloped before decrypting it.

### RTO — measured end to end

Two phases, both measured on 2026-08-10 against the live system:

| Phase | Measured |
|---|---|
| Restore the data: copy + `integrity_check` + `foreign_key_check` + table verification + cookie decryption | **0.01s** |
| Boot: `docker run` against the restored copy until `/api/health` returns 200 | **2.94s** |
| **Restore → serving** | **≈3s** |
| Re-authenticating each account (stale cookies) | **not measured — manual, and the dominant term** |

The boot phase reported `runner.state: healthy`, `schema: ok`, `db: ok`.

Both numbers are for a 344 KB database on this host. They will grow with the
database, but not by much: `VACUUM INTO` is linear in size and Next.js boot is
constant.

**Re-authentication remains the real cost.** Everything above says the software
is serving; it does not say the automation can act. See the cookie-rotation
section — a day-old snapshot restores perfectly and may still need every account
re-authenticated through the UI before any work resumes.

#### Booting the drill instance is safe, and here is the argument

Rehearsing the boot phase means starting a second Linki instance. The hazard is
not database contention — the scratch copy is a separate file — it is **two
browsers driving one LinkedIn account**. That cannot happen here, and the reason
is structural rather than hopeful:

1. **`tick()` returns before any navigation.** `lib/linkedin/runner.ts:1578` is
   `if (activeRuns.length === 0) return;`, and `activeRuns` selects only
   `runs.status = 'running'`. Everything that touches LinkedIn — the
   accepted-connections sync (`:1589`), the email inbox sync (`:1645`), and every
   step execution — sits *after* that line.
2. **The snapshot has zero running runs**: 7 completed, 1 paused. Paused is not
   running, so `activeRuns` is empty on every tick.
3. **The import scheduler also returns immediately**: `list_imports` has 0 rows,
   and `processScheduledImports` returns unless one is `scheduled`.

Run it on a different port, with the restored copy at a path **outside `./data`**,
and with `ALERT_WEBHOOK_URL` unset.

Verified empirically rather than left as reasoning. After ~45s of running (one
poll interval is 30s), the drill container's entire log was:

```
▲ Next.js 16.1.6
✓ Starting...
[runner] Global loop started
✓ Ready in 1117ms
```

Occurrences in the log — `linkedin.com` 0, `playwright` 0, `chromium` 0,
`sync-accepted` 0, `Accepted-connections` 0, `Tick —` 0, `invitation` 0,
`Navigating` 0. The restored copy's `logs` table was unchanged at 38 rows, and
`runs.running` stayed 0.

`Tick —` at zero is the load-bearing observation: that line is logged at
`runner.ts:1580`, immediately *after* the early return, so its absence is direct
evidence that every tick took the early exit. Meanwhile `runner_progress_at` was
being written, which proves the loop really was running rather than the instance
being inert — the 200 means something.

Tear down afterwards (`docker rm -f`) and confirm the container and the scratch
copy are gone. The live instance was untouched throughout: still `Up`, still
healthy, and `data/linki.db` was never opened for writing by the drill.

