# Phase 2 deploy

Eleven changes and a schema migration in one deploy. That is more than one deploy
should carry, and the consequence is that **every verification below has to
localise** — a single "it looks fine" at the end would tell you nothing about
which of eleven things broke. Each step has its own pass/fail.

Written in full before deploying. Written on 2026-08-16.

## What is in this bundle

| Change | What it does | How it is verified below |
|---|---|---|
| **P2-1** watchdog + supervisor | revives a dead runner loop; host script can restart the container | steps 5d, 5e |
| **NF-11** (inside P2-1) | the predicate no longer declines *silently* when a restart will not help | step 5d |
| **NF-12** | both liveness thresholds pinned on both sides | covered by the suite; no runtime surface |
| **P2-2** banner + webhook | a failing runner reaches a person | step 5f |
| **P2-3** step identity + migration | tracks pin a step **id**, saves are non-destructive, ledger keyed by `stepid:` | steps 5a, 5b, 5g |
| **N7 / N7b** | refuse to invite a stranger; null vanity fails closed | suite only — no live invitation is sent during this deploy |
| **NF-9 / NF-10** | host allowlist, and a tripwire against a third host expression | precheck 3.2 |
| **F4** | registration closes after the first owner | precheck 3.3 |
| **NF-8** | a session stored unencrypted is refused rather than silently used | precheck 3.1 |
| scanner + corpus work | source-text helpers delegate to TypeScript's parser | suite only |

**No LinkedIn action is performed by this deploy.** It is a schema migration and
a process restart. Step 5i proves that rather than assuming it.

## 1. Rollback — answered before deploying, not assumed

**Question:** the migration is additive (`current_step_id` +
`ix_rpt_current_step_id`), and a rollback replaces the *image*, not the *schema*.
So after a rollback the **old code runs against the new schema.** Is that safe?

**Answer: yes. Rollback remains available after the migration, because the change
is additive and the old image tolerates the extra nullable column.**

Established two ways rather than by reasoning alone.

**Static, against the code actually running in the container:**

| Risk | Finding |
|---|---|
| `INSERT` without a column list | none — both `run_profile_tracks` inserts name their columns explicitly (`pages/api/runs/index.ts:140`, `enroll.ts:104`), so an extra nullable column is invisible to them |
| `INSERT INTO <table> VALUES (...)` anywhere | zero matches |
| `SELECT *` on `run_profile_tracks` with shape assumptions | zero matches in production code |
| schema-shape validation | `/api/health` checks table **existence** via `sqlite_master`, not column shape — an added column cannot trip it |
| old image re-running its own migrations | it has no `current_step_id` migration, and every migration is `try/exec/catch`, so nothing fights |

**Empirical — the old image booted against a migrated copy:**

```
docker run -d --name linki-rollback-drill -p 127.0.0.1:3999:3000 \
  -v <scratch>:/data --env-file .env.local \
  -e NODE_ENV=production -e LINKI_DB_PATH=/data/linki.db -e ALERT_WEBHOOK_URL= \
  linki-linki
```

Result: `Up (healthy)`; `/api/health` → `200 {"ok":true,"db":"ok","schema":"ok",
"runner":{"state":"healthy","consecutive_tick_failures":0}}`; zero errors, zero
LinkedIn/playwright/chromium references in its log; row counts in the copy
unchanged (8 tracks, 4 invitation rows, 3 with `current_step_id` — the old image
ignores the column entirely). Container removed, scratch copy deleted.

**One thing that drill also confirmed:** the old image's health payload has **no
`restart_will_help` field**. That is the documented "supervisor inert" condition —
the running image predates P2-1, so the watchdog cannot fire today no matter how
it is configured. Step 5c exists to prove that changes.

> If a future migration is **not** additive — a dropped column, a narrowed
> `CHECK`, a rewritten table — this section must be re-answered before deploying,
> and the answer may well be "rollback is not available after the migration",
> which changes the risk of the whole deploy.

## 2. Known-good rollback target

Record before touching anything:

```sh
docker inspect -f '{{.Image}}' linki-linki-1        # image id, the rollback target
docker images linki-linki --no-trunc --format '{{.ID}} {{.CreatedAt}}'
```

Restore command (one line):

```sh
docker tag <recorded-image-id> linki-linki:latest && docker compose up -d --force-recreate linki
```

The schema stays migrated after a rollback; §1 is why that is safe.

## 3. Prechecks — all read-only, all must be green

### 3.1 NF-8 — every stored session is enveloped
A `cookies_json` without the `v1:` envelope now **throws** rather than being
silently used, so a legacy plaintext row would break that account at the first
step. Expect every account `enveloped: true`.

### 3.2 NF-9 — every `targets.linkedin_url` passes the host allowlist
A legacy odd-host row would start failing its step after this deploy. Parse each
URL and require the hostname to end in `linkedin.com`.

