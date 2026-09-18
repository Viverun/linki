# C2-B2 Reply Hold and Open-Core OOO Policy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A captured email reply holds automated follow-ups until a decision exists; in the open-core build a TypeSafe/Jev judgment lifts the hold only for high-probability out-of-office replies; operators can resume; the LinkedIn limitation is visible (register row PR-03).

**Architecture:** The hold is derived from `email_replies` (`dispatched_at IS NULL` = undecided) — one source of truth shared by premium's dispatcher, the new open-core policy module, and operator actions. The runner checks it before any step. `lib/email/reply-policy.ts` asks Jev one fan-out request (Noul + optional Choice over code-extracted date candidates) and applies a threshold in code; decisions are recorded in the existing dispatch columns so the inbox UI renders them like premium's.

**Tech Stack:** Next.js 16 Pages Router, better-sqlite3 12, Node 22 `node:test` with module mocks, `@typesafe-ai/sdk` 0.6.0 (Node ≥ 20, zero deps).

**Spec:** `docs/superpowers/specs/2026-09-18-c2b2-reply-hold-ooo-policy-design.md`

## Global Constraints

- Node 22.23.0 in the isolated Docker gate (`npm run verify:c0`, lint mandatory); host preflight via `bash -lc` (nvm Node 24). Plain `node` outside `bash -lc` is broken.
- `node:test`, temp DB via `LINKI_DB_PATH`, no network, no browser. Follow `tests/message-idempotency.test.ts` / `tests/retry-ledger.test.ts` harness style.
- Commit hook runs tsc + full suite + eslint; `--no-verify` banned. Commit with `bash -lc 'git commit ...'`. Push only to `origin`.
- No change inside `ee/`; premium's dispatcher stays authoritative when `premium?.replies` exists.
- Hold = `email_replies.dispatched_at IS NULL` for a target; `targets.email_replied_at` keeps meaning "a person replied — stop".
- Threshold setting key `reply_ooo_threshold` in `app_settings`; default **0.9**; valid 0.5–0.99.
- Return-date reschedule only when Choice confidence ≥ **0.7** and the date parses to a future day; `next_step_at = max(existing, return_date + 1 day at 09:00 UTC)`.
- Fail-closed: judgment error → undecided (held); after **3** attempts → `human_reply` with reason `judgment failed 3 times — failing closed`.
- `dispatch_result_json` (open-core): `{ source: "open-core", decision, p_ooo, threshold, model, return_date, attempts, reason? }`; `classification_json`: `{ kind: "out_of_office" | "human_reply", summary }`.
- No send is ever triggered by the policy module; only the runner's C2-A ledger path sends.
- `@typesafe-ai/sdk` **0.6.0 exact**, resolved with `--strict-peer-deps`, audits (full + prod) recorded.

`RUN_ONE <file>` below means:
```bash
bash -lc 'NODE_ENV=test node --experimental-strip-types --experimental-test-module-mocks --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --disable-warning=ExperimentalWarning --import ./scripts/test-setup.mjs --test <file>'
```

---

## File map

| File | Responsibility |
| --- | --- |
| `lib/db.ts` | `email_replies.open_core_attempts` column (Task 1) |
| `lib/linkedin/runner.ts` | hold check before steps (Task 1) |
| `lib/email/reply-policy.ts` (new) | Jev judgment + policy + retry of undecided replies (Task 2) |
| `lib/email/reply-settings.ts` (new) | `getReplyOooThreshold`/`setReplyOooThreshold` (Task 2) |
| `lib/email/inbox.ts` | `dispatchCapturedReply` chooser; call `retryUndecidedReplies` (Task 3) |
| `pages/api/inbox/[replyId]/resume-followup.ts` (new) | operator resume (Task 4) |
| `pages/api/settings/reply-policy.ts` (new) | GET/PUT threshold (Task 5) |
| `pages/api/premium-status.ts` | `capabilities` (Task 5) |
| `pages/inbox.tsx`, `pages/settings.tsx`, `pages/workflows/[id].tsx` | UI: resume button, decision line, TypeSafe integration, threshold field, LinkedIn notice (Task 6) |
| `pages/api/runs/[id]/start.ts` | one-time LinkedIn-limit log (Task 6) |
| `package.json`, `package-lock.json` | SDK dependency (Task 2) |
| `scripts/typesafe-smoke.mjs` (new) | manual live check (Task 2) |
| `docs/production-readiness.md` | C2-B2 record (Task 7) |

---

### Task 1: Hold in the runner + `open_core_attempts` column

**Files:**
- Modify: `lib/db.ts` (append to `migrations[]`, before the closing `];` of the array)
- Modify: `lib/linkedin/runner.ts:1016-1026` (reply check in `executeStep`)
- Test: `tests/reply-hold.test.ts`

**Interfaces:**
- Produces: `email_replies.open_core_attempts INTEGER NOT NULL DEFAULT 0`; runner behaviour: undecided reply → `trWait(db, tr, 1)` + log `… awaiting decision — holding …`, no send, track stays `in_progress`.

- [ ] **Step 1: Write the failing test**

Create `tests/reply-hold.test.ts`:

