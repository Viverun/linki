# Phase 2 baseline

Captured at `4af831c`, immediately after the Phase 1 restart. Phase 1's rules
carry forward — see `docs/phase1-baseline.md` and `docs/audit-corrections.md`.

## Why md5 is no longer a tripwire

Phase 1 could assert `data/linki.db` was byte-identical because nothing wrote to
it. The container is now running: the heartbeat writes every 30 s and SQLite
checkpoints the WAL into the main file on its own schedule, so the md5 changes
legitimately and constantly. It is replaced by the tripwires below.

## Gates

| Gate | Baseline |
|---|---|
| HEAD | `4af831c` |
| `git status --porcelain` | 6 untracked local-only files, 0 modified |
| `npx tsc --noEmit` | 0 errors |
| `npm test` | **264** = 238 tracked + 26 untracked (`demo-harness`) |
| `npm run build` | exit 0 |
| `npx eslint .` | 40 problems (24 errors, 16 warnings) — all pre-existing |

## DB tripwires

| Tripwire | Baseline |
|---|---|
| **Schema fingerprint** (sha256 of sorted `sqlite_master.sql`) | `9436e671d7feec5768cc2f3f2da5ba50c48d6846c08efcf7aba84b4d4871509c` |
| `integrity_check` / `foreign_key_check` | ok / 0 |
| Tables | 28 |
| `step_side_effects` rows | **0** (matters for P2-3's scheme switch) |
| Key counts | accounts 1 · targets 5 · lists 4 · list_targets 6 · workflows 5 · workflow_steps 7 · runs 9 · run_profiles 9 · run_profile_tracks 9 · logs 40 · app_settings 9 · users 1 |
| Runs | 7 completed, 2 paused, **0 running** |
| Tracks | 5 completed, 2 failed, 2 in_progress |
| WAL / main | 2,830,472 B / 335,872 B |

**Live invitation rows — must not change:**

| Target | `connection_requested_at` | degree | message_sent_at |
|---|---|---|---|
| `raise-faster` | 2026-08-09T05:27:59.968Z | null | null |
| `zahidhamdule` | 2026-08-08T15:35:31.779Z | null | null |
| `Vivi undefined` | 2026-08-08T12:00:43.240Z | 1 | 2026-08-08T13:49:29.058Z |
| `demo-investor-4aa78a428` | 2026-08-08T14:36:07.517Z | 1 | 2026-08-08T14:53:49.997Z |

## Runtime

`/api/health` → **200** `{"ok":true,"db":"ok","schema":"ok","runner":{"state":"healthy","phase":"loop","consecutive_tick_failures":0}}`
Docker: `health=healthy`, `FailingStreak=0`, `restarts=0`.

## Existing coverage of the surfaces Phase 2 touches

**Zero, on every one**: watchdog, `restart_will_help`, webhook/alerting, backup,
`current_step_id`, a steps `PUT`, the UI banner. Confirmed by grep across all
tracked test files. As in Phase 1, the tests written in this phase are the only
tripwire between these changes and a silent regression.

## Q7 — periodic timers

The only in-process periodic timer other than the runner loop is
`lib/update-check.ts:94` — `setInterval(checkForUpdate, 12h).unref()`. The
watchdog therefore needs its own registration, and follows that precedent:
`node:timers` `setInterval` with `.unref()`, so it can never be the reason a
process cannot exit.

## Q8 — every 503 reason, and whether a restart helps

| Reason | Payload | Restart helps? |
|---|---|---|
| DB unreachable (`health.ts:54`) | `db:"unreachable"` | **No** — bad `NEXTAUTH_SECRET`, file permissions, or corruption repeat identically |
| Schema incomplete (`:68`) | `schema:"incomplete", reason:"step_side_effects_missing"` | **No** — a swallowed migration repeats |
| Runner dead (`:82`) | `db:"ok", schema:"ok", runner.state:"dead"` | **Yes** — this is the only one |
| Query failed (`:102`) | `schema:"unknown"` | **No** — an unexpected DB error repeats |

Three of four 503s are restart-proof. A supervisor acting on the raw exit code
would restart-loop forever and kill in-flight work each time — which is why P2-1
adds `restart_will_help` and gates the probe on it.

## Q9 — how steps are saved today

`pages/workflows/[id].tsx:774-781` then `:796-830`:
`PUT /api/workflows/[id]` (prompt) → `GET .../steps` → **N × `DELETE .../steps/{id}`**
→ **M × `POST .../steps`**. Every save destroys and re-creates every step with a
fresh `randomUUID()` (`steps.ts:50`). Fetch count per save = `2 + N + M`.

Fields POSTed: `step_type, track, connect_note, message_body, template_id,
template_ids, email_subject, email_body, email_signature, email_position,
message_position, ai_enabled, ai_model, ai_prompt, ai_max_words, ai_language`.

This is NF-1, and it is the sole reason `step_ref` is `"pos:<message_position>"`.

## Q10 — what is required to decrypt `accounts.cookies_json`

`lib/crypto.ts`: **AES-256-GCM**, key = `hkdfSync("sha256", NEXTAUTH_SECRET, ""
/* empty salt */, "linki-secret-encryption", 32)`. Format `v1:iv:tag:ciphertext`.

The only input outside the database is **`NEXTAUTH_SECRET`**, which lives in
`.env.local` on the host (untracked; mounted via `env_file` in compose).

**Therefore a database backup without `NEXTAUTH_SECRET` is worthless for the thing
that matters most:** you would recover targets, workflows and history, and be
locked out of every LinkedIn account, requiring manual re-authentication of each.
P2-4 must treat the secret as part of the backup set, stored separately from the
DB copy.

## Single-process precondition (P2-1)

Verified inside the running container, not inferred from config:

```
PID 1   npm start
PID 19  sh -c next start
PID 20  next-server (v16.1.6)     <- the only Node runtime
```

No cluster mode, no PM2, no child spawning in application code, no
`replicas`/`scale` in `docker-compose.yml`.

**This is now load-bearing.** The P2-1 watchdog actively re-establishes loops, so
running two processes against one `/data` volume produces two runners on one
LinkedIn account. See NF-7.