### 3.3 F4 — exactly one user row
Registration closes after the first owner, so a 403 on signup is now *expected
behaviour*, not a fault. Confirm the count is 1 so nobody reads that 403 as a
regression.

### 3.4 P2-3 — no run is `running`, and record the backfill target
Editing steps under a live run is refused (409), and the migration backfills
against current state. Record all 8 tracks and their `current_step` so step 5b
has something specific to verify rather than "it looks populated".

### 3.5 Expected post-migration schema fingerprint

```
88dff891…   (from the X3.4 rehearsal; pre-migration it is 9436e671…)
```

Recipe — `ORDER BY name`, not "sorted" loosely:

```js
crypto.createHash("sha256").update(
  db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
    .all().map(r => r.sql).join("\n")
).digest("hex")
```

Step 5a compares against this value. "It changed" is not a verification.

**Prechecks as measured on 2026-08-16:** NF-8 enveloped ✓ (1 account) · NF-9 5/5
URLs pass ✓ · F4 users = 1 ✓ · runs 7 completed + 1 paused, **0 running** ✓ ·
tracks 8 (5 completed idx 1–2, 2 failed idx 0–1, 1 in_progress idx 0) ·
`step_side_effects` 0 · targets 5, runs 8, logs 38.

## 4. Procedure

Stop at any failure. Do not continue past a red step.

1. **Record the rollback target** (§2).
2. **Back up** — `node scripts/backup.mjs`, then confirm the snapshot **opens and
   verifies**. This is `backup.mjs`'s first production use; a backup that has
   never been restored is a hope, not a backup.
3. **Prechecks** (§3), all green.
4. **Rebuild and restart** — `docker compose up -d --build linki`.
5. **Verify independently, in order** (§5). Each has its own pass/fail.
6. **Any failure → roll back (§2), report, stop.**

## 5. Verification — each step localises to one change

| # | Check | Pass condition |
|---|---|---|
| 5a | **Schema** | `current_step_id` and `ix_rpt_current_step_id` exist; `step_side_effects` + its 2 indexes exist; fingerprint **equals `88dff891…`** |
| 5b | **Backfill** | 3 non-terminal tracks have a `current_step_id`; the 5 completed are NULL |
| 5c | **Health contract** | `/api/health` → 200, `health_schema: 1`, and **`restart_will_help` PRESENT** — its absence is what has left the supervisor inert |
| 5d | **Supervisor predicate live** | exits **1** on a dead+fixable payload, **0** on dead+unfixable. NF-11's fix; this is the first deploy where it can actually restart anything |
| 5e | **Watchdog armed** | per the "is it armed" step in `docs/operations.md` — verbose predicate run, not just "the cron line exists" |
| 5f | **Banner** | renders on a forced degraded state and clears when it resolves |
| 5g | **Step ids stable** | two real saves in the UI leave `workflow_steps.id` unchanged |
| 5h | **Data untouched** | row counts and all four invitation rows identical to §3 |
| 5i | **Zero LinkedIn navigation** | `Tick —` count plus zero `linkedin.com` / `playwright` / `chromium` / `sync-accepted` in container logs |

**md5 is not a check.** The heartbeat writes every 30 s, so `data/linki.db`
changes constantly and legitimately; 5h uses row counts and the invitation rows,
which is what `docs/phase2-baseline.md` replaced md5 with.

## 6. Observation window before Gate A

The watchdog and supervisor go live here for the first time, so the deploy is not
finished when the checks pass. Observe **≥ 1 hour / ~120 ticks**:

- `/api/health` stays `healthy`, `consecutive_tick_failures` stays 0
- `runner_revivals` does **not** increment — a revival in a quiet hour means the
  watchdog is firing against a healthy runner, which is a P0
- `RestartCount` unchanged
- WAL growth tracks the measured ~8.6 pages/tick estimate

Report observed against predicted. **A prediction that misses is a finding**, not
a rounding error — the estimate is what the restart-budget and disk headroom
arguments rest on.

## 7. Gate A interaction — decide before, not during

The supervisor can now restart the container. Gate A is a *watched live run*, and
a restart mid-step would kill a real LinkedIn action and manufacture the
`in_flight` dead end the ledger exists to prevent.

**Disable the host-side watchdog for the duration of Gate A** (`docs/operations.md`
documents how, and why: a restart destroys evidence and can strand a message
step). A human is watching; automated restart adds only risk in that window.
Re-enable immediately afterwards and **verify it is armed again** — an
un-re-enabled supervisor is the silent failure this whole phase was about.

---

# Executed — 2026-08-16

## Result: deployed, all nine verifications green