```ts
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-reply-hold-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-reply-hold-tests";

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { namedExports: Record<string, unknown> }) => void;

const sends: string[] = [];
const realSender = await import("@/lib/email/sender");
mockModule("@/lib/email/sender", {
  namedExports: {
    ...realSender,
    sendEmail: async (_a: unknown, to: string) => { sends.push(to); return { accepted: [to], rejected: [], messageId: "<m@fake>" }; },
  },
});
const realSession = await import("@/lib/linkedin/session");
mockModule("@/lib/linkedin/session", {
  namedExports: { ...realSession, getSessionPage: async () => ({ close: async () => {} }), saveSessionState: async () => {} },
});

const { executeStep } = await import("@/lib/linkedin/runner");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

const LIMITS = { active_hours_start: 0, active_hours_end: 24, timezone: "UTC", working_days: "1,2,3,4,5,6,7", daily_connection_limit: 20, daily_message_limit: 50, daily_inmail_limit: 15 };
const EMAIL_LIMITS = { ...LIMITS, daily_email_limit: 50, ramp_up_enabled: 0, ramp_start_date: null };
let seq = 0;

/** One run with an email track (one email step) for a target with an email address. */
function scenario() {
  const n = ++seq; const db = getDb();
  const ids = { run: `run-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, track: `track-${n}`, target: `target-${n}`, email: `ea-${n}`, step: `step-${n}` };
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, email_subject, email_body, email_position, ai_enabled) VALUES (?, ?, 1, 'email', 'email', 0, 'Hi', 'Body', 1, 0)").run(ids.step, ids.wf);
  db.prepare("INSERT INTO email_accounts (id, name, from_email, smtp_host, smtp_port, smtp_secure, username, password, daily_email_limit) VALUES (?, 'F', 'sender@fixture.test', '127.0.0.1', 2525, 0, 'u', 'p', 50)").run(ids.email);
  db.prepare("INSERT INTO runs (id, workflow_id, status, email_account_id) VALUES (?, ?, 'running', ?)").run(ids.run, ids.wf, ids.email);
  db.prepare("INSERT INTO targets (id, full_name, first_name, linkedin_url, email) VALUES (?, 'Ada', 'Ada', ?, ?)").run(ids.target, `https://www.linkedin.com/in/ada-${n}/`, `ada-${n}@fixture.test`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(ids.profile, ids.run, ids.target, ids.email);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, current_step_id) VALUES (?, ?, 'email', 'in_progress', 0, ?)").run(ids.track, ids.profile, ids.step);
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(ids.target);
  const tr = { ...(db.prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(ids.track) as object), run_id: ids.run, target_id: ids.target, email_account_id: ids.email, account_id: `acct-${n}`, workflow_id: ids.wf };
  const stepRows = db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order").all(ids.wf);
  return { ids, tr, target, stepRows };
}
const run = (s: ReturnType<typeof scenario>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeStep(getDb(), s.ids.run, s.tr as any, s.target as any, s.stepRows as any, "acct-x", LIMITS, s.ids.email, EMAIL_LIMITS);
const track = (id: string) => getDb().prepare("SELECT state, next_step_at, error_message FROM run_profile_tracks WHERE id = ?").get(id) as { state: string; next_step_at: string | null; error_message: string | null };
function addReply(targetId: string, runId: string, opts: { dispatched?: boolean } = {}) {
  const id = `reply-${Math.random().toString(36).slice(2)}`;
  getDb().prepare("INSERT INTO email_replies (id, target_id, run_id, from_email, subject, body_text, received_at, dispatched_at) VALUES (?, ?, ?, 'x@y.test', 'Re', 'body', datetime('now'), ?)")
    .run(id, targetId, runId, opts.dispatched ? new Date().toISOString() : null);
  return id;
}
const lastLog = (runId: string) => (getDb().prepare("SELECT message FROM logs WHERE run_id = ? ORDER BY rowid DESC LIMIT 1").get(runId) as { message: string } | undefined)?.message ?? "";

test("H1 an undecided reply holds the step: no send, track waits ~1h, log says holding", async () => {
  sends.length = 0; const s = scenario();
  addReply(s.ids.target, s.ids.run);
  await run(s);
  assert.equal(sends.length, 0);
  const t = track(s.ids.track);
  assert.equal(t.state, "in_progress");
  assert.ok(t.next_step_at && new Date(t.next_step_at).getTime() - Date.now() > 50 * 60_000, "rescheduled about an hour out");
  assert.match(lastLog(s.ids.run), /awaiting decision — holding/);
});

test("H2 a decided reply (dispatched_at set, no stamp) lets the step proceed", async () => {
  sends.length = 0; const s = scenario();
  addReply(s.ids.target, s.ids.run, { dispatched: true });
  await run(s);
  assert.equal(sends.length, 1);
});

test("H3 email_replied_at still skips all tracks with 'Lead replied' (unchanged)", async () => {
  sends.length = 0; const s = scenario();
  getDb().prepare("UPDATE targets SET email_replied_at = datetime('now') WHERE id = ?").run(s.ids.target);
  await run(s);
  assert.equal(sends.length, 0);
  assert.equal(track(s.ids.track).state, "skipped");
  assert.equal(track(s.ids.track).error_message, "Lead replied");
});

test("H4 open_core_attempts column exists with default 0", () => {
  const cols = (getDb().prepare("PRAGMA table_info(email_replies)").all() as Array<{ name: string; dflt_value: string | null }>);
  const col = cols.find(c => c.name === "open_core_attempts");
  assert.ok(col, "column missing");
  assert.equal(col!.dflt_value, "0");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `RUN_ONE tests/reply-hold.test.ts` → H1 FAILS (a send happens), H4 FAILS (column missing). H2/H3 pass already.

- [ ] **Step 3: Implement**

`lib/db.ts` — append to `migrations[]` (after the `run_profile_tracks.current_step_id` index line, before `];`):

```ts
    // C2-B2 (PR-03): how many times the open-core reply policy tried and failed
    // to get a judgment for this reply. Three failures fail closed (human_reply).
    "ALTER TABLE email_replies ADD COLUMN open_core_attempts INTEGER NOT NULL DEFAULT 0",
```

`lib/linkedin/runner.ts` — directly after the existing `if (replyCheck?.last_replied_at || replyCheck?.email_replied_at) { … return; }` block:

```ts
  // C2-B2 (PR-03): a captured reply with no decision yet HOLDS this contact on
  // both channels. Nothing here is terminal — a later decision either lifts the
  // hold (out-of-office, operator resume) or stamps email_replied_at, which the
  // branch above then turns into the usual skip. In the open-core build this is
  // the only thing standing between "a person replied" and the next send.
  const undecided = db.prepare(
    "SELECT from_email FROM email_replies WHERE target_id = ? AND dispatched_at IS NULL ORDER BY received_at DESC LIMIT 1"
  ).get(target.id) as { from_email: string } | undefined;
  if (undecided) {
    log(db, runId, target.id, "info",
      `Reply from ${undecided.from_email} awaiting decision — holding ${tr.track} track for ${target.full_name ?? target.linkedin_url}`);
    trWait(db, tr, 1);
    return;
  }
```

- [ ] **Step 4: Run the tests**

Run: `RUN_ONE tests/reply-hold.test.ts` → H1–H4 PASS. Then `RUN_ONE tests/email-idempotency.test.ts`, `RUN_ONE tests/message-idempotency.test.ts` → unchanged PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add lib/db.ts lib/linkedin/runner.ts tests/reply-hold.test.ts
bash -lc 'git commit -q -m "C2-B2/PR-03: undecided email replies hold both tracks before any send; open_core_attempts column"'
```

---

### Task 2: Open-core reply policy module (Jev judgment + decisions) and the SDK dependency

**Files:**
- Create: `lib/email/reply-settings.ts`, `lib/email/reply-policy.ts`, `scripts/typesafe-smoke.mjs`
- Modify: `package.json`, `package-lock.json`
- Test: `tests/reply-policy.test.ts`

**Interfaces:**
- Consumes: `email_replies.open_core_attempts` (Task 1); `decryptSecret` from `@/lib/crypto`; `integrations` row `key = 'typesafe'`.
- Produces:
  ```ts
  // lib/email/reply-settings.ts
  export const DEFAULT_REPLY_OOO_THRESHOLD = 0.9;
  export function getReplyOooThreshold(db): number;          // clamps to [0.5, 0.99]
  export function setReplyOooThreshold(db, value: number): void; // throws RangeError outside [0.5, 0.99]
  // lib/email/reply-policy.ts
  export interface ReplyJudgment { pOoo: number; model: string; returnDate: { chosen: string | null; confidence: number } | null }
  export type Judge = (state: ReplyState, dateCandidates: string[]) => Promise<ReplyJudgment>;
  export interface ReplyState { reply: { from: string; subject: string; body: string; received_at: string }; our_last_email: { subject: string; body: string } | null; today: string }
  export type ReplyDecision = "ooo_continue" | "human_reply" | "operator_continue";
  export function extractDateCandidates(body: string): string[];           // ≤ 8 spans
  export function parseReturnDate(span: string, today: Date): Date | null;
  export function jevJudge(apiKey: string): Judge;                          // real SDK-backed judge
  export async function decideReplyOpenCore(db, replyId: string, judge?: Judge): Promise<ReplyDecision | "undecided">;
  export async function retryUndecidedReplies(db, judge?: Judge): Promise<number>; // count decided
  ```

- [ ] **Step 1: Add the dependency (manifests only, PR-10 discipline)**

Edit `package.json` `dependencies`: add `"@typesafe-ai/sdk": "0.6.0"` (exact, alphabetical). Then regenerate the lock and audit inside the Node 22 image the gate uses (copied manifests only):

```bash
mkdir -p /tmp/c2b2-dep && cp package.json package-lock.json /tmp/c2b2-dep/
docker run --rm -v /tmp/c2b2-dep:/w -w /w --user 1000:1000 -e HOME=/tmp/home -e npm_config_cache=/tmp/npmcache node:22-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2 sh -c '
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund --strict-peer-deps 2>&1 | tail -2 &&
  npm ls @typesafe-ai/sdk --package-lock-only 2>&1 | tail -3 &&
  for f in "" "--omit=dev"; do echo "audit $f"; npm audit --package-lock-only --ignore-scripts $f --json 2>/dev/null | node -e "let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const j=JSON.parse(d);console.log(JSON.stringify(j.metadata.vulnerabilities))})"; done'
cp /tmp/c2b2-dep/package-lock.json package-lock.json && git diff --check && bash -lc 'npm ci --no-audit --no-fund >/dev/null && npm rebuild better-sqlite3 >/dev/null && node -e "console.log(require(\"@typesafe-ai/sdk/package.json\").version)"'
```

Expected: lock resolves; `@typesafe-ai/sdk@0.6.0` at root with no nested deps; both audits `{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}` (record the actual numbers in your report); host prints `0.6.0`.

- [ ] **Step 2: Write the failing tests**

Create `tests/reply-policy.test.ts`:

```ts
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-reply-policy-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-reply-policy-tests";

const { getDb } = await import("@/lib/db");
const { decideReplyOpenCore, retryUndecidedReplies, extractDateCandidates, parseReturnDate } = await import("@/lib/email/reply-policy");
const { getReplyOooThreshold, setReplyOooThreshold } = await import("@/lib/email/reply-settings");
const { encryptSecret } = await import("@/lib/crypto");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

type Judgment = { pOoo: number; model: string; returnDate: { chosen: string | null; confidence: number } | null };
const judgeReturning = (j: Judgment) => async () => j;
const judgeThrowing = () => async () => { throw new Error("synthetic judge failure"); };

let seq = 0;
function scenario(opts: { body?: string; nextStepAt?: string | null } = {}) {
  const n = ++seq; const db = getDb();
  const ids = { run: `run-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, track: `track-${n}`, target: `target-${n}`, reply: `reply-${n}` };
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(ids.run, ids.wf);
  db.prepare("INSERT INTO targets (id, full_name, linkedin_url, email) VALUES (?, 'Ada', ?, ?)").run(ids.target, `https://www.linkedin.com/in/ada-${n}/`, `ada-${n}@fixture.test`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, next_step_at, last_email_subject, last_email_body) VALUES (?, ?, 'email', 'in_progress', 1, ?, 'Our subject', 'Our body')").run(ids.track, ids.profile, opts.nextStepAt ?? null);
  db.prepare("INSERT INTO email_replies (id, target_id, run_id, from_email, subject, body_text, received_at) VALUES (?, ?, ?, ?, 'Re: Our subject', ?, datetime('now'))")
    .run(ids.reply, ids.target, ids.run, `ada-${n}@fixture.test`, opts.body ?? "I am out of the office until 2 October 2026 with limited access to email.");
  return ids;
}
const reply = (id: string) => getDb().prepare("SELECT dispatched_at, dispatch_result_json, classification_json, classification_error, open_core_attempts FROM email_replies WHERE id = ?").get(id) as
  { dispatched_at: string | null; dispatch_result_json: string | null; classification_json: string | null; classification_error: string | null; open_core_attempts: number };
const target = (id: string) => getDb().prepare("SELECT email_replied_at FROM targets WHERE id = ?").get(id) as { email_replied_at: string | null };
const track = (id: string) => getDb().prepare("SELECT next_step_at, state FROM run_profile_tracks WHERE id = ?").get(id) as { next_step_at: string | null; state: string };
const withKey = () => getDb().prepare("INSERT INTO integrations (key, api_key) VALUES ('typesafe', ?) ON CONFLICT(key) DO UPDATE SET api_key = excluded.api_key").run(encryptSecret("synthetic-key"));

test("P1 high-probability OOO continues: decision recorded, no stamp, track rescheduled after the return date", async () => {
  withKey(); const s = scenario({ nextStepAt: null });
  const d = await decideReplyOpenCore(getDb(), s.reply, judgeReturning({ pOoo: 0.97, model: "jev-test", returnDate: { chosen: "2 October 2026", confidence: 0.9 } }));
  assert.equal(d, "ooo_continue");
  const r = reply(s.reply);
  assert.ok(r.dispatched_at);
  assert.deepEqual(JSON.parse(r.dispatch_result_json!), { source: "open-core", decision: "ooo_continue", p_ooo: 0.97, threshold: 0.9, model: "jev-test", return_date: "2026-10-02", attempts: 1 });
  assert.deepEqual(JSON.parse(r.classification_json!), { kind: "out_of_office", summary: "Automatic out-of-office reply (p=0.97); back 2026-10-02" });
  assert.equal(target(s.target).email_replied_at, null);
  assert.equal(track(s.track).next_step_at, "2026-10-03T09:00:00.000Z");
  const act = getDb().prepare("SELECT body FROM activity_logs WHERE target_id = ? ORDER BY rowid DESC LIMIT 1").get(s.target) as { body: string };
  assert.match(act.body, /Out-of-office reply — follow-up continues after 2026-10-03/);
});

test("P2 return date never moves next_step_at earlier", async () => {
  withKey(); const s = scenario({ nextStepAt: "2026-12-01T00:00:00.000Z" });
  await decideReplyOpenCore(getDb(), s.reply, judgeReturning({ pOoo: 0.97, model: "jev-test", returnDate: { chosen: "2 October 2026", confidence: 0.9 } }));
  assert.equal(track(s.track).next_step_at, "2026-12-01T00:00:00.000Z");
});

test("P3 low-confidence or missing return date leaves the schedule alone", async () => {
  withKey(); const s = scenario({ nextStepAt: null });
  await decideReplyOpenCore(getDb(), s.reply, judgeReturning({ pOoo: 0.95, model: "jev-test", returnDate: { chosen: "2 October 2026", confidence: 0.4 } }));
  assert.equal(track(s.track).next_step_at, null);
  assert.equal(JSON.parse(reply(s.reply).dispatch_result_json!).return_date, null);
});

test("P4 below threshold is a human reply: stamp email_replied_at, decision recorded, tracks untouched here", async () => {
  withKey(); const s = scenario({ body: "Not interested, please stop emailing me." });
  const d = await decideReplyOpenCore(getDb(), s.reply, judgeReturning({ pOoo: 0.12, model: "jev-test", returnDate: null }));
  assert.equal(d, "human_reply");
  assert.ok(target(s.target).email_replied_at);
  assert.equal(JSON.parse(reply(s.reply).dispatch_result_json!).decision, "human_reply");
  assert.equal(JSON.parse(reply(s.reply).classification_json!).kind, "human_reply");
  assert.equal(track(s.track).state, "in_progress", "the runner, not the policy, converts the stamp into a skip");
});

test("P5 a judge failure leaves the reply undecided with the error and attempts=1", async () => {
  withKey(); const s = scenario();
  const d = await decideReplyOpenCore(getDb(), s.reply, judgeThrowing());
  assert.equal(d, "undecided");
  const r = reply(s.reply);
  assert.equal(r.dispatched_at, null);
  assert.match(r.classification_error ?? "", /synthetic judge failure/);
  assert.equal(r.open_core_attempts, 1);
  assert.equal(target(s.target).email_replied_at, null);
});

test("P6 third failure fails closed as human_reply with a reason", async () => {
  withKey(); const s = scenario();
  await decideReplyOpenCore(getDb(), s.reply, judgeThrowing());
  await decideReplyOpenCore(getDb(), s.reply, judgeThrowing());
  const d = await decideReplyOpenCore(getDb(), s.reply, judgeThrowing());
  assert.equal(d, "human_reply");
  const j = JSON.parse(reply(s.reply).dispatch_result_json!);
  assert.equal(j.reason, "judgment failed 3 times — failing closed");
  assert.equal(j.attempts, 3);
  assert.ok(target(s.target).email_replied_at);
});

test("P7 missing API key behaves like a judge failure (undecided)", async () => {
  getDb().prepare("DELETE FROM integrations WHERE key = 'typesafe'").run();
  const s = scenario();
  const d = await decideReplyOpenCore(getDb(), s.reply); // real judge, no key
  assert.equal(d, "undecided");
  assert.match(reply(s.reply).classification_error ?? "", /TypeSafe API key/);
  withKey();
});

test("P8 an already-decided reply is a no-op (operator decisions win)", async () => {
  withKey(); const s = scenario();
  getDb().prepare("UPDATE email_replies SET dispatched_at = datetime('now'), dispatch_result_json = '{\"source\":\"open-core\",\"decision\":\"operator_continue\"}' WHERE id = ?").run(s.reply);
  const d = await decideReplyOpenCore(getDb(), s.reply, judgeReturning({ pOoo: 0.1, model: "jev-test", returnDate: null }));
  assert.equal(d, "operator_continue");
  assert.equal(target(s.target).email_replied_at, null);
});

test("P9 threshold comes from app_settings and is clamped", async () => {
  withKey();
  assert.equal(getReplyOooThreshold(getDb()), 0.9);
  setReplyOooThreshold(getDb(), 0.6);
  assert.equal(getReplyOooThreshold(getDb()), 0.6);
  const s = scenario();
  const d = await decideReplyOpenCore(getDb(), s.reply, judgeReturning({ pOoo: 0.7, model: "jev-test", returnDate: null }));
  assert.equal(d, "ooo_continue");
  assert.throws(() => setReplyOooThreshold(getDb(), 0.3), RangeError);
  assert.throws(() => setReplyOooThreshold(getDb(), 1), RangeError);
  setReplyOooThreshold(getDb(), 0.9);
});

test("P10 retryUndecidedReplies decides only undecided rows and reports the count", async () => {
  withKey(); const a = scenario(); const b = scenario();
  getDb().prepare("UPDATE email_replies SET dispatched_at = datetime('now') WHERE id = ?").run(b.reply);
  const n = await retryUndecidedReplies(getDb(), judgeReturning({ pOoo: 0.99, model: "jev-test", returnDate: null }));
  assert.equal(n, 1);
  assert.ok(reply(a.reply).dispatched_at);
});

test("D1 extractDateCandidates finds common forms, caps at 8", () => {
  const c = extractDateCandidates("Back on 2 October 2026, or October 3rd, 2026, or 2026-10-04, or 05/10/2026. Monday 6th at the latest.");
  assert.ok(c.includes("2 October 2026"));
  assert.ok(c.includes("October 3rd, 2026"));
  assert.ok(c.includes("2026-10-04"));
  assert.ok(c.includes("05/10/2026"));
  assert.ok(c.length <= 8);
  assert.equal(extractDateCandidates("no dates here").length, 0);
});

test("D2 parseReturnDate resolves relative to today and rejects junk", () => {
  const today = new Date("2026-09-18T00:00:00Z");
  assert.equal(parseReturnDate("2 October 2026", today)?.toISOString(), "2026-10-02T00:00:00.000Z");
  assert.equal(parseReturnDate("2026-10-04", today)?.toISOString(), "2026-10-04T00:00:00.000Z");
  assert.equal(parseReturnDate("October 3rd, 2026", today)?.toISOString(), "2026-10-03T00:00:00.000Z");
  assert.equal(parseReturnDate("2 October", today)?.toISOString(), "2026-10-02T00:00:00.000Z", "year-less date resolves to the next occurrence");
  assert.equal(parseReturnDate("none", today), null);
  assert.equal(parseReturnDate("31 February 2026", today), null);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `RUN_ONE tests/reply-policy.test.ts` → fails at import (`@/lib/email/reply-policy` not found).

- [ ] **Step 4: Implement `lib/email/reply-settings.ts`**

```ts
import type Database from "better-sqlite3";

export const DEFAULT_REPLY_OOO_THRESHOLD = 0.9;
const MIN = 0.5, MAX = 0.99;
const KEY = "reply_ooo_threshold";

/** Probability of "automatic out-of-office" at or above which the open-core policy keeps the enrolment. */
export function getReplyOooThreshold(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  const n = row ? Number(row.value) : DEFAULT_REPLY_OOO_THRESHOLD;
  if (!Number.isFinite(n)) return DEFAULT_REPLY_OOO_THRESHOLD;
  return Math.min(MAX, Math.max(MIN, n));
}

export function setReplyOooThreshold(db: Database.Database, value: number): void {
  if (!Number.isFinite(value) || value < MIN || value > MAX) throw new RangeError(`reply_ooo_threshold must be between ${MIN} and ${MAX}`);
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(KEY, String(value));
}
```

(Check `app_settings` has `updated_at` — `grep -n "CREATE TABLE IF NOT EXISTS app_settings" -A 5 lib/db.ts`; if not, drop that column from both statements.)

- [ ] **Step 5: Implement `lib/email/reply-policy.ts`**

```ts
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { TypeSafeClient, noul, choice } from "@typesafe-ai/sdk";
import { decryptSecret } from "@/lib/crypto";
import { getReplyOooThreshold } from "@/lib/email/reply-settings";

/**
 * Open-core reply policy (C2-B2 / PR-03).
 *
 * Premium (ee/) classifies and dispatches replies itself. Without it, nothing
 * decided what a captured reply meant, so the runner kept sending follow-ups to
 * people who had answered. This module makes exactly one decision per reply:
 *   - an automatic out-of-office notice (high probability) keeps the enrolment,
 *     optionally pushing the next email past the stated return date;
 *   - anything else is a person answering → targets.email_replied_at, which the
 *     runner turns into the usual "Lead replied" skip.
 * It never sends. Judgment failures leave the reply undecided (the runner holds
 * on that) and are retried; three failures fail closed.
 */

export interface ReplyState {
  reply: { from: string; subject: string; body: string; received_at: string };
  our_last_email: { subject: string; body: string } | null;
  today: string;
}
export interface ReplyJudgment {
  pOoo: number;
  model: string;
  returnDate: { chosen: string | null; confidence: number } | null;
}
export type Judge = (state: ReplyState, dateCandidates: string[]) => Promise<ReplyJudgment>;
export type ReplyDecision = "ooo_continue" | "human_reply" | "operator_continue";

const MAX_ATTEMPTS = 3;
const RETURN_DATE_MIN_CONFIDENCE = 0.7;
const BODY_LIMIT = 4000;
const MAX_CANDIDATES = 8;

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/g,                                                      // 2026-10-04
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?(?:,?\\s+\\d{4})?\\b`, "gi"), // 2 October 2026, 2nd Oct
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"), // October 3rd, 2026
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,                                               // 05/10/2026
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi, // Monday 6th
];

/** Date-like spans in the order they appear, de-duplicated, at most MAX_CANDIDATES. */
export function extractDateCandidates(body: string): string[] {
  const found: string[] = [];
  for (const re of DATE_PATTERNS) {
    for (const m of body.matchAll(re)) {
      const span = m[0].trim();
      if (!found.includes(span)) found.push(span);
    }
  }
  return found.slice(0, MAX_CANDIDATES);
}

const MONTH_INDEX: Record<string, number> = Object.fromEntries(
  MONTHS.split("|").map(m => [m, ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m.slice(0, 3))])
);
function utcDate(y: number, m: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt : null;
}
/** The chosen span as a UTC midnight date, or null when it is not a real date. Year-less dates take the next occurrence on or after today. */
export function parseReturnDate(span: string, today: Date): Date | null {
  const s = span.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)/g, "$1").replace(/\./g, "");
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return utcDate(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) { // day/month/year (the app's users write European order)
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return utcDate(y, +m[2] - 1, +m[1]);
  }
  let day: number | undefined, month: number | undefined, year: number | undefined;
  if ((m = s.match(new RegExp(`^(\\d{1,2})\\s+(${MONTHS})(?:,?\\s+(\\d{4}))?$`)))) { day = +m[1]; month = MONTH_INDEX[m[2]]; year = m[3] ? +m[3] : undefined; }
  else if ((m = s.match(new RegExp(`^(${MONTHS})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?$`)))) { month = MONTH_INDEX[m[1]]; day = +m[2]; year = m[3] ? +m[3] : undefined; }
  else return null; // weekday-only forms ("Monday 6th") are too ambiguous to act on
  if (day === undefined || month === undefined) return null;
  if (year !== undefined) return utcDate(year, month, day);
  const thisYear = utcDate(today.getUTCFullYear(), month, day);
  if (thisYear && thisYear.getTime() >= Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) return thisYear;
  return utcDate(today.getUTCFullYear() + 1, month, day);
}

/** The production judge: one fan-out request to Jev. */
export function jevJudge(apiKey: string): Judge {
  return async (state, dateCandidates) => {
    const client = new TypeSafeClient({ apiKey, timeout: 10_000 });
    const questions = {
      is_auto_reply: noul(
        "`reply` is an automatic out-of-office or auto-responder notice generated because the recipient is away, not a message a person wrote in response to `our_last_email`.",
        {
          true: "Vacation, leave, out-of-office, 'I am currently away', 'limited access to email', auto-generated acknowledgement with a return date or alternative contact.",
          false: "Anything a person typed as a response — including a one-line 'not interested', 'stop emailing me', a question, a forward to a colleague, or a delivery/bounce notice.",
        }
      ),
      ...(dateCandidates.length > 0 ? {
        return_date: choice(
          "Which candidate is the date the sender says they will be back or resume reading email? Choose `none` if no return date is stated.",
          Object.fromEntries([...dateCandidates.map(c => [c, null]), ["none", null]])
        ),
      } : {}),
    };
    const response = await client.systemOne({ state, questions });
    const answers = response.answers as { is_auto_reply: { noul: number }; return_date?: { choice: string; confidence: number } };
    const rd = answers.return_date;
    return {
      pOoo: answers.is_auto_reply.noul,
      model: response.model ?? "jev",
      returnDate: rd ? { chosen: rd.choice === "none" ? null : rd.choice, confidence: rd.confidence } : null,
    };
  };
}

function defaultJudge(db: Database.Database): Judge {
  return async (state, candidates) => {
    const row = db.prepare("SELECT api_key FROM integrations WHERE key = 'typesafe'").get() as { api_key: string | null } | undefined;
    const key = row?.api_key ? decryptSecret(row.api_key) : null;
    if (!key) throw new Error("TypeSafe API key is not configured (Settings → Integrations)");
    return jevJudge(key)(state, candidates);
  };
}

interface ReplyRow { id: string; target_id: string; run_id: string | null; from_email: string; subject: string | null; body_text: string; received_at: string; dispatched_at: string | null; dispatch_result_json: string | null; open_core_attempts: number }

function returnAt09(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 9, 0, 0)).toISOString();
}

