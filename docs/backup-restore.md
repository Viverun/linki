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

### RTO — measured, and what it does not include

**0.01s wall-clock** for copy + open + `integrity_check` + `foreign_key_check` +
table verification + cookie decryption, on a 344 KB database.

State plainly what that number is and is not. It is the **data-restoration**
portion, and it is small because the database is small. Full operational RTO adds:

| Phase | Measured? |
|---|---|
| Copy, verify, decrypt | **yes — 0.01s** |
| `docker compose down` / `up -d` and app boot | **no** |
| Re-authenticating each account (stale cookies) | **no — manual, and the dominant term** |

The container phases are deliberately unmeasured here: measuring them would mean
booting a second Linki instance against a restored copy, and two processes
against one account is precisely the hazard the single-process precondition
exists to prevent. Measure them at the next real deploy, and update this table.

The honest summary: **the data comes back in under a second; the system comes
back at the speed of re-authenticating accounts.**