| Step | Result |
|---|---|
| 1 rollback target recorded | `sha256:128d3445d84c…` (built 2026-08-10) |
| 2 backup + verified open | `linki-auto-20260816T150240Z.db` — 352 256 B, 28 tables, 100 rows, `integrity_check ok`, `foreign_key_check 0`, **and the stored session decrypted from the snapshot** (25 cookies). First production use of `backup.mjs`. It warned that `BACKUP_OFFSITE_DIR` is unset — accurate, and still true |
| 3 prechecks | NF-8 enveloped ✓ · NF-9 5/5 URLs pass ✓ · F4 users = 1 ✓ · 0 running runs ✓ · 8 tracks recorded |
| 4 rebuild + restart | image rebuilt, container recreated, `RestartCount=0` |
| **5a** schema | `current_step_id` ✓ · `ix_rpt_current_step_id` ✓ · `step_side_effects` + both indexes ✓ · fingerprint **`88dff8914b1471e7` = predicted** |
| **5b** backfill | non-terminal 3/3 have ids · terminal 5/5 NULL — exactly as rehearsed |
| **5c** health contract | 200 · `health_schema: 1` · **`restart_will_help` PRESENT** |
| **5d** supervisor predicate | dead+fixable → exit **1** · dead+unfixable → exit **0 and says why** (NF-11) · healthy → 0 |
| **5e** watchdog armed | verbose predicate: `state=healthy restart_will_help=false act=false`, exit 0 |
| **5f** banner state | healthy → forced 7 failures → **degraded** (`error_class: SqliteError`) → cleared → healthy |
| **5g** step ids stable | two saves, **both HTTP 200 with `"created": false`**, both ids unchanged |
| **5h** data untouched | targets 5 · runs 8 · tracks 8 · logs 38 · ledger 0 · all four invitation rows identical |
| **5i** zero LinkedIn navigation | 0 references to linkedin.com / playwright / chromium; **0 chromium processes**; container log is 11 lines |

**5f and 5g were run against a scratch instance of the newly-built image on a copy
of the database, not against live data.** Both require writes, and a live write
beyond the migration is outside what this deploy is authorised to do. The scratch
instance runs the same image, so it verifies the deployed artifact; live rows were
re-checked afterwards and are unchanged.

**A correction worth recording.** 5g was first run without authentication: both
saves returned **401**, the ids were unchanged *because nothing executed*, and the
check reported PASS. That is a test passing on a no-op — the exact shape the
positive-anchor rule exists to prevent, produced inside a deploy verification. It
was re-run with the internal service secret, where both saves returned 200 with
`"created": false` (proving UPDATE, not INSERT). **An HTTP-status anchor is now
part of the step**: a verification that cannot tell "unchanged because correct"
from "unchanged because nothing ran" is not a verification.

## Observation window

**112 ticks over 57 minutes** (15:47:46 → 16:44:38 UTC), sampled every 30 s.

| Predicted | Observed |
|---|---|
| `healthy` throughout | **112/112 samples healthy** |
| `consecutive_tick_failures` stays 0 | **0 in every sample** |
| no revival | **`runner_revivals` = 0**; the watchdog never fired |
| `RestartCount` unchanged | **0**, `FailingStreak` 0 |
| WAL grows ~8.6 pages/tick | **WAL did not grow at all** — see below |

The tick cadence is exact: 112 samples produced **112 distinct progress-marker
timestamps**, one per 30 s, so every sample observed a genuinely new tick rather
than the same one twice.

### The WAL prediction missed, and that is a finding

Predicted ~8.6 pages/tick — over 112 ticks that is roughly 3.9 MB of growth.
**Observed: zero.** The WAL was 4 120 032 bytes at T0 and 4 120 032 bytes at the
end. The main database grew by exactly one 4 096-byte page (352 256 → 356 352).

The model behind the prediction is wrong for a steady-state idle runner: SQLite
checkpoints the WAL back into the main file and then **reuses** the existing WAL
space instead of extending it. The WAL had already reached its high-water mark
before this deploy, so per-tick writes cycle inside it. Growth would resume only
if a checkpoint were blocked by a long-lived reader.

Two things follow. The disk-headroom argument that rested on monotonic WAL growth
is conservative rather than wrong — actual usage is lower. And **the 8.6
pages/tick figure has no derivation recorded anywhere in the repo**; it appears
only in the prompt that specified this deploy and in this document. Per the W4
mapping, a number nobody can re-derive is not a tripwire, so it is recorded here
as an observation and is not adopted as one.

### One environment artifact, not a Linki fault

An earlier sampling attempt recorded a 25-minute gap and one `UNREACHABLE`.
**Docker's own healthcheck shows the identical gap** (15:23:55 → 15:43:45) on its
independent 30 s timer, so the WSL2 host suspended and both probes stopped and
resumed together. `RestartCount` stayed 0, `FailingStreak` 0, and the app answered
in 8 ms immediately after. The window above was re-run cleanly afterwards.

Also corrected: a detached sampler was reported as "running" on the strength of a
`pgrep -f` that was matching its own command line, while its log file did not
exist. Re-run in bounded foreground chunks, which is where the 112 samples come
from.