/**
 * Decide one reply. Returns the decision, or "undecided" when the judgment failed
 * and attempts remain. Safe to call again: an already-decided row is a no-op.
 */
export async function decideReplyOpenCore(db: Database.Database, replyId: string, judge: Judge = defaultJudge(db)): Promise<ReplyDecision | "undecided"> {
  const row = db.prepare("SELECT id, target_id, run_id, from_email, subject, body_text, received_at, dispatched_at, dispatch_result_json, open_core_attempts FROM email_replies WHERE id = ?").get(replyId) as ReplyRow | undefined;
  if (!row) throw new Error(`reply ${replyId} not found`);
  if (row.dispatched_at) {
    const prior = row.dispatch_result_json ? (JSON.parse(row.dispatch_result_json) as { decision?: ReplyDecision }).decision : undefined;
    return prior ?? "operator_continue";
  }
  const threshold = getReplyOooThreshold(db);
  const track = row.run_id
    ? db.prepare(`SELECT rt.last_email_subject, rt.last_email_body FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id = rt.run_profile_id
                  WHERE rp.run_id = ? AND rp.target_id = ? AND rt.track = 'email'`).get(row.run_id, row.target_id) as { last_email_subject: string | null; last_email_body: string | null } | undefined
    : undefined;
  const today = new Date();
  const state: ReplyState = {
    reply: { from: row.from_email, subject: row.subject ?? "", body: row.body_text.slice(0, BODY_LIMIT), received_at: row.received_at },
    our_last_email: track?.last_email_subject || track?.last_email_body ? { subject: track?.last_email_subject ?? "", body: track?.last_email_body ?? "" } : null,
    today: today.toISOString().slice(0, 10),
  };
  const candidates = extractDateCandidates(state.reply.body);

  let judgment: ReplyJudgment;
  try {
    judgment = await judge(state, candidates);
  } catch (err) {
    const attempts = row.open_core_attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    if (attempts >= MAX_ATTEMPTS) {
      recordDecision(db, row, "human_reply", { p_ooo: null, threshold, model: null, return_date: null, attempts, reason: `judgment failed ${MAX_ATTEMPTS} times — failing closed` }, `Reply could not be judged (${message}); follow-ups stopped`);
      return "human_reply";
    }
    db.prepare("UPDATE email_replies SET open_core_attempts = ?, classification_error = ? WHERE id = ? AND dispatched_at IS NULL").run(attempts, message.slice(0, 500), row.id);
    return "undecided";
  }

  const attempts = row.open_core_attempts + 1;
  const pOoo = Math.max(0, Math.min(1, judgment.pOoo));
  if (pOoo >= threshold) {
    let returnDate: Date | null = null;
    if (judgment.returnDate?.chosen && judgment.returnDate.confidence >= RETURN_DATE_MIN_CONFIDENCE) {
      const parsed = parseReturnDate(judgment.returnDate.chosen, today);
      if (parsed && parsed.getTime() > today.getTime()) returnDate = parsed;
    }
    const iso = returnDate ? returnDate.toISOString().slice(0, 10) : null;
    const resumeAt = returnDate ? returnAt09(returnDate) : null;
    db.transaction(() => {
      if (resumeAt && row.run_id) {
        db.prepare(`UPDATE run_profile_tracks SET next_step_at = CASE WHEN next_step_at IS NULL OR datetime(next_step_at) < datetime(?) THEN ? ELSE next_step_at END
                    WHERE track = 'email' AND state IN ('pending', 'in_progress')
                      AND run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ? AND target_id = ?)`).run(resumeAt, resumeAt, row.run_id, row.target_id);
      }
      recordDecision(db, row, "ooo_continue", { p_ooo: pOoo, threshold, model: judgment.model, return_date: iso, attempts },
        `Out-of-office reply — follow-up continues after ${resumeAt ? resumeAt.slice(0, 10) : "unchanged schedule"}`,
        { kind: "out_of_office", summary: `Automatic out-of-office reply (p=${pOoo}); ${iso ? `back ${iso}` : "no return date"}` });
    }).immediate();
    return "ooo_continue";
  }
  db.transaction(() => {
    recordDecision(db, row, "human_reply", { p_ooo: pOoo, threshold, model: judgment.model, return_date: null, attempts }, "Reply received — follow-ups stopped",
      { kind: "human_reply", summary: `A person replied (p_ooo=${pOoo})` });
  }).immediate();
  return "human_reply";
}

