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
| `git status --porcelain` | **0 untracked** — the five local-only paths moved to `.git/info/exclude` (see the identity tripwire below; this row said "six" until 2026-08-10) |
| `npx tsc --noEmit` | 0 errors |
| `npm test` | **264** = 238 tracked + 26 untracked (`demo-harness`) |
| `npm run build` | exit 0 |
| `npx eslint .` | 40 problems (24 errors, 16 warnings) — all pre-existing |

## DB tripwires

| Tripwire | Baseline |
|---|---|
| **Schema fingerprint** — recipe below, not "sorted" loosely | `9436e671d7feec5768cc2f3f2da5ba50c48d6846c08efcf7aba84b4d4871509c` |
| `integrity_check` / `foreign_key_check` | ok / 0 |
| Tables | 28 |
| `step_side_effects` rows | **0** (matters for P2-3's scheme switch) |
| Key counts | accounts 1 · targets 5 · lists 4 · list_targets 6 · workflows 5 · workflow_steps 7 · **runs 8** · **run_profiles 8** · **run_profile_tracks 8** · **logs 38** · app_settings 9+ · users 1 — see the authorised-deletion log below |
| Runs | 7 completed, **1 paused**, 0 running |
| Tracks | 5 completed, 2 failed, **1 in_progress** |

**The fingerprint recipe, written out because "sorted" was ambiguous** (added
2026-08-15). Ordering by `sql` does not reproduce the recorded hash; ordering by
`name` does. A tripwire you cannot re-derive is not a tripwire:

```js
const sql = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
              .all().map(r => r.sql);
crypto.createHash("sha256").update(sql.join("\n")).digest("hex");
```

Re-verified against the live DB on 2026-08-15: **unchanged**, along with every
other row in this table and all four invitation rows below.
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

## Working-tree tripwire — identity, not count

"Exactly 6 untracked" drifts silently: one artifact replaced by another still
counts six. The tripwire is now these **specific** paths, each of which must
exist on disk and be reported ignored by `git check-ignore`:

```
diag.ts
invite-diag.ts
whoami.ts
scripts/demo-connect-message.ts
tests/demo-harness.test.ts
```

**Five, not six.** `lib/linkedin/runner.ts.bak` was deleted on 2026-08-10: it was
byte-identical to `git show 7d8b930:lib/linkedin/runner.ts`, so it held nothing
history did not, while being a stale snapshot of the file that changed most across
two phases — the kind of thing someone eventually diffs against and reasons from.

They live in `.git/info/exclude`, not `.gitignore`, so QA-artifact filenames do
not appear in a public repository — and because an ignored file cannot be staged
by `git add -A` without `-f`, which turns a habit into a control.

`scripts/preflight.sh` enforces this, plus `tsc`, `npm test`, and the eslint
baseline, and must pass before every commit.

## Test-count reconciliation

The count is a tripwire, so it has to reconcile exactly. A row that is known to
be wrong teaches you to stop trusting the column.

| Point | Tests | How it was established |
|---|---|---|
| Phase 2 baseline (`4af831c`) | 264 | recorded above: 238 tracked + 26 untracked |
| … Phase 2 commits through `613d04d` | *not recorded per commit* | see the note below |
| Pre-P2-2 (`613d04d`) | **287** | measured: `git revert --no-commit HEAD` on `943df6e`, then `npm test` |
| P2-2 (`943df6e`) | **304** | 287 + 17 new in `tests/degraded-alerting.test.ts` |
| §1 isolation (`c89ca98`) | **308** | 304 + 4 new in `tests/health-isolation.test.ts` |
| P2-4 backup (`252d784`) | **321** | 308 + 13 new in `tests/backup.test.ts`; confirmed by revert rehearsal returning exactly 308 |
| §A/§B/§C (`8bc6aaa`) | **332** | 321 + 5 NF-8 in `lib/linkedin/session.test.ts` + 3 in `tests/session-read-path.test.ts` + 3 C2 in `tests/backup.test.ts` |
| N7 + F4 (`130cff4`) | **339** | 332 + 3 N7 in `lib/linkedin/connect.test.ts` + 4 in `tests/signup-closed.test.ts` |
| N7b (`99b83d5`) | **347** | 339 + 7 in `tests/null-vanity.test.ts` + 1 ordering test in `lib/linkedin/connect.test.ts` |
| NF-9 + §2/§3 docs (`80a1335`) | **356** | 347 + 8 in `tests/host-allowlist.test.ts` + 1 split out in `tests/null-vanity.test.ts` |
| NF-10 + source-text fix (this commit) | **367** | 356 + 3 in `tests/host-expression-drift.test.ts` + 8 in `tests/support/source-text.test.ts` |

**Re-derived end to end from git on 2026-08-15** (W sweep, see
`docs/audit-corrections.md`). Every recorded row above matches a recomputation
from `git show` of each commit's test files. One thing that recomputation needs,
which is invisible to `grep -c '^test('`: **three `test()` calls are declared
inside `for` loops** and expand to eleven at runtime —
`tests/runner-claim.test.ts:78` (4), `runner-connect-idempotence.test.ts:223` (4),
`slice-c-connection-state.test.ts:429` (3). All three predate both baselines, so
the `+11` is constant on every row: 140+11=151 published at `85934ab`,
227+11=238 tracked at `4af831c`, 330+11=341 tracked at `ca35aaf`. Add 26 for
`demo-harness` to get the local figure. A static grep lands 11 short every time.

**Counting untracked test files:** use `git ls-files --others` or
`git check-ignore -v`, **not** `git ls-files --others --exclude-standard` — the
`--exclude-standard` flag suppresses ignored files, which is exactly what the
five local-only paths are. A report using it concluded "0 untracked" on
2026-08-15; the true figure is 1 (`tests/demo-harness.test.ts`, 26 tests).

**The 288 → 287 correction.** The P2-2 working notes carried 287 as "288",
which made the arithmetic land at 305 against a measured 304. The gap was
resolved by measurement, not by adjusting a number until it fit:

1. `git revert --no-commit` on the P2-2 commit, then `npm test` → **287**.
2. Inventory diff of every `test("…")` declaration in `tests/` between
   `HEAD~1` and `HEAD`, excluding the new file → **224 before, 224 after,
   zero removed or renamed**, confirming no pre-existing test was lost.

The commit touched exactly one test file, and it was the new one. The
off-by-one was in note-keeping, not in the suite.

**A second miscount, caught by this table.** The `a390e26` commit message was
written claiming 337 and the suite reported 332. The arithmetic above
(321+5+3+3) resolves to 332; the message was corrected by amend before anything
was pushed. Twice now the error has been in transcribing a count rather than in
the suite — which is the argument for computing the row from its parts here
rather than copying a number across from a terminal.

**Per-commit counts before `613d04d` were not recorded at the time.** They are
deliberately left blank rather than reconstructed: re-deriving them now would
mean checking out old commits and re-running, and a number recovered that way
and written into a baseline table is indistinguishable, later, from one measured
when it mattered. Blank is honest; a plausible-looking number is not.

## Authorised deletions — keep this current

Row counts replaced `md5` as the integrity signal, so an authorised deletion that
leaves the baseline stale turns every later check into an unexplained divergence.
That is precisely how a real corruption gets waved through months later. Every
deliberate change to the counts is recorded here, in the same commit that makes it.

### 2026-08-10 — `prodqa-rf-track` and its parent run

**What:** the production-QA execution created during Phase 1's authorised Connect
test against `raise-faster` — 1 run (`prodqa-rf-run`), 1 run_profile
(`prodqa-rf-rp`), 1 track (`prodqa-rf-track`), 2 logs.

**Why:** production-shaped QA data that would mislead any future audit of "what
runs exist and why". Same precedent as Phase 1's `qa-phaseb-*` and `qa-restart-*`
cleanups.

**Authorised by:** operator, Phase 2 §2.

**Evidence preserved first:** the deletion cascades `logs`, which held the only log
rows for the one real LinkedIn invitation Linki has ever sent. Exported to
`data/backups/prodqa-rf-provenance-20260810T100615Z.json` before deleting, and referenced from
`docs/audit-corrections.md` as the provenance for Phase 1's connection-sending
claim. DB backup: `data/backups/pre-prodqa-delete-20260810T100615Z.db` (opened and verified).

**Counts:** runs 9 → **8** · run_profiles 9 → **8** · run_profile_tracks 9 → **8**
· logs 40 → **38**. Runs by status 7 completed / 2 paused → 7 completed / **1
paused**. Tracks 5/2/2 → 5/2/**1**.

**Unchanged and verified after:** schema fingerprint `9436e671d7feec57`;
`integrity_check` ok; `foreign_key_check` 0; all five referential checks 0; and the
`raise-faster` **target row with its real pending invitation**
(`connection_requested_at = 2026-08-09T05:27:59.968Z`) untouched — the target was
never part of this deletion.

**Cap-counter check:** no deleted `logs` row was dated today (both were 2026-08-09
against a current date of 2026-08-10). See the rule in `docs/operations.md`.