function recordDecision(
  db: Database.Database, row: ReplyRow, decision: ReplyDecision,
  result: { p_ooo: number | null; threshold: number; model: string | null; return_date: string | null; attempts: number; reason?: string },
  activity: string,
  classification: { kind: "out_of_office" | "human_reply"; summary: string } = { kind: "human_reply", summary: result.reason ?? "A person replied" }
) {
  const now = new Date().toISOString();
  db.prepare(`UPDATE email_replies SET dispatched_at = ?, dispatch_result_json = ?, classified_at = ?, classification_json = ?, classification_error = NULL, open_core_attempts = ?
              WHERE id = ? AND dispatched_at IS NULL`)
    .run(now, JSON.stringify({ source: "open-core", decision, ...result }), now, JSON.stringify(classification), result.attempts, row.id);
  if (decision === "human_reply") {
    db.prepare("UPDATE targets SET email_replied_at = COALESCE(email_replied_at, ?) WHERE id = ?").run(now, row.target_id);
  }
  db.prepare("INSERT INTO activity_logs (id, target_id, type, body) VALUES (?, ?, 'email', ?)").run(randomUUID(), row.target_id, activity);
}

/** Retry every undecided reply (open-core only). Returns how many reached a decision. */
export async function retryUndecidedReplies(db: Database.Database, judge?: Judge): Promise<number> {
  const rows = db.prepare("SELECT id FROM email_replies WHERE dispatched_at IS NULL ORDER BY received_at ASC LIMIT 50").all() as Array<{ id: string }>;
  let decided = 0;
  for (const { id } of rows) {
    const d = await decideReplyOpenCore(db, id, judge);
    if (d !== "undecided") decided++;
  }
  return decided;
}
```

Notes for the implementer: the exact `dispatch_result_json` key order in test P1 is `source, decision, p_ooo, threshold, model, return_date, attempts` — the spread `{ source, decision, ...result }` produces that order when `result` is built in that key order (as above). `response.model` — check the SDK's `SystemOneResponse` type (`node_modules/@typesafe-ai/sdk/dist/types.d.ts`); if the field is named differently, use that name and note it. If `noul`/`choice` helper signatures differ from `(instructions, criteria)`, adapt to the installed SDK and note it.

- [ ] **Step 6: Run the tests**

Run: `RUN_ONE tests/reply-policy.test.ts` → P1–P10, D1–D2 PASS. P7 exercises the real `defaultJudge` with no key → must throw *before* any network call.

- [ ] **Step 7: Smoke script (manual, not gated)**

Create `scripts/typesafe-smoke.mjs`:

```js
#!/usr/bin/env node
// Manual live check of the open-core reply judgment. Not part of any gate.
//   TYPESAFE_API_KEY=... node --experimental-strip-types --import ./scripts/test-setup.mjs scripts/typesafe-smoke.mjs
import { jevJudge, extractDateCandidates } from "../lib/email/reply-policy.ts";

const key = process.env.TYPESAFE_API_KEY;
if (!key) { console.error("TYPESAFE_API_KEY is not set"); process.exit(2); }
const judge = jevJudge(key);
const ours = { subject: "Quick question about your hiring plans", body: "Hi Ada — are you looking to expand the team this quarter?" };
const samples = [
  ["clear OOO with date", "Thank you for your email. I am out of the office until 2 October 2026 with limited access to email and will respond on my return."],
  ["curt human reply", "Not interested, please remove me from your list."],
  ["bounce-like notice", "Delivery has failed to these recipients or groups: ada@example.com. The recipient's mailbox is full."],
];
for (const [label, body] of samples) {
  const state = { reply: { from: "ada@example.com", subject: "Re: Quick question", body, received_at: new Date().toISOString() }, our_last_email: ours, today: new Date().toISOString().slice(0, 10) };
  const j = await judge(state, extractDateCandidates(body));
  console.log(`${label.padEnd(24)} p_ooo=${j.pOoo.toFixed(3)} model=${j.model} return=${j.returnDate ? `${j.returnDate.chosen} (${j.returnDate.confidence.toFixed(2)})` : "n/a"}`);
}
```

Check it parses: `bash -lc 'node --check scripts/typesafe-smoke.mjs'`. Do not run it with a key in CI.

- [ ] **Step 8: Lint, typecheck, full suite, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add package.json package-lock.json lib/email/reply-settings.ts lib/email/reply-policy.ts scripts/typesafe-smoke.mjs tests/reply-policy.test.ts
bash -lc 'git commit -q -m "C2-B2/PR-03: open-core reply policy — Jev out-of-office judgment with explicit threshold, fail-closed retries; @typesafe-ai/sdk 0.6.0"'
```

---

### Task 3: Wire the policy into the inbox sync

**Files:**
- Modify: `lib/email/inbox.ts:236-247` (the `captureReplyBody` → dispatch block) and the end of `syncEmailInbox`
- Test: `tests/inbox-sync-opencore-dispatch.test.ts`

**Interfaces:**
- Consumes: `decideReplyOpenCore`, `retryUndecidedReplies` (Task 2); `premium` from `@/lib/premium`.
- Produces: `export async function dispatchCapturedReply(db, replyId): Promise<void>` in `lib/email/inbox.ts` — premium present → `premium.replies.classifyAndDispatch(replyId)`, else `decideReplyOpenCore(db, replyId)`.

- [ ] **Step 1: Write the failing test**

Create `tests/inbox-sync-opencore-dispatch.test.ts`:

```ts
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-inbox-dispatch-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-inbox-dispatch-tests";

const mockModule = mock.module.bind(mock) as unknown as (specifier: string, options: { namedExports: Record<string, unknown> }) => void;

const calls: string[] = [];
const premiumBox: { premium: null | { replies: { classifyAndDispatch: (id: string) => Promise<void>; shouldSyncInbox: () => boolean; syncAccountInbox: () => Promise<number> } } } = { premium: null };
mockModule("@/lib/premium", { namedExports: { get premium() { return premiumBox.premium; }, get hasPremium() { return premiumBox.premium !== null; } } });
const realPolicy = await import("@/lib/email/reply-policy");
mockModule("@/lib/email/reply-policy", {
  namedExports: {
    ...realPolicy,
    decideReplyOpenCore: async (_db: unknown, id: string) => { calls.push(`open-core:${id}`); return "ooo_continue"; },
    retryUndecidedReplies: async () => { calls.push("retry"); return 0; },
  },
});
const { dispatchCapturedReply } = await import("@/lib/email/inbox");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

test("S1 without premium the open-core policy decides the reply", async () => {
  calls.length = 0; premiumBox.premium = null;
  await dispatchCapturedReply(getDb(), "r1");
  assert.deepEqual(calls, ["open-core:r1"]);
});

test("S2 with premium its dispatcher decides and the open-core policy is not called", async () => {
  calls.length = 0;
  premiumBox.premium = { replies: { classifyAndDispatch: async (id) => { calls.push(`premium:${id}`); }, shouldSyncInbox: () => false, syncAccountInbox: async () => 0 } };
  await dispatchCapturedReply(getDb(), "r2");
  assert.deepEqual(calls, ["premium:r2"]);
  premiumBox.premium = null;
});
```

If `mock.module` cannot express getters in `namedExports`, mock `@/lib/premium` twice is not possible — instead export `dispatchCapturedReply(db, replyId, surface = premium)` with the premium surface as an injectable third parameter and pass `null` / a stub in the tests. Note which route you took.

- [ ] **Step 2: Run to verify it fails**

Run: `RUN_ONE tests/inbox-sync-opencore-dispatch.test.ts` → fails: `dispatchCapturedReply` is not exported.

- [ ] **Step 3: Implement**

In `lib/email/inbox.ts`, add the imports and the exported chooser:

```ts
import { decideReplyOpenCore, retryUndecidedReplies } from "@/lib/email/reply-policy";
import type { PremiumSurface } from "@/lib/premium";

/**
 * Who decides what a captured reply means. Premium (ee/) owns classification
 * and dispatch when present; otherwise the open-core policy makes the one
 * decision it knows how to make (C2-B2 / PR-03). Until a decision exists the
 * runner holds the contact.
 */
export async function dispatchCapturedReply(db: DB, replyId: string, surface: PremiumSurface | null = premium): Promise<void> {
  if (surface?.replies) await surface.replies.classifyAndDispatch(replyId);
  else await decideReplyOpenCore(db, replyId);
}
```

(`DB` = whatever type alias the file already uses for `getDb()`'s return — check the top of the file; use `ReturnType<typeof getDb>` if none.) Replace the block

```ts
                  if (replyId && premium?.replies) {
                    await premium.replies.classifyAndDispatch(replyId);
                  }
```

with

```ts
                  if (replyId) await dispatchCapturedReply(db, replyId);
```

and update the comment above it (the "AI classification + auto-followup is a premium feature — skipped cleanly when ee/ is absent" sentence) to: "Premium classifies and dispatches; without it the open-core policy decides (reply-policy.ts). Either way the runner holds the contact until a decision exists."

At the end of `syncEmailInbox` (after the IMAP work resolves, before the function returns its counts), add:

```ts
  // Open-core only: replies whose judgment failed earlier are retried here so a
  // transient TypeSafe/network error does not hold a contact forever.
  if (!premium?.replies) {
    try { await retryUndecidedReplies(db); } catch (err) { console.warn("[email-inbox] retryUndecidedReplies failed:", err instanceof Error ? err.message : err); }
  }
```

- [ ] **Step 4: Run the tests**

Run: `RUN_ONE tests/inbox-sync-opencore-dispatch.test.ts` → S1, S2 PASS. `RUN_ONE tests/health-isolation.test.ts` → PASS (that suite guards what the health endpoint imports; `lib/email/inbox.ts` now imports the SDK transitively — if it fails, read its assertion and report BLOCKED with the failing line rather than editing that test).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add lib/email/inbox.ts tests/inbox-sync-opencore-dispatch.test.ts
bash -lc 'git commit -q -m "C2-B2/PR-03: inbox sync routes captured replies to premium or the open-core policy; retries undecided replies"'
```

---

### Task 4: Operator resume endpoint

**Files:**
- Create: `pages/api/inbox/[replyId]/resume-followup.ts`
- Test: `tests/inbox-resume-followup.test.ts`

**Interfaces:**
- Produces: `POST /api/inbox/:replyId/resume-followup` → `404 { error: "reply_not_found" }` | `200 { ok: true, rearmed: number }`.

- [ ] **Step 1: Write the failing test**

Create `tests/inbox-resume-followup.test.ts`:

```ts
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-resume-followup-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-resume-followup-tests";

const { default: handler } = await import("@/pages/api/inbox/[replyId]/resume-followup");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

function post(replyId: string) {
  const captured = { status: 200, body: undefined as unknown };
  const res = { status(c: number) { captured.status = c; return this; }, json(p: unknown) { captured.body = p; return this; }, end() { return this; }, setHeader() { return this; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler({ method: "POST", query: { replyId } } as any, res as any);
  return captured;
}
let seq = 0;
function scenario() {
  const n = ++seq; const db = getDb();
  const ids = { run: `run-${n}`, other: `other-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, otherProfile: `oprofile-${n}`, email: `tr-e-${n}`, linkedin: `tr-l-${n}`, otherTrack: `tr-o-${n}`, target: `target-${n}`, reply: `reply-${n}` };
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(ids.run, ids.wf);
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(ids.other, ids.wf);
  db.prepare("INSERT INTO targets (id, full_name, linkedin_url, email, email_replied_at) VALUES (?, 'Ada', ?, ?, datetime('now'))").run(ids.target, `https://www.linkedin.com/in/ada-${n}/`, `ada-${n}@fixture.test`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.otherProfile, ids.other, ids.target);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, error_message, next_step_at) VALUES (?, ?, 'email', 'skipped', 1, 'Lead replied', '2026-01-01T00:00:00.000Z')").run(ids.email, ids.profile);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, error_message) VALUES (?, ?, 'linkedin', 'skipped', 0, 'Lead replied')").run(ids.linkedin, ids.profile);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, error_message) VALUES (?, ?, 'email', 'skipped', 0, 'Lead replied')").run(ids.otherTrack, ids.otherProfile);
  db.prepare("INSERT INTO email_replies (id, target_id, run_id, from_email, subject, body_text, received_at, dispatched_at, dispatch_result_json) VALUES (?, ?, ?, 'a@b.test', 'Re', 'no thanks', datetime('now'), datetime('now'), '{\"source\":\"open-core\",\"decision\":\"human_reply\"}')").run(ids.reply, ids.target, ids.run);
  return ids;
}
const track = (id: string) => getDb().prepare("SELECT state, next_step_at, error_message FROM run_profile_tracks WHERE id = ?").get(id) as { state: string; next_step_at: string | null; error_message: string | null };

test("R1 unknown reply → 404", () => {
  const r = post("nope");
  assert.equal(r.status, 404);
});

test("R2 resume clears the stamp, re-arms only this run's 'Lead replied' tracks, records operator_continue", () => {
  const s = scenario();
  const r = post(s.reply);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, rearmed: 2 });
  const db = getDb();
  assert.equal((db.prepare("SELECT email_replied_at FROM targets WHERE id = ?").get(s.target) as { email_replied_at: string | null }).email_replied_at, null);
  assert.deepEqual(track(s.email), { state: "in_progress", next_step_at: null, error_message: null });
  assert.equal(track(s.linkedin).state, "in_progress");
  assert.equal(track(s.otherTrack).state, "skipped", "another run's track is not touched");
  const rep = db.prepare("SELECT dispatch_result_json FROM email_replies WHERE id = ?").get(s.reply) as { dispatch_result_json: string };
  assert.equal(JSON.parse(rep.dispatch_result_json).decision, "operator_continue");
  const act = db.prepare("SELECT body FROM activity_logs WHERE target_id = ? ORDER BY rowid DESC LIMIT 1").get(s.target) as { body: string };
  assert.equal(act.body, "Follow-ups resumed from inbox");
});

test("R3 second resume is idempotent", () => {
  const s = scenario();
  post(s.reply);
  const r = post(s.reply);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, rearmed: 0 });
});

test("R4 an undecided reply is also decided by resume", () => {
  const s = scenario();
  getDb().prepare("UPDATE email_replies SET dispatched_at = NULL, dispatch_result_json = NULL WHERE id = ?").run(s.reply);
  post(s.reply);
  const rep = getDb().prepare("SELECT dispatched_at, dispatch_result_json FROM email_replies WHERE id = ?").get(s.reply) as { dispatched_at: string | null; dispatch_result_json: string };
  assert.ok(rep.dispatched_at);
  assert.equal(JSON.parse(rep.dispatch_result_json).decision, "operator_continue");
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement `pages/api/inbox/[replyId]/resume-followup.ts`**

```ts
import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { methodNotAllowed } from "@/lib/api-validate";

/**
 * Resumes automated follow-ups for a contact after a reply stopped them
 * (mirror of cancel-followup). Records an operator decision on the reply, clears
 * targets.email_replied_at, and re-arms this run's tracks that were skipped with
 * 'Lead replied'. Operator decisions win over model decisions (C2-B2 / PR-03).
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const db = getDb();
  const replyId = req.query.replyId as string;
  if (!replyId) return res.status(400).json({ error: "replyId required" });

  const reply = db.prepare("SELECT target_id, run_id, dispatched_at, dispatch_result_json FROM email_replies WHERE id = ?").get(replyId) as
    { target_id: string; run_id: string | null; dispatched_at: string | null; dispatch_result_json: string | null } | undefined;
  if (!reply) return res.status(404).json({ error: "reply_not_found" });

  const result = db.transaction(() => {
    const now = new Date().toISOString();
    const prior = reply.dispatch_result_json ? (JSON.parse(reply.dispatch_result_json) as { decision?: string }).decision : undefined;
    if (!reply.dispatched_at || prior === "human_reply") {
      db.prepare("UPDATE email_replies SET dispatched_at = ?, dispatch_result_json = ?, classification_error = NULL WHERE id = ?")
        .run(now, JSON.stringify({ source: "open-core", decision: "operator_continue" }), replyId);
    }
    db.prepare("UPDATE targets SET email_replied_at = NULL WHERE id = ?").run(reply.target_id);
    let rearmed = 0;
    if (reply.run_id) {
      rearmed = db.prepare(
        `UPDATE run_profile_tracks SET state = 'in_progress', error_message = NULL, next_step_at = NULL
         WHERE state = 'skipped' AND error_message = 'Lead replied'
           AND run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ? AND target_id = ?)`
      ).run(reply.run_id, reply.target_id).changes;
    }
    db.prepare("INSERT INTO activity_logs (id, target_id, type, body) VALUES (?, ?, 'email', 'Follow-ups resumed from inbox')").run(randomUUID(), reply.target_id);
    return { ok: true, rearmed };
  }).immediate();
  return res.json(result);
}
```

Check `lib/api-validate.ts` exports `methodNotAllowed` (it does; `retry.ts` imports it).

- [ ] **Step 4: Run the tests** — R1–R4 PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add "pages/api/inbox/[replyId]/resume-followup.ts" tests/inbox-resume-followup.test.ts
bash -lc 'git commit -q -m "C2-B2/PR-03: POST /api/inbox/:replyId/resume-followup — operator resumes follow-ups after a reply hold"'
```

---

### Task 5: Settings route and premium-status capabilities

**Files:**
- Create: `pages/api/settings/reply-policy.ts`
- Modify: `pages/api/premium-status.ts`
- Test: `tests/premium-status-capabilities.test.ts` (covers both routes)

**Interfaces:**
- Produces: `GET /api/settings/reply-policy` → `{ ooo_threshold: number, default: 0.9 }`; `PUT { ooo_threshold }` → `200 { ooo_threshold }` | `400 { error }`. `GET /api/premium-status` → `{ hasPremium, capabilities: { linkedinReplyDetection: boolean, emailReplyClassification: "premium" | "open-core" } }`.

- [ ] **Step 1: Write the failing test**

Create `tests/premium-status-capabilities.test.ts`:

```ts
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-capabilities-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-capabilities-tests";

const { default: premiumStatus } = await import("@/pages/api/premium-status");
const { default: replyPolicy } = await import("@/pages/api/settings/reply-policy");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

function call(handler: (req: unknown, res: unknown) => unknown, method: string, body?: unknown) {
  const captured = { status: 200, body: undefined as unknown };
  const res = { status(c: number) { captured.status = c; return this; }, json(p: unknown) { captured.body = p; return this; }, end() { return this; }, setHeader() { return this; } };
  handler({ method, body, query: {} }, res);
  return captured;
}

test("C1 premium-status exposes open-core capabilities (this build has no ee/)", () => {
  const r = call(premiumStatus, "GET");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { hasPremium: false, capabilities: { linkedinReplyDetection: false, emailReplyClassification: "open-core" } });
});

test("C2 reply-policy GET returns the default and PUT validates the range", () => {
  assert.deepEqual(call(replyPolicy, "GET").body, { ooo_threshold: 0.9, default: 0.9 });
  assert.equal(call(replyPolicy, "PUT", { ooo_threshold: 0.3 }).status, 400);
  assert.equal(call(replyPolicy, "PUT", { ooo_threshold: "abc" }).status, 400);
  assert.deepEqual(call(replyPolicy, "PUT", { ooo_threshold: 0.8 }).body, { ooo_threshold: 0.8 });
  assert.deepEqual(call(replyPolicy, "GET").body, { ooo_threshold: 0.8, default: 0.9 });
  assert.equal(call(replyPolicy, "DELETE").status, 405);
});
```

- [ ] **Step 2: Run to verify it fails** — `reply-policy` module not found; C1 fails on the missing `capabilities`.

- [ ] **Step 3: Implement**

`pages/api/premium-status.ts` — replace the `res.status(200).json({ hasPremium });` line with:

```ts
  // C2-B2: open-core limits are stated, not implied. LinkedIn reply detection
  // lives in ee/; email replies are classified by ee/ when present, else by the
  // open-core policy (lib/email/reply-policy.ts).
  res.status(200).json({
    hasPremium,
    capabilities: {
      linkedinReplyDetection: hasPremium,
      emailReplyClassification: hasPremium ? "premium" : "open-core",
    },
  });
```

Create `pages/api/settings/reply-policy.ts`:

```ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { DEFAULT_REPLY_OOO_THRESHOLD, getReplyOooThreshold, setReplyOooThreshold } from "@/lib/email/reply-settings";

/** GET → { ooo_threshold, default }, PUT { ooo_threshold } → set the open-core out-of-office threshold. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  if (req.method === "GET") {
    return res.json({ ooo_threshold: getReplyOooThreshold(db), default: DEFAULT_REPLY_OOO_THRESHOLD });
  }
  if (req.method === "PUT") {
    const n = Number((req.body as { ooo_threshold?: unknown })?.ooo_threshold);
    try {
      setReplyOooThreshold(db, n);
    } catch (err) {
      if (err instanceof RangeError) return res.status(400).json({ error: err.message });
      throw err;
    }
    return res.json({ ooo_threshold: getReplyOooThreshold(db) });
  }
  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end();
}
```

- [ ] **Step 4: Run the tests** — C1, C2 PASS. Also `grep -rn "premium-status" tests/` and run any suite that asserts the old `{ hasPremium }`-only body; if one does an exact `deepEqual`, update it to the new shape and say so in the report.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add pages/api/premium-status.ts pages/api/settings/reply-policy.ts tests/premium-status-capabilities.test.ts
bash -lc 'git commit -q -m "C2-B2/PR-03: premium-status capabilities; reply-policy threshold settings route"'
```

---

### Task 6: UI — inbox resume + decision line, settings entries, LinkedIn notice, start-log

**Files:**
- Modify: `pages/inbox.tsx` (`VERDICT_BADGES` ~:46, `verdictBadge` ~:55, the action row ~:250-272, and the `acting` state ~:97)
- Modify: `pages/settings.tsx` (`INTEGRATIONS` ~:1418; `GeneralTab` ~:1670-1740)
- Modify: `pages/workflows/[id].tsx` (fetches `/api/premium-status` already? — `grep -n "premium-status" "pages/workflows/[id].tsx" pages/inbox.tsx`)
- Modify: `pages/api/runs/[id]/start.ts:26-29`
- Test: none new (UI); the existing SSR/tour suites must keep passing; `tests/runner-lifecycle`-style suites cover `start.ts` — run `bash -lc 'npm test'` once.

**Interfaces:** consumes Task 4's route and Task 5's routes/shapes.

- [ ] **Step 1: Inbox — badges and decision line**

In `VERDICT_BADGES` add:

```ts
  out_of_office: { label: "Out of office", cls: "bg-warning/15 text-warning" },
```

(`human_reply` already exists.) In `verdictBadge`/`verdictKey`, keep the existing order but make the "Pending" case read `reply.reply_id && !reply.dispatched_at` → label **"Awaiting decision"** (the open-core hold state); classified-but-undecided cannot occur in open-core, and premium's pending case still matches. Below the verdict badge in the detail panel, render a one-line decision summary when `dispatch?.source === "open-core"`:

```tsx
{dispatch?.source === "open-core" && (
  <p className="text-xs text-base-content/50">
    {dispatch.decision === "ooo_continue" && `Out of office (p=${Number(dispatch.p_ooo).toFixed(2)}) — follow-ups continue${dispatch.return_date ? ` after ${dispatch.return_date}` : ""}`}
    {dispatch.decision === "human_reply" && `Person replied${dispatch.p_ooo != null ? ` (p_ooo=${Number(dispatch.p_ooo).toFixed(2)})` : ""} — follow-ups stopped${dispatch.reason ? ` · ${dispatch.reason}` : ""}`}
    {dispatch.decision === "operator_continue" && "Operator resumed follow-ups"}
  </p>
)}
```

- [ ] **Step 2: Inbox — Resume button**

Extend `acting` state to `"reclassify" | "cancel" | "resume" | null`. Add:

```ts
  async function handleResumeFollowup() {
    if (!reply.reply_id) return;
    setActing("resume");
    try {
      const r = await fetch(`/api/inbox/${reply.reply_id}/resume-followup`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Resume failed");
      toast.success(`Follow-ups resumed (${d.rearmed} track${d.rearmed === 1 ? "" : "s"})`);
      onActionDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Resume failed");
    } finally {
      setActing(null);
    }
  }
```

and in the action row, after the Cancel button:

```tsx
              {reply.reply_id && (reply.email_replied_at || dispatch?.decision === "human_reply") && (
                <button
                  onClick={handleResumeFollowup}
                  disabled={acting !== null}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-success/10 text-success hover:bg-success/20 disabled:opacity-50"
                >
                  {acting === "resume" ? <RiLoader4Line size={12} className="animate-spin" /> : null}
                  Resume follow-ups
                </button>
              )}
```

`reply.email_replied_at` is already in the API row type (`pages/api/inbox/index.ts:13`).

- [ ] **Step 3: Inbox + campaign page — LinkedIn notice**

Where each page already knows `hasPremium` (inbox: `hasPremium` prop; campaign page: check `grep -n "hasPremium\|premium-status" "pages/workflows/[id].tsx"`), render once near the top when `!hasPremium`:

```tsx
{!hasPremium && (
  <p className="text-xs text-base-content/50 border border-base-300 rounded-lg px-3 py-2">
    LinkedIn replies are not detected in this build. LinkedIn follow-ups stop only when you unenroll the contact or an email reply is received.
  </p>
)}
```

If the campaign page has no premium flag available, fetch `/api/premium-status` once in a `useEffect` and read `capabilities.linkedinReplyDetection`.

- [ ] **Step 4: Settings — TypeSafe integration and threshold**

`INTEGRATIONS`: add after `apollo`:

```ts
  {
    key: "typesafe",
    name: "TypeSafe (Jev)",
    description: "Out-of-office detection for email replies in the open-core build",
    badge: "TS",
    badgeColor: "#16a34a",
    accentColor: "#16a34a",
    placeholder: "TypeSafe API key",
  },
```

(not in `PREMIUM_INTEGRATION_KEYS` — it is an open-core integration). `GeneralTab`: add state `const [oooThreshold, setOooThreshold] = useState<number | "">("");` + `const [thrSaving, setThrSaving] = useState(false);`, load with `fetch("/api/settings/reply-policy").then(r => r.json()).then(d => setOooThreshold(d.ooo_threshold ?? 0.9)).catch(() => {});` in the existing `useEffect`, a `saveOooThreshold` mirroring `saveImportCap` (PUT `{ ooo_threshold: Number(oooThreshold) }`, toast "Reply policy saved"), and a block after the Daily import limit block:

```tsx
      <div className="mt-6">
        <p className="text-xs font-medium text-base-content/40 uppercase tracking-wide">Out-of-office threshold</p>
        <p className="text-xs text-base-content/50 mb-3">
          A captured email reply pauses follow-ups until it is judged. Replies judged to be automatic out-of-office notices with at least this probability keep the sequence going; everything else stops it. Requires a TypeSafe key under Integrations.
        </p>
        <form onSubmit={saveOooThreshold} className="flex items-end gap-2">
          <div className="flex-1">
            <input type="number" min={0.5} max={0.99} step={0.01} className="input input-bordered input-sm w-full bg-base-300/50" placeholder="0.90" value={oooThreshold} onChange={(e) => setOooThreshold(e.target.value === "" ? "" : Number(e.target.value))} required />
          </div>
          <button type="submit" disabled={thrSaving} className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-content hover:bg-primary/90 disabled:opacity-50">
            {thrSaving ? <span className="loading loading-spinner loading-xs" /> : "Save"}
          </button>
        </form>
      </div>
```

(Copy the exact button className from the Daily import limit block so it matches.)

- [ ] **Step 5: Start-route log**

In `pages/api/runs/[id]/start.ts`, after the `UPDATE runs SET status = 'running' …` statement and before `ensureGlobalRunnerStarted()`:

```ts
  if (!hasPremium) {
    db.prepare("INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, ?, NULL, 'warn', ?)")
      .run(randomUUID(), runId, "LinkedIn reply detection unavailable in this build — LinkedIn follow-ups are not auto-stopped; email replies hold both channels");
  }
```

with `import { hasPremium } from "@/lib/premium";` and `import { randomUUID } from "crypto";`. Check the `logs` table columns first (`grep -n "CREATE TABLE IF NOT EXISTS logs" -A 8 lib/db.ts`) and match them exactly (the runner's `log()` helper in `lib/linkedin/runner.ts:271` shows the canonical insert — reuse its column list).

- [ ] **Step 6: Verify, lint, typecheck, full suite, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (pass|fail)"'
git add pages/inbox.tsx pages/settings.tsx "pages/workflows/[id].tsx" "pages/api/runs/[id]/start.ts"
bash -lc 'git commit -q -m "C2-B2/PR-03: inbox resume + open-core decision line; TypeSafe integration and OOO threshold settings; visible LinkedIn limit"'
```

Expected: `fail 0`; lint/tsc clean.

---

### Task 7: Gate, evidence record

**Files:**
- Modify: `docs/production-readiness.md` (PR-03 row; "Current checkpoint" table; append `## C2-B2 record (<date>)`)

- [ ] **Step 1: Isolated gate**

```bash
env PATH=/usr/bin:/bin /usr/bin/node scripts/c0-verify.mjs 2>&1 | tee /tmp/c2b2-gate.log | grep -E "^C0 (snapshot|isolation|RESULT|LINT|SUMMARY)|retained at"
grep -E "^# (pass|fail|skipped)" /tmp/c2b2-gate.log
```

Expected: every `exitCode":0`, `gate: true`, `# fail 0`, tests = 536 + (reply-hold 4 + reply-policy 12 + inbox-sync-opencore-dispatch 2 + inbox-resume-followup 4 + premium-status-capabilities 2) = **560** unless a suite count differs — record the actual number. Record image id (`cat $(ls -dt /tmp/linki-c0-* | head -1)/image-id.txt`, full 64-hex digest) and snapshot hash.

- [ ] **Step 2: Host preflight**

`bash -lc 'bash scripts/preflight.sh'` → PASS; record `grep -E "^ℹ (pass|fail)" /tmp/preflight-test.log`.

- [ ] **Step 3: Register + record**

PR-03 row last cell → `**Observed (C2-B2 gate <date>)**: undecided email replies hold both tracks before any send (\`tests/reply-hold.test.ts\`); open-core policy judges out-of-office via TypeSafe/Jev with an explicit threshold (default 0.9), fails closed after 3 judgment failures, and records decisions in the reply row (\`tests/reply-policy.test.ts\`); operator resume route; LinkedIn open-core limit stated by \`/api/premium-status\` and the UI. Judgment quality on real mail **Unverified** (synthetic samples only); LinkedIn reply detection remains premium. |`

"Current checkpoint" table: phase → C2-B2 implemented and gated (branch); next → C2-B1 (PR-09, PR-06). Append `## C2-B2 record (<date>)` with the same fields as the C2-A record (timestamp, owner, source revision = the six task commits, toolchain incl. `@typesafe-ai/sdk 0.6.0` and the recorded audit numbers, image identity, isolation, commands/exit codes, counts container + host, evidence path, findings/corrections, rollback readiness: the `open_core_attempts` column is additive; disabling the policy = removing the TypeSafe key (replies then stay held until an operator resumes), unresolved blockers, next action, reviewer decision **Pending**).

- [ ] **Step 4: Commit (no push)**

```bash
git add docs/production-readiness.md
bash -lc 'git commit -q -m "Docs: C2-B2 gate record; PR-03 observed"'
```

---

## Self-review notes

- Spec §1 → Task 1; §2.1–2.3 → Task 2 (judgment, policy, idempotency, attempts) + Task 3 (call site, retry per sync); §3 → Tasks 4, 6 (resume route/button, TypeSafe integration, threshold field) + Task 5 (settings route); §4 → Tasks 5, 6 (capabilities, notices, start log); §5 → Task 2 step 1; §6 tests → Tasks 1–5 (the spec's five suites; UI has none); §7 → Task 7.
- Names consistent across tasks: `decideReplyOpenCore`, `retryUndecidedReplies`, `dispatchCapturedReply`, `getReplyOooThreshold`/`setReplyOooThreshold`, `DEFAULT_REPLY_OOO_THRESHOLD`, `jevJudge`, `extractDateCandidates`, `parseReturnDate`, `open_core_attempts`, `reply_ooo_threshold`, decision strings, JSON shapes.
- Known plan-time uncertainty, flagged for the implementer rather than hidden: SDK helper signatures (`noul`, `choice`) and `response.model` field name are to be confirmed against the installed `@typesafe-ai/sdk@0.6.0` types; `app_settings.updated_at` existence; `logs` column list; whether `mock.module` accepts getters (fallback: injectable premium surface parameter).
