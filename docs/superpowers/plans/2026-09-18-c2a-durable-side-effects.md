# C2-A Durable Side Effects and Atomic Writes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automated emails join the crash-safe side-effect ledger, retry resolves steps by identity only, run creation is atomic, and migrations fail closed — register rows PR-02, PR-12, PR-11, PR-04.

**Architecture:** Reuse the existing `step_side_effects` write-ahead ledger (intent → act → confirm, fail-closed on unknown errors) for `action = 'email'`, classifying Nodemailer failures into pre-send / rejected / ambiguous. Retry and runner share one `resolveStep`. Run creation becomes validate → compute → one `IMMEDIATE` transaction. The `migrations[]` loop tolerates only "already applied" errors and runs transactionally.

**Tech Stack:** Next.js 16 Pages Router API routes, better-sqlite3 12 (synchronous SQLite), Nodemailer 10.0.10, Node 22 `node:test` with `--experimental-test-module-mocks`, TypeScript 5.9.

**Spec:** `docs/superpowers/specs/2026-09-18-c2a-durable-side-effects-design.md`

## Global Constraints

- Node runtime for gates: **v22.23.0** in the isolated Docker gate (`npm run verify:c0`); host preflight uses nvm Node 24.19.0 via `bash -lc`.
- Tests: `node:test`, synthetic temp DB via `LINKI_DB_PATH`, no network, no browser, no real provider. Follow the harness style of `tests/message-idempotency.test.ts` and `tests/retry-ledger.test.ts`.
- Lint is mandatory: `eslint --max-warnings=0` must stay clean; `tsc --noEmit` must pass.
- Commit hook runs `scripts/preflight.sh` (tsc, full `npm test`, eslint); `--no-verify` is banned. Commit with `bash -lc 'git commit ...'` so the hook finds Node.
- Push only to `origin` (`Viverun/linki`), never `upstream`.
- No `targets.*_sent_at` column for email; the ledger row is the record.
- `step_ref` scheme unchanged: `stepid:<uuid>` with `pos:<n>` legacy fallback.
- Email fingerprint = `bodyFingerprint(subject + "\n\n" + finalBody)`.
- Unknown SMTP errors are **ambiguous** (fail closed): ledger stays `in_flight`.

---

## File map

| File | Responsibility in this plan |
| --- | --- |
| `lib/email/sender.ts` | `SendResult`, `sendEmail` returns it, `classifySmtpFailure` (Task 1) |
| `lib/db.ts` | fail-closed `migrations[]` loop; widened `step_side_effects` CHECK + rebuild (Task 2) |
| `lib/linkedin/runner.ts` | `SideEffectAction` gains `"email"`; email step uses the ledger (Task 3) |
| `pages/api/runs/[id]/retry.ts` | `email` action for resolutions (Task 3); `resolveStep` unification (Task 4) |
| `pages/api/runs/index.ts` | validate → compute → single transaction (Task 5) |
| `tests/smtp-failure-classification.test.ts` | Task 1 |
| `tests/migrations-fail-closed.test.ts` | Task 2 |
| `tests/email-idempotency.test.ts` | Task 3 |
| `tests/retry-step-identity.test.ts` | Task 4 |
| `tests/run-create-atomic.test.ts` | Task 5 |
| `docs/production-readiness.md` | C2-A record (Task 6) |

Run a single suite with:

```bash
bash -lc 'NODE_ENV=test node --experimental-strip-types --experimental-test-module-mocks --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --disable-warning=ExperimentalWarning --import ./scripts/test-setup.mjs --test tests/<file>.test.ts'
```

(Referred to below as `RUN_ONE tests/<file>.test.ts`.)

---

### Task 1: SMTP failure classification and `SendResult`

**Files:**
- Modify: `lib/email/sender.ts:1-40` (imports, `sendEmail`)
- Test: `tests/smtp-failure-classification.test.ts`

**Interfaces:**
- Consumes: Nodemailer error metadata (`code`, `command`, `responseCode`), `lib/email/tls.ts` errors.
- Produces:
  ```ts
  export interface SendResult { accepted: string[]; rejected: string[]; messageId: string | null }
  export type SmtpFailureClass = "pre_send" | "rejected" | "ambiguous";
  export function classifySmtpFailure(err: unknown): SmtpFailureClass
  export async function sendEmail(account: EmailAccount, to: string, subject: string, body: string): Promise<SendResult>
  ```

- [ ] **Step 1: Write the failing unit tests (table-driven)**

Create `tests/smtp-failure-classification.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import nodemailer from "nodemailer";

const { classifySmtpFailure } = await import("@/lib/email/sender");

type Shape = { code?: string; command?: string; responseCode?: number; message?: string };
function smtpError(shape: Shape): Error {
  const err = new Error(shape.message ?? "synthetic") as Error & Shape;
  if (shape.code) err.code = shape.code;
  if (shape.command) err.command = shape.command;
  if (shape.responseCode !== undefined) err.responseCode = shape.responseCode;
  return err;
}

const cases: Array<[string, Shape | unknown, "pre_send" | "rejected" | "ambiguous"]> = [
  ["connection refused", smtpError({ code: "ECONNECTION", command: "CONN" }), "pre_send"],
  ["EHLO failure", smtpError({ code: "EPROTOCOL", command: "EHLO", responseCode: 500 }), "pre_send"],
  ["STARTTLS unavailable", smtpError({ code: "ETLS", command: "STARTTLS" }), "pre_send"],
  ["auth rejected", smtpError({ code: "EAUTH", command: "AUTH", responseCode: 535 }), "pre_send"],
  ["sender rejected", smtpError({ code: "EENVELOPE", command: "MAIL FROM", responseCode: 550 }), "pre_send"],
  ["recipient rejected", smtpError({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }), "pre_send"],
  ["API-level envelope error", smtpError({ code: "EENVELOPE", command: "API" }), "pre_send"],
  ["TLS identity mismatch (our policy)", Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "pre_send"],
  ["self-signed (our policy)", Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "pre_send"],
  ["expired cert (our policy)", Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }), "pre_send"],
  ["DATA command refused (354 never came)", smtpError({ code: "EENVELOPE", command: "DATA", responseCode: 451 }), "rejected"],
  ["body refused after final dot", smtpError({ code: "EMESSAGE", command: "DATA", responseCode: 554 }), "rejected"],
  ["timeout during DATA", smtpError({ code: "ETIMEDOUT", command: "DATA" }), "ambiguous"],
  ["socket died during DATA", smtpError({ code: "ESOCKET", command: "DATA" }), "ambiguous"],
  ["connection closed during DATA", smtpError({ code: "ECONNECTION", command: "DATA" }), "ambiguous"],
  ["no metadata at all", new Error("something odd"), "ambiguous"],
  ["non-Error throw", "a string", "ambiguous"],
  ["undefined", undefined, "ambiguous"],
];

for (const [name, err, expected] of cases) {
  test(`classifySmtpFailure: ${name} → ${expected}`, () => {
    assert.equal(classifySmtpFailure(err), expected);
  });
}

// ─── live nodemailer errors from a loopback SMTP fake ───────────────────────
// Drives nodemailer's real transport (TLS policy bypassed on purpose: this test
// is about transport error SHAPES, tests/email-tls*.test.ts own the TLS policy).

type Behaviour = "drop-after-data" | "reject-body";

async function withFakeSmtp(behaviour: Behaviour, fn: (port: number) => Promise<void>) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.write("220 fake ESMTP\r\n");
    let buffer = ""; let inData = false;
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (inData) {
          if (line !== ".") continue;
          inData = false;
          if (behaviour === "drop-after-data") { socket.destroy(); return; }
          socket.write("554 5.7.1 message rejected by policy\r\n");
          continue;
        }
        if (/^(EHLO|HELO) /.test(line)) socket.write("250-fake\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH ")) socket.write("235 ok\r\n");
        else if (line.startsWith("MAIL FROM:") || line.startsWith("RCPT TO:")) socket.write("250 ok\r\n");
        else if (line === "DATA") { inData = true; socket.write("354 go\r\n"); }
        else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("500 unsupported\r\n");
      }
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await fn(address.port);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>(r => server.close(() => r()));
  }
}

async function sendViaFake(port: number): Promise<unknown> {
  const transporter = nodemailer.createTransport({
    host: "127.0.0.1", port, secure: false, ignoreTLS: true,
    auth: { user: "u", pass: "p" }, connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 3000,
  });
  try {
    await transporter.sendMail({ from: "a@fake.test", to: "b@fake.test", subject: "s", text: "t" });
    return null;
  } catch (err) { return err; }
}

test("live: socket dropped after DATA is ambiguous", async () => {
  await withFakeSmtp("drop-after-data", async port => {
    const err = await sendViaFake(port);
    assert.ok(err instanceof Error);
    assert.equal(classifySmtpFailure(err), "ambiguous");
  });
});

test("live: 554 after the body is rejected, not ambiguous", async () => {
  await withFakeSmtp("reject-body", async port => {
    const err = await sendViaFake(port);
    assert.ok(err instanceof Error);
    assert.equal((err as Error & { responseCode?: number }).responseCode, 554);
    assert.equal(classifySmtpFailure(err), "rejected");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `RUN_ONE tests/smtp-failure-classification.test.ts`
Expected: FAIL — `classifySmtpFailure` is not exported (`TypeError: classifySmtpFailure is not a function`).

- [ ] **Step 3: Implement `SendResult` and `classifySmtpFailure`**

In `lib/email/sender.ts`, replace the `sendEmail` function and add the classifier directly below it:

```ts
export interface SendResult {
  /** Recipients the SMTP server accepted (transport acceptance, not delivery). */
  accepted: string[];
  rejected: string[];
  messageId: string | null;
}

export async function sendEmail(
  account: EmailAccount,
  to: string,
  subject: string,
  body: string
): Promise<SendResult> {
  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_secure === 1,
    auth: {
      user: account.username,
      pass: account.password,
    },
    requireTLS: true,
    tls: emailTlsOptions(account.smtp_host),
  });

  const from = account.from_name
    ? `"${account.from_name}" <${account.from_email}>`
    : account.from_email;

  const info = await transporter.sendMail({
    from, to, subject, text: body,
    ...(account.reply_to ? { replyTo: account.reply_to } : {}),
  });
  const addr = (v: unknown) => (typeof v === "string" ? v : (v as { address?: string })?.address ?? String(v));
  return {
    accepted: (info.accepted ?? []).map(addr),
    rejected: (info.rejected ?? []).map(addr),
    messageId: info.messageId ?? null,
  };
}

export type SmtpFailureClass = "pre_send" | "rejected" | "ambiguous";

/** SMTP commands that provably precede the message body. */
const PRE_DATA_COMMANDS = new Set(["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL FROM", "RCPT TO", "API"]);
/** Node TLS error codes raised by our own verification policy, before any SMTP command. */
const TLS_POLICY_CODES = /^(ERR_TLS_|CERT_|DEPTH_ZERO_|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH)/;

/**
 * Where did an SMTP send fail, and can the message have been delivered?
 *
 * - pre_send: the failure provably happened before the body was transmitted
 *   (connection, TLS policy, greeting, auth, envelope). Nothing was delivered.
 * - rejected: the server answered the DATA phase with a 4xx/5xx reply. It told
 *   us it did not accept the message.
 * - ambiguous: the socket died at or after DATA with no reply, or the error
 *   carries no recognisable metadata. Delivery cannot be ruled out. This is the
 *   DEFAULT — unknown means possibly delivered.
 */
export function classifySmtpFailure(err: unknown): SmtpFailureClass {
  if (!(err instanceof Error)) return "ambiguous";
  const { code, command, responseCode } = err as Error & { code?: string; command?: string; responseCode?: number };
  if (typeof code === "string" && TLS_POLICY_CODES.test(code)) return "pre_send";
  if (command && PRE_DATA_COMMANDS.has(command)) return "pre_send";
  if (command === "DATA") {
    return typeof responseCode === "number" && responseCode >= 400 ? "rejected" : "ambiguous";
  }
  return "ambiguous";
}
```

Note: Nodemailer's `EPROTOCOL`/`ETLS` codes on `EHLO`/`STARTTLS` are covered by the command check; `EAUTH`/`EENVELOPE` always carry a pre-DATA command or `API`, so the command check covers them too. No code-only branch is needed — this keeps the classifier keyed on *where* the failure happened.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `RUN_ONE tests/smtp-failure-classification.test.ts`
Expected: all cases PASS, including the two live loopback cases.

- [ ] **Step 5: Check the other `sendEmail` callers still typecheck**

Run: `bash -lc 'npx tsc --noEmit'` and `grep -rn "sendEmail(" pages lib --include='*.ts'`.
Expected: tsc exit 0. `pages/api/email-accounts/[id]/send-test.ts` (and any other caller) ignores the return value — no change needed. `tests/support/mail-tls-fixture.ts` awaits it and discards — no change needed.

- [ ] **Step 6: Commit**

```bash
git add lib/email/sender.ts tests/smtp-failure-classification.test.ts
bash -lc 'git commit -q -m "C2-A/PR-02: classify SMTP failures (pre_send/rejected/ambiguous); sendEmail returns transport acceptance"'
```

---

### Task 2: Fail-closed migrations and the widened ledger CHECK

**Files:**
- Modify: `lib/db.ts:333-336` (top of `runMigrations`), `lib/db.ts:608-626` (ledger DDL in `migrations[]`), `lib/db.ts:636-640` (loop)
- Test: `tests/migrations-fail-closed.test.ts`

**Interfaces:**
- Produces: `step_side_effects.action` accepts `'email'` on fresh and existing databases; `runMigrations` throws on any non-"already applied" error; new internal helper `widenStepSideEffectActions(db)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/migrations-fail-closed.test.ts`:

```ts
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// One temp DB per PROCESS: lib/db.ts caches the connection on first getDb().
// Each scenario that needs a different starting schema runs in a child process.
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "linki-migrations-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const LEGACY_LEDGER_DDL = `CREATE TABLE step_side_effects (
  id TEXT PRIMARY KEY,
  run_profile_id TEXT NOT NULL REFERENCES run_profiles(id) ON DELETE CASCADE,
  track TEXT NOT NULL,
  step_ref TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('message', 'inmail')),
  status TEXT NOT NULL CHECK(status IN ('in_flight', 'confirmed', 'abandoned')),
  body_fingerprint TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  confirmed_at TEXT,
  error_message TEXT
)`;

/** Runs `script` (ESM source) in a fresh Node process against `dbPath`; returns stdout or throws with stderr. */
function child(dbPath: string, script: string): string {
  return execFileSync(process.execPath, [
    "--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning",
    "--import", "./scripts/test-setup.mjs", "--input-type=module", "-e", script,
  ], { env: { ...process.env, LINKI_DB_PATH: dbPath, NEXTAUTH_SECRET: "x" }, encoding: "utf8", stdio: "pipe", timeout: 30_000 });
}

const OPEN_AND_REPORT = `
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='step_side_effects'").get().sql;
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='step_side_effects' ORDER BY name").all().map(r => r.name);
  const rows = db.prepare("SELECT COUNT(*) AS c FROM step_side_effects").get().c;
  console.log(JSON.stringify({ hasEmail: sql.includes("'email'"), idx, rows }));
`;

test("fresh database: ledger accepts 'email' and both indexes exist", () => {
  const out = JSON.parse(child(join(dir, "fresh.db"), OPEN_AND_REPORT));
  assert.equal(out.hasEmail, true);
  assert.deepEqual(out.idx, ["ix_step_side_effects_fingerprint", "ux_step_side_effects"]);
});

test("legacy database: ledger is rebuilt with 'email', rows and indexes preserved", () => {
  const dbPath = join(dir, "legacy.db");
  // First boot builds the current schema; then we regress the ledger to the old CHECK by hand.
  child(dbPath, OPEN_AND_REPORT);
  const raw = new Database(dbPath);
  raw.exec("DROP TABLE step_side_effects");
  raw.exec(LEGACY_LEDGER_DDL);
  raw.exec("INSERT INTO run_profiles (id, run_id, target_id) VALUES ('rp1', NULL, NULL)");
  raw.exec("INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, started_at) VALUES ('se1','rp1','linkedin','stepid:s1','t1','message','confirmed','2026-01-01')");
  raw.close();

  const out = JSON.parse(child(dbPath, OPEN_AND_REPORT));
  assert.equal(out.hasEmail, true);
  assert.equal(out.rows, 1);
  assert.deepEqual(out.idx, ["ix_step_side_effects_fingerprint", "ux_step_side_effects"]);

  // and an email row is now insertable
  const check = new Database(dbPath);
  check.exec("INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, started_at) VALUES ('se2','rp1','email','stepid:s2','t1','email','in_flight','2026-01-01')");
  check.close();
});

test("a legacy ledger missing a column makes startup fail loudly, and a later boot succeeds once fixed", () => {
  const dbPath = join(dir, "broken.db");
  child(dbPath, OPEN_AND_REPORT);
  const raw = new Database(dbPath);
  raw.exec("DROP TABLE step_side_effects");
  raw.exec(LEGACY_LEDGER_DDL.replace("  attempt_count INTEGER NOT NULL DEFAULT 1,\n", ""));
  raw.close();

  // Boot 1: rebuild's INSERT ... SELECT hits "no such column: attempt_count" → getDb throws, nothing published.
  const script = `
    const { getDb } = await import("@/lib/db");
    let first = null; try { getDb(); } catch (e) { first = e.message; }
    let second = null; try { getDb(); } catch (e) { second = e.message; }
    console.log(JSON.stringify({ first, second }));
  `;
  const out = JSON.parse(child(dbPath, script));
  assert.match(out.first, /no such column: attempt_count/);
  assert.match(out.second, /no such column: attempt_count/, "second call must re-run initialisation, not return a cached half-built handle");

  // Old table must still be intact (transaction rolled back), no *_new leftover.
  const inspect = new Database(dbPath);
  const names = inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'step_side_effects%' ORDER BY name").all().map((r: { name: string }) => r.name);
  assert.deepEqual(names, ["step_side_effects"]);
  inspect.exec("ALTER TABLE step_side_effects ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1");
  inspect.close();

  // Boot 2: converges.
  const fixed = JSON.parse(child(dbPath, OPEN_AND_REPORT));
  assert.equal(fixed.hasEmail, true);
});

test("a write lock held by another connection fails startup instead of being swallowed", () => {
  const dbPath = join(dir, "locked.db");
  child(dbPath, OPEN_AND_REPORT);
  // Regress the ledger so a rebuild (a real write) is required on next boot.
  const raw = new Database(dbPath);
  raw.exec("DROP TABLE step_side_effects");
  raw.exec(LEGACY_LEDGER_DDL);
  raw.exec("BEGIN IMMEDIATE"); // hold the write lock for the whole child run
  try {
    const script = `
      const { getDb } = await import("@/lib/db");
      try { getDb(); console.log(JSON.stringify({ ok: true })); } catch (e) { console.log(JSON.stringify({ ok: false, message: e.message })); }
    `;
    const out = JSON.parse(child(dbPath, script));
    assert.equal(out.ok, false);
    assert.match(out.message, /database is locked|SQLITE_BUSY/);
  } finally {
    raw.exec("ROLLBACK");
    raw.close();
  }
  const out = JSON.parse(child(dbPath, OPEN_AND_REPORT));
  assert.equal(out.hasEmail, true);
});

test("a column that already exists is tolerated (duplicate column name)", () => {
  const dbPath = join(dir, "dup.db");
  child(dbPath, OPEN_AND_REPORT);
  // targets.phone is added by migrations[]; on re-boot it is a duplicate → must be tolerated.
  const out = JSON.parse(child(dbPath, OPEN_AND_REPORT));
  assert.equal(out.hasEmail, true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `RUN_ONE tests/migrations-fail-closed.test.ts`
Expected: "fresh database" FAILS (`hasEmail` false); "legacy database" FAILS on the insert of an `'email'` row (CHECK constraint); "missing column" FAILS (boot does not throw). The lock test takes ~5 s (busy timeout) and currently passes vacuously or fails — either is fine at this step.

- [ ] **Step 3: Implement the widened DDL, rebuild helper, and fail-closed loop**

In `lib/db.ts`, add near the top of `runMigrations` (before `const migrations = [`):

```ts
const STEP_SIDE_EFFECTS_COLUMNS =
  "id, run_profile_id, track, step_ref, target_id, action, status, body_fingerprint, attempt_count, started_at, confirmed_at, error_message";

/** The one definition of the ledger table; `name` lets the rebuild create it under a temporary name. */
const stepSideEffectsDdl = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
      id                TEXT PRIMARY KEY,
      run_profile_id    TEXT NOT NULL REFERENCES run_profiles(id) ON DELETE CASCADE,
      track             TEXT NOT NULL,
      step_ref          TEXT NOT NULL,
      target_id         TEXT NOT NULL,
      action            TEXT NOT NULL CHECK(action IN ('message', 'inmail', 'email')),
      status            TEXT NOT NULL CHECK(status IN ('in_flight', 'confirmed', 'abandoned')),
      body_fingerprint  TEXT,
      attempt_count     INTEGER NOT NULL DEFAULT 1,
      started_at        TEXT NOT NULL,
      confirmed_at      TEXT,
      error_message     TEXT
    )`;
const STEP_SIDE_EFFECTS_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_step_side_effects ON step_side_effects(run_profile_id, track, step_ref, action)",
  "CREATE INDEX IF NOT EXISTS ix_step_side_effects_fingerprint ON step_side_effects(run_profile_id, target_id, body_fingerprint)",
];

/** Only errors that mean "this migration was already applied" are tolerated. */
const isAlreadyApplied = (err: unknown) =>
  err instanceof Error && /duplicate column name|already exists/i.test(err.message);

/**
 * C2-A (PR-02): `action` gains 'email'. SQLite cannot alter a CHECK constraint,
 * so an existing table is rebuilt under the same transaction as the rest of the
 * loop: a failure anywhere leaves the old table exactly as it was.
 */
function widenStepSideEffectActions(db: Database.Database) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='step_side_effects'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'email'")) return;
  db.exec(stepSideEffectsDdl("step_side_effects_new"));
  db.exec(`INSERT INTO step_side_effects_new (${STEP_SIDE_EFFECTS_COLUMNS}) SELECT ${STEP_SIDE_EFFECTS_COLUMNS} FROM step_side_effects`);
  db.exec("DROP TABLE step_side_effects");
  db.exec("ALTER TABLE step_side_effects_new RENAME TO step_side_effects");
  for (const sql of STEP_SIDE_EFFECTS_INDEXES) db.exec(sql);
}
```

In `migrations[]`, replace the inline ``CREATE TABLE IF NOT EXISTS step_side_effects (...)`` literal and the two index strings that follow it with:

```ts
    stepSideEffectsDdl("step_side_effects"),
    ...STEP_SIDE_EFFECTS_INDEXES,
```

(keep the explanatory comment block above them.)

Replace the loop

```ts
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
```

with

```ts
  // C2-A (PR-04): only "already applied" errors are tolerated. Anything else —
  // a lock, a malformed statement, a missing column — propagates out of
  // initialiseConnection, where getDb() closes the orphan handle and leaves the
  // singleton unset, so the process fails loudly and the next getDb() re-runs
  // from an unchanged schema. IMMEDIATE so a concurrent reader never sees a
  // half-migrated schema.
  db.transaction(() => {
    for (const sql of migrations) {
      try { db.exec(sql); } catch (err) { if (!isAlreadyApplied(err)) throw err; }
    }
    widenStepSideEffectActions(db);
  }).immediate();
```

Leave `backfillCurrentStepId`, `runParallelTracksMigration`, `dropDeprecatedRunProfileColumns`, and the presence-guarded `workflow_steps`/`targets` rebuilds below the loop exactly as they are — they run `PRAGMA foreign_keys = OFF`, which is a no-op inside a transaction, so folding them in would silently change their behaviour. Record them as a residual in Task 6.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `RUN_ONE tests/migrations-fail-closed.test.ts`
Expected: all five PASS (the lock test takes ~5 s).

- [ ] **Step 5: Run the whole suite to confirm nothing regressed**

Run: `bash -lc 'npm test' 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `fail 0`. (Existing suites boot fresh temp DBs; the widened CHECK is backward compatible.)

- [ ] **Step 6: Commit**

```bash
git add lib/db.ts tests/migrations-fail-closed.test.ts
bash -lc 'git commit -q -m "C2-A/PR-04+PR-02: migrations fail closed in one IMMEDIATE transaction; step_side_effects accepts action=email (rebuild for legacy DBs)"'
```

---

### Task 3: Email step joins the ledger; retry resolves email rows

**Files:**
- Modify: `lib/linkedin/runner.ts:441` (`SideEffectAction`), `lib/linkedin/runner.ts:1582-1591` (email send block), imports at top
- Modify: `pages/api/runs/[id]/retry.ts:126-131` (action mapping) and the three "message/InMail" reasons
- Test: `tests/email-idempotency.test.ts`

**Interfaces:**
- Consumes: Task 1 `sendEmail(): Promise<SendResult>`, `classifySmtpFailure`; Task 2 `'email'` action.
- Produces: `export type SideEffectAction = "message" | "inmail" | "email"`; email ledger rows keyed `(run_profile_id, 'email', stepRefOf(step), 'email')`; runner error text for an in-flight email contains `may already have been delivered` (the phrase the workflow page keys its "I verified delivery" button on — no UI change needed).

- [ ] **Step 1: Write the failing tests**

Create `tests/email-idempotency.test.ts`:

```ts
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-email-idem-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-email-idempotency-tests";

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { namedExports: Record<string, unknown> }) => void;

interface SendRecord { to: string; subject: string; body: string }
const sends: SendRecord[] = [];
/** What the mocked transport does. Default: accept. */
let transport: (rec: SendRecord) => Promise<{ accepted: string[]; rejected: string[]; messageId: string | null }> =
  async rec => ({ accepted: [rec.to], rejected: [], messageId: "<m@fake>" });

const realSender = await import("@/lib/email/sender");
mockModule("@/lib/email/sender", {
  namedExports: {
    ...realSender,
    sendEmail: async (_account: unknown, to: string, subject: string, body: string) => {
      const rec = { to, subject, body };
      const result = await transport(rec); // may throw BEFORE recording (pre-send) — see helpers below
      sends.push(rec);
      return result;
    },
  },
});
const realSession = await import("@/lib/linkedin/session");
mockModule("@/lib/linkedin/session", {
  namedExports: { ...realSession, getSessionPage: async () => ({ close: async () => {} }), saveSessionState: async () => {} },
});

const { executeStep, stepRefOf, bodyFingerprint } = await import("@/lib/linkedin/runner");
const { default: retryHandler } = await import("@/pages/api/runs/[id]/retry");
const { getDb } = await import("@/lib/db");

after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

// ─── helpers to shape transport behaviour ───────────────────────────────────
type SmtpShape = { code?: string; command?: string; responseCode?: number };
const smtpError = (s: SmtpShape) => Object.assign(new Error("synthetic smtp failure"), s);
/** Throws without recording a send: nothing left the process. */
const failBefore = (s: SmtpShape) => { transport = async () => { throw smtpError(s); }; };
/** Records the send, THEN throws: the message may be on the wire. */
const failAfter = (s: SmtpShape) => { transport = async rec => { sends.push(rec); throw smtpError(s); }; };
const accept = () => { transport = async rec => ({ accepted: [rec.to], rejected: [], messageId: "<m@fake>" }); };
const rejectAll = () => { transport = async rec => ({ accepted: [], rejected: [rec.to], messageId: null }); };

// ─── fixtures ───────────────────────────────────────────────────────────────
const LIMITS = { active_hours_start: 0, active_hours_end: 24, timezone: "UTC", working_days: "1,2,3,4,5,6,7", daily_connection_limit: 20, daily_message_limit: 50, daily_inmail_limit: 15 };
const EMAIL_LIMITS = { ...LIMITS, daily_email_limit: 50, ramp_up_enabled: 0, ramp_start_date: null };
const SUBJECT = "Quick question, {{first_name}}";
const BODY = "Hi {{first_name}}, following up on our connection.";
const RENDERED_SUBJECT = "Quick question, Ada";
const RENDERED_BODY = "Hi Ada, following up on our connection.";
let seq = 0;

function scenario(steps: Array<{ subject: string; body: string }> = [{ subject: SUBJECT, body: BODY }], opts: { currentStep?: number } = {}) {
  const n = ++seq;
  const ids = { run: `run-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, track: `track-${n}`, target: `target-${n}`, email: `ea-${n}` };
  const db = getDb();
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  steps.forEach((s, i) => db.prepare(
    `INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, email_subject, email_body, email_position, ai_enabled)
     VALUES (?, ?, ?, 'email', 'email', 0, ?, ?, ?, 0)`
  ).run(`step-${n}-${i}`, ids.wf, i + 1, s.subject, s.body, i + 1));
  db.prepare(
    `INSERT INTO email_accounts (id, name, from_email, smtp_host, smtp_port, smtp_secure, username, password, daily_email_limit)
     VALUES (?, 'Fixture', 'sender@fixture.test', '127.0.0.1', 2525, 0, 'u', 'plaintext-not-encrypted', 50)`
  ).run(ids.email);
  db.prepare("INSERT INTO runs (id, workflow_id, status, email_account_id) VALUES (?, ?, 'running', ?)").run(ids.run, ids.wf, ids.email);
  db.prepare("INSERT INTO targets (id, full_name, first_name, linkedin_url, email) VALUES (?, 'Ada Lovelace', 'Ada', ?, ?)")
    .run(ids.target, `https://www.linkedin.com/in/ada-${n}/`, `ada-${n}@fixture.test`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)").run(ids.profile, ids.run, ids.target, ids.email);
  db.prepare(
    `INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, current_step_id, next_step_at)
     VALUES (?, ?, 'email', 'in_progress', ?, ?, NULL)`
  ).run(ids.track, ids.profile, opts.currentStep ?? 0, `step-${n}-${opts.currentStep ?? 0}`);
  const target = db.prepare("SELECT * FROM targets WHERE id = ?").get(ids.target);
  const tr = { ...(db.prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(ids.track) as object), run_id: ids.run, target_id: ids.target, email_account_id: ids.email, account_id: `acct-${n}`, workflow_id: ids.wf };
  const stepRows = db.prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order").all(ids.wf);
  return { ids, tr, target, stepRows };
}

const run = (s: ReturnType<typeof scenario>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeStep(getDb(), s.ids.run, s.tr as any, s.target as any, s.stepRows as any, "acct-x", LIMITS, s.ids.email, EMAIL_LIMITS);
const reload = (s: ReturnType<typeof scenario>) => ({ ...s, tr: { ...s.tr, ...(getDb().prepare("SELECT * FROM run_profile_tracks WHERE id = ?").get(s.ids.track) as object) } });
const ledger = (profileId: string) =>
  getDb().prepare("SELECT step_ref, action, status, body_fingerprint, attempt_count, error_message FROM step_side_effects WHERE run_profile_id = ? ORDER BY step_ref").all(profileId) as
    Array<{ step_ref: string; action: string; status: string; body_fingerprint: string | null; attempt_count: number; error_message: string | null }>;
const track = (id: string) =>
  getDb().prepare("SELECT state, current_step, error_message, last_email_subject FROM run_profile_tracks WHERE id = ?").get(id) as
    { state: string; current_step: number; error_message: string | null; last_email_subject: string | null };
function callRetry(runId: string, body: unknown) {
  const captured = { status: 200, body: undefined as unknown };
  const res = { status(c: number) { captured.status = c; return this; }, json(p: unknown) { captured.body = p; return this; }, end() { return this; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retryHandler({ method: "POST", query: { id: runId }, body } as any, res as any);
  return captured.body as { outcomes: Array<{ outcome: string; reason?: string }> };
}
function reset() { sends.length = 0; accept(); }

// ─── tests ──────────────────────────────────────────────────────────────────

test("E1 a successful send is recorded as confirmed and the track advances", async () => {
  reset(); const s = scenario();
  await run(s);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], { to: `ada-${s.ids.target.split("-")[1]}@fixture.test`, subject: RENDERED_SUBJECT, body: RENDERED_BODY });
  const [row] = ledger(s.ids.profile);
  assert.equal(row.action, "email");
  assert.equal(row.status, "confirmed");
  assert.equal(row.step_ref, stepRefOf(s.stepRows[0] as { id: string }));
  assert.equal(row.body_fingerprint, bodyFingerprint(`${RENDERED_SUBJECT}\n\n${RENDERED_BODY}`));
  assert.equal(track(s.ids.track).state, "completed");
});

test("E2 a provably pre-send failure abandons the intent; retry re-arms; re-entry sends exactly once", async () => {
  reset(); const s = scenario();
  failBefore({ code: "EAUTH", command: "AUTH", responseCode: 535 });
  await run(s);
  assert.equal(sends.length, 0);
  assert.equal(ledger(s.ids.profile)[0].status, "abandoned");
  assert.equal(track(s.ids.track).state, "failed");
  const { outcomes } = callRetry(s.ids.run, { target_ids: [s.ids.target] });
  assert.equal(outcomes[0].outcome, "rearmed");
  accept();
  await run(reload(s));
  assert.equal(sends.length, 1);
  assert.equal(ledger(s.ids.profile)[0].status, "confirmed");
  assert.equal(ledger(s.ids.profile)[0].attempt_count, 2);
});

test("E3 an explicit server rejection after DATA is abandoned (not held)", async () => {
  reset(); const s = scenario();
  failAfter({ code: "EMESSAGE", command: "DATA", responseCode: 554 });
  await run(s);
  assert.equal(ledger(s.ids.profile)[0].status, "abandoned");
  assert.equal(callRetry(s.ids.run, { target_ids: [s.ids.target] }).outcomes[0].outcome, "rearmed");
});

test("E4 an ambiguous failure stays in_flight, blocks retry, and re-entry refuses to send", async () => {
  reset(); const s = scenario();
  failAfter({ code: "ETIMEDOUT", command: "DATA" });
  await run(s);
  const [row] = ledger(s.ids.profile);
  assert.equal(row.status, "in_flight");
  assert.match(row.error_message ?? "", /may have been delivered/);
  assert.match(track(s.ids.track).error_message ?? "", /may already have been delivered|synthetic smtp failure/);
  const { outcomes } = callRetry(s.ids.run, { target_ids: [s.ids.target] });
  assert.equal(outcomes[0].outcome, "blocked");
  sends.length = 0; accept();
  await run(reload({ ...s, tr: { ...s.tr } }));
  assert.equal(sends.length, 0, "an in_flight email row must refuse re-entry");
  assert.match(track(s.ids.track).error_message ?? "", /may already have been delivered/);
});

test("E5 mark_delivered on an in-flight email advances with zero sends", async () => {
  reset(); const s = scenario();
  failAfter({ code: "ESOCKET", command: "DATA" });
  await run(s);
  sends.length = 0;
  const { outcomes } = callRetry(s.ids.run, { target_ids: [s.ids.target], resolve: "mark_delivered" });
  assert.equal(outcomes[0].outcome, "marked_delivered");
  assert.equal(ledger(s.ids.profile)[0].status, "confirmed");
  assert.match(ledger(s.ids.profile)[0].error_message ?? "", /operator-asserted/);
  assert.equal(sends.length, 0);
  assert.equal(track(s.ids.track).state, "in_progress");
  assert.equal(track(s.ids.track).current_step, 1);
});

test("E6 resend on an in-flight email sends exactly once more", async () => {
  reset(); const s = scenario();
  failAfter({ code: "ESOCKET", command: "DATA" });
  await run(s);
  sends.length = 0;
  assert.equal(callRetry(s.ids.run, { target_ids: [s.ids.target], resolve: "resend" }).outcomes[0].outcome, "rearmed");
  accept();
  await run(reload(s));
  assert.equal(sends.length, 1);
  assert.equal(ledger(s.ids.profile)[0].status, "confirmed");
});

test("E7 a confirmed row skips the send and advances (bookkeeping-failure recovery)", async () => {
  reset(); const s = scenario();
  getDb().prepare(
    `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, body_fingerprint, started_at, confirmed_at)
     VALUES ('se-e7', ?, 'email', ?, ?, 'email', 'confirmed', NULL, datetime('now'), datetime('now'))`
  ).run(s.ids.profile, stepRefOf(s.stepRows[0] as { id: string }), s.ids.target);
  await run(s);
  assert.equal(sends.length, 0);
  assert.equal(track(s.ids.track).state, "completed");
  assert.equal(callRetry(s.ids.run, { target_ids: [s.ids.target] }).outcomes.length, 0, "nothing failed, nothing to retry");
});

test("E8 all recipients rejected without a throw is abandoned, never confirmed", async () => {
  reset(); const s = scenario();
  rejectAll();
  await run(s);
  assert.equal(ledger(s.ids.profile)[0].status, "abandoned");
  assert.equal(track(s.ids.track).state, "failed");
});

test("E9 the same subject+body under a renumbered step is refused", async () => {
  reset(); const s = scenario([{ subject: SUBJECT, body: BODY }, { subject: SUBJECT, body: BODY }], { currentStep: 1 });
  getDb().prepare(
    `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, body_fingerprint, started_at, confirmed_at)
     VALUES ('se-e9', ?, 'email', 'stepid:some-old-id', ?, 'email', 'confirmed', ?, datetime('now'), datetime('now'))`
  ).run(s.ids.profile, s.ids.target, bodyFingerprint(`${RENDERED_SUBJECT}\n\n${RENDERED_BODY}`));
  await run(s);
  assert.equal(sends.length, 0);
  assert.match(track(s.ids.track).error_message ?? "", /already sent|Refusing/);
});

test("E10 a bookkeeping failure after acceptance leaves the row confirmed and sends nothing on retry", async () => {
  reset(); const s = scenario();
  const db = getDb();
  db.exec("CREATE TRIGGER e10_fail BEFORE UPDATE OF last_email_subject ON run_profile_tracks BEGIN SELECT RAISE(ABORT, 'injected bookkeeping failure'); END");
  try { await run(s); } finally { db.exec("DROP TRIGGER e10_fail"); }
  assert.equal(sends.length, 1);
  assert.equal(ledger(s.ids.profile)[0].status, "confirmed");
  assert.notEqual(track(s.ids.track).state, "failed", "a delivered email must never look like a send failure");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `RUN_ONE tests/email-idempotency.test.ts`
Expected: E1 FAILS (no ledger row), E4/E5/E6 FAIL (retry treats email as plain re-arm), others fail on ledger assertions.

- [ ] **Step 3: Widen `SideEffectAction` and rewrite the email send block in the runner**

In `lib/linkedin/runner.ts`:

1. Line 441: `export type SideEffectAction = "message" | "inmail" | "email";`
2. Import: change `import { sendEmail } from "@/lib/email/sender";` to `import { sendEmail, classifySmtpFailure } from "@/lib/email/sender";` (find the existing import line with `grep -n 'email/sender' lib/linkedin/runner.ts`).
3. Replace the block from `const finalEmailBody = sig ? ...` through `log(db, runId, target.id, "info", \`Email sent to ${name}\`);` with:

```ts
      const finalEmailBody = sig ? `${emailBody}\n\n--\n${sig}` : emailBody;

      // ── Side-effect ledger (C2-A / PR-02) — same shape as the message step ──
      // Layer 1 keys on the step id (legacy pos: readable); Layer 2 is the
      // subject+body fingerprint, which catches a re-saved campaign renumbering
      // an already-sent email. Both refuse rather than guess.
      const emailStepRef = stepRefOf(step);
      const emailLegacyRef = legacyStepRefOf(step);
      const emailFingerprint = bodyFingerprint(`${emailSubject}\n\n${finalEmailBody}`);
      const priorEmail = sideEffectFor(db, tr.run_profile_id, tr.track, emailStepRef, "email", emailLegacyRef);

      if (priorEmail?.status === "confirmed") {
        trRecordContext(db, tr, { emailSubject, emailBody });
        trAdvance(db, tr, steps);
        log(db, runId, target.id, "info", `Email to ${name} was already accepted by the server — skipping send and advancing`);
        return;
      }
      if (priorEmail?.status === "in_flight") {
        throw new UnresolvedSideEffectError(
          `A previous attempt to email ${name} may already have been delivered (ledger ${emailStepRef} still in flight). ` +
          `Refusing to send again — resolve this manually before retrying.`
        );
      }
      const emailCollision = conflictingFingerprint(db, tr.run_profile_id, tr.target_id, emailStepRef, emailFingerprint);
      if (emailCollision) {
        throw new UnresolvedSideEffectError(
          `This exact email was already sent to ${name} at step ${emailCollision.step_ref} (now ${emailStepRef}) — ` +
          `the campaign was likely re-saved and the step renumbered. Refusing to send a duplicate.`
        );
      }
      // Commit the intent. If this insert fails, nothing is sent.
      sideEffectBegin(db, tr, emailStepRef, "email", emailFingerprint);

      db.prepare("UPDATE run_profile_tracks SET last_step_at = datetime('now') WHERE id = ?").run(tr.id);
      log(db, runId, target.id, "info", `Sending email to ${name} <${freshTarget.email}>`);
      const setEmailLedger = db.prepare(
        "UPDATE step_side_effects SET status = ?, error_message = ?, confirmed_at = ? WHERE run_profile_id = ? AND track = ? AND step_ref = ? AND action = 'email'"
      );
      let sendResult;
      try {
        sendResult = await sendEmail({ ...emailAccount, password: decryptSecret(emailAccount.password)! }, freshTarget.email, emailSubject, finalEmailBody);
      } catch (err) {
        const failure = classifySmtpFailure(err);
        const detail = err instanceof Error ? err.message.slice(0, 400) : String(err);
        if (failure === "ambiguous") {
          // Socket died at/after DATA, or an error we cannot place: the message
          // may be on its way. Leave the intent armed so nothing re-sends it.
          setEmailLedger.run("in_flight", `left in_flight — may have been delivered: ${detail}`, null, tr.run_profile_id, tr.track, emailStepRef);
          log(db, runId, target.id, "warn", `${name}: email send failed after the body was transmitted — leaving the ledger in flight because delivery cannot be ruled out`);
          throw new UnresolvedSideEffectError(
            `Email to ${name} may already have been delivered (${failure}: ${detail}). Refusing to retry automatically — resolve this manually.`
          );
        }
        // pre_send / rejected: the server never accepted the body. Safe to retract.
        setEmailLedger.run("abandoned", `${failure}: ${detail}`, null, tr.run_profile_id, tr.track, emailStepRef);
        throw err;
      }

      if (!sendResult.accepted.includes(freshTarget.email)) {
        // Resolved without a throw but the recipient was not accepted (all rejected).
        setEmailLedger.run("abandoned", `rejected: server did not accept ${freshTarget.email}`, null, tr.run_profile_id, tr.track, emailStepRef);
        trFail(db, tr, `Email rejected by server for ${freshTarget.email}`);
        log(db, runId, target.id, "error", `Email to ${name} was rejected by the server — not delivered`);
        return;
      }

      // ── past this line the server HAS accepted the message ─────────────────
      // Everything below is bookkeeping. None of it may throw out of this branch.
      try {
        setEmailLedger.run("confirmed", null, nowIso(), tr.run_profile_id, tr.track, emailStepRef);
        trRecordContext(db, tr, { emailSubject, emailBody });
        trAdvance(db, tr, steps);
        log(db, runId, target.id, "info", `Email sent to ${name}`);
      } catch (bookkeepingErr) {
        log(db, runId, target.id, "error",
          `Email to ${name} WAS accepted by the server but bookkeeping failed: ${bookkeepingErr instanceof Error ? bookkeepingErr.message : bookkeepingErr}`);
      }
```

Check that the outer `catch (err)` of `executeStep` already routes `UnresolvedSideEffectError` to `trFail` with the error message (it does for the message step; `grep -n "UnresolvedSideEffectError" lib/linkedin/runner.ts` to confirm the branch and that its `trFail` reason includes `err.message`).

- [ ] **Step 4: Teach retry about email rows**

In `pages/api/runs/[id]/retry.ts`:

```ts
      // Message, InMail and email steps have an irreversible-action ledger.
      // Anything else (connect, visit, delay) re-arms exactly as before.
      const action =
        step?.step_type === "message" ? "message" :
        step?.step_type === "sales_inmail" ? "inmail" :
        step?.step_type === "email" ? "email" : null;
```

and update the three `mark_delivered` guard messages from `message/InMail steps only` to `message/InMail/email steps only`; the inner `if (action !== "message" && action !== "inmail")` becomes `if (action !== "message" && action !== "inmail" && action !== "email")`. The `targets.message_sent_at`/`inmail_sent_at` stamps stay guarded by `action === "message" || action === "inmail"` / `action === "inmail"` respectively — wrap the `message_sent_at` stamp in `if (action !== "email")`. Update `OPERATOR_FORCED_RESEND`'s wording to `"operator forced a resend of a possibly-delivered message/email"` only if the existing tests do not assert the exact string (`grep -rn "operator forced" tests/`); otherwise leave it.

- [ ] **Step 5: Run the new suite and the neighbours**

Run: `RUN_ONE tests/email-idempotency.test.ts` → all E1–E10 PASS.
Run: `RUN_ONE tests/message-idempotency.test.ts`, `RUN_ONE tests/inmail-idempotency.test.ts`, `RUN_ONE tests/retry-ledger.test.ts` → PASS unchanged.

- [ ] **Step 6: Lint and typecheck**

Run: `bash -lc 'npx eslint . && npx tsc --noEmit'` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add lib/linkedin/runner.ts "pages/api/runs/[id]/retry.ts" tests/email-idempotency.test.ts
bash -lc 'git commit -q -m "C2-A/PR-02: email step records intent in the side-effect ledger; ambiguous SMTP failures held for operator resolution"'
```

---

### Task 4: Retry resolves steps by identity (PR-12)

**Files:**
- Modify: `pages/api/runs/[id]/retry.ts:3` (import), `:121-131` (step resolution), `:104-116` (`advance`/`rearm` use of resolved index)
- Test: `tests/retry-step-identity.test.ts`

**Interfaces:**
- Consumes: `resolveStep(tr, steps): StepResolution` from `lib/linkedin/runner.ts` (already exported).
- Produces: retry outcomes `blocked` with reasons `the step this track was pinned to no longer exists …` and `track is past the last step`; a re-armed legacy track has `current_step_id` populated.

- [ ] **Step 1: Write the failing tests**

Create `tests/retry-step-identity.test.ts`:

```ts
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-retry-identity-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-retry-identity-tests";

const { default: retryHandler } = await import("@/pages/api/runs/[id]/retry");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

function callRetry(runId: string, body: unknown) {
  const captured = { status: 200, body: undefined as unknown };
  const res = { status(c: number) { captured.status = c; return this; }, json(p: unknown) { captured.body = p; return this; }, end() { return this; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retryHandler({ method: "POST", query: { id: runId }, body } as any, res as any);
  return captured.body as { outcomes: Array<{ outcome: string; reason?: string }> };
}

let seq = 0;
/** Three connect steps A,B,C; track failed on B (index 1). */
function scenario(opts: { pinnedId?: string | null; index?: number } = {}) {
  const n = ++seq; const db = getDb();
  const ids = { run: `run-${n}`, wf: `wf-${n}`, profile: `profile-${n}`, track: `track-${n}`, target: `target-${n}`, A: `A-${n}`, B: `B-${n}`, C: `C-${n}` };
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  for (const [id, order] of [[ids.A, 1], [ids.B, 2], [ids.C, 3]] as const) {
    db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, ai_enabled) VALUES (?, ?, ?, 'linkedin', 'connect', 0, 0)").run(id, ids.wf, order);
  }
  db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run(ids.run, ids.wf);
  db.prepare("INSERT INTO targets (id, full_name, linkedin_url) VALUES (?, 'Ada', ?)").run(ids.target, `https://www.linkedin.com/in/ada-${n}/`);
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(ids.profile, ids.run, ids.target);
  db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, current_step_id, error_message) VALUES (?, ?, 'linkedin', 'failed', ?, ?, 'boom')")
    .run(ids.track, ids.profile, opts.index ?? 1, opts.pinnedId === undefined ? ids.B : opts.pinnedId);
  return ids;
}
const trackOf = (id: string) => getDb().prepare("SELECT state, current_step, current_step_id FROM run_profile_tracks WHERE id = ?").get(id) as { state: string; current_step: number; current_step_id: string | null };
const reorder = (wf: string, order: string[]) => order.forEach((id, i) => getDb().prepare("UPDATE workflow_steps SET step_order = ? WHERE id = ? AND workflow_id = ?").run(i + 1, id, wf));

test("I1 pinned step reordered: retry resolves by id and keeps the pin", () => {
  const s = scenario();
  reorder(s.ids.wf, [s.ids.B, s.ids.A, s.ids.C]); // B now index 0, stored index says 1 (= A)
  const { outcomes } = callRetry(s.ids.run, { target_ids: [s.ids.target] });
  assert.equal(outcomes[0].outcome, "rearmed");
  const t = trackOf(s.ids.track);
  assert.equal(t.state, "in_progress");
  assert.equal(t.current_step_id, s.ids.B);
  assert.equal(t.current_step, 0, "index is re-synced to where the pinned step now lives");
});

test("I2 pinned step deleted: retry blocks and touches nothing", () => {
  const s = scenario();
  getDb().prepare("DELETE FROM workflow_steps WHERE id = ?").run(s.ids.B);
  const { outcomes } = callRetry(s.ids.run, { target_ids: [s.ids.target] });
  assert.equal(outcomes[0].outcome, "blocked");
  assert.match(outcomes[0].reason ?? "", /no longer exists/);
  assert.equal(trackOf(s.ids.track).state, "failed");
});

test("I3 legacy track with no pin resolves by index and is pinned on re-arm", () => {
  const s = scenario({ pinnedId: null, index: 1 });
  const { outcomes } = callRetry(s.ids.run, { target_ids: [s.ids.target] });
  assert.equal(outcomes[0].outcome, "rearmed");
  assert.equal(trackOf(s.ids.track).current_step_id, s.ids.B);
});

test("I4 legacy track past the end blocks explicitly", () => {
  const s = scenario({ pinnedId: null, index: 7 });
  const { outcomes } = callRetry(s.ids.run, { target_ids: [s.ids.target] });
  assert.equal(outcomes[0].outcome, "blocked");
  assert.match(outcomes[0].reason ?? "", /past the last step/);
});

test("I5 a confirmed message ledger row advances from the RESOLVED index after a reorder", () => {
  const s = scenario();
  getDb().prepare("UPDATE workflow_steps SET step_type = 'message', message_body = 'hi', message_position = 1 WHERE id = ?").run(s.ids.B);
  getDb().prepare(
    `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, started_at, confirmed_at)
     VALUES ('se-i5', ?, 'linkedin', ?, ?, 'message', 'confirmed', datetime('now'), datetime('now'))`
  ).run(s.ids.profile, `stepid:${s.ids.B}`, s.ids.target);
  reorder(s.ids.wf, [s.ids.B, s.ids.A, s.ids.C]); // B → index 0, so "advance" must land on A (index 1), not C
  const { outcomes } = callRetry(s.ids.run, { target_ids: [s.ids.target] });
  assert.equal(outcomes[0].outcome, "advanced");
  const t = trackOf(s.ids.track);
  assert.equal(t.current_step, 1);
  assert.equal(t.current_step_id, s.ids.A);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `RUN_ONE tests/retry-step-identity.test.ts`
Expected: I1 FAILS (`current_step` stays 1), I2 FAILS (re-armed instead of blocked), I3 FAILS (`current_step_id` still null), I4 FAILS, I5 FAILS (advances to index 2).

- [ ] **Step 3: Implement**

In `pages/api/runs/[id]/retry.ts`:

1. Import: `import { stepRefOf, legacyStepRefOf, resolveStep } from "@/lib/linkedin/runner";`
2. `stepsFor` must return what `resolveStep` needs — widen its SELECT to `SELECT * FROM workflow_steps …` and its type to `WorkflowStep[]` (`import type { WorkflowStep } from "@/lib/linkedin/runner"`; export the type from runner if it is not already — `grep -n "export interface WorkflowStep\|export type WorkflowStep" lib/linkedin/runner.ts`).
3. Replace the `rearm` statement with one that also pins identity:

```ts
  const rearm = db.prepare(
    `UPDATE run_profile_tracks SET state = 'in_progress', error_message = NULL, next_step_at = NULL, current_step = ?, current_step_id = ? WHERE id = ?`
  );
```

4. Replace the step lookup and use the resolved index everywhere:

```ts
      const steps = stepsFor(c.workflow_id, c.track);
      // PR-12: the runner's resolver is the single source of truth. Retry can
      // never act on a step the runner would not run.
      const resolved = resolveStep({ current_step: c.current_step, current_step_id: c.current_step_id } as Parameters<typeof resolveStep>[0], steps);
      if (resolved.kind === "deleted") {
        outcomes.push({ track_id: c.id, target_id: c.target_id, outcome: "blocked",
          reason: `the step this track was pinned to (${c.current_step_id}) no longer exists — edit the campaign to restore it, or unenroll` });
        continue;
      }
      if (resolved.kind === "done") {
        outcomes.push({ track_id: c.id, target_id: c.target_id, outcome: "blocked", reason: "track is past the last step" });
        continue;
      }
      const { step, index } = resolved;
```

Then every `rearm.run(c.id)` becomes `rearm.run(index, step.id, c.id)`, and every `advance.run(c.current_step + 1, stepIdAt(c.workflow_id, c.track, c.current_step + 1), c.id)` becomes `advance.run(index + 1, stepIdAt(c.workflow_id, c.track, index + 1), c.id)`. The `!step` check in `if (!step || !action)` becomes just `if (!action)`.

If `resolveStep`'s parameter type is the full `TrackRun`, add a narrower exported signature in the runner instead of casting: `export function resolveStep(tr: Pick<TrackRun, "current_step" | "current_step_id"> & { id?: string }, steps: WorkflowStep[])` — the body only reads those fields (and `tr.id` in a warn log; make that `tr.id ?? "?"`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `RUN_ONE tests/retry-step-identity.test.ts` → I1–I5 PASS.
Run: `RUN_ONE tests/retry-ledger.test.ts`, `RUN_ONE tests/step-identity.test.ts`, `RUN_ONE tests/email-idempotency.test.ts` → PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add "pages/api/runs/[id]/retry.ts" lib/linkedin/runner.ts tests/retry-step-identity.test.ts
bash -lc 'git commit -q -m "C2-A/PR-12: retry resolves steps through resolveStep — by id, or blocks explicitly; never an index substitute"'
```

---

### Task 5: Atomic run creation (PR-11)

**Files:**
- Modify: `pages/api/runs/index.ts:41-190` (POST branch)
- Test: `tests/run-create-atomic.test.ts`

**Interfaces:**
- Produces: POST `/api/runs` writes zero rows on any 4xx/5xx; 409 `workflow_already_active` is decided inside the write transaction.

- [ ] **Step 1: Write the failing tests**

Create `tests/run-create-atomic.test.ts`:

```ts
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-run-create-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-run-create-tests";

const { default: runsHandler } = await import("@/pages/api/runs/index");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

function post(body: unknown) {
  const captured = { status: 200, body: undefined as unknown };
  const res = { status(c: number) { captured.status = c; return this; }, json(p: unknown) { captured.body = p; return this; }, end() { return this; } };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runsHandler({ method: "POST", body } as any, res as any);
  } catch (err) {
    captured.status = 500; captured.body = { error: err instanceof Error ? err.message : String(err) };
  }
  return captured;
}
const counts = () => {
  const db = getDb();
  const c = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  return { runs: c("runs"), profiles: c("run_profiles"), tracks: c("run_profile_tracks") };
};

let seq = 0;
function fixture(targetCount = 3) {
  const n = ++seq; const db = getDb();
  const ids = { wf: `wf-${n}`, list: `list-${n}`, acct: `acct-${n}`, targets: [] as string[] };
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(ids.wf, `WF ${n}`);
  db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, delay_seconds, ai_enabled) VALUES (?, ?, 1, 'linkedin', 'connect', 0, 0)").run(`s-${n}`, ids.wf);
  db.prepare("INSERT INTO lists (id, name) VALUES (?, ?)").run(ids.list, `List ${n}`);
  db.prepare("INSERT INTO accounts (id, name, email) VALUES (?, ?, ?)").run(ids.acct, `Acct ${n}`, `acct-${n}@fixture.test`);
  for (let i = 0; i < targetCount; i++) {
    const t = `t-${n}-${i}`; ids.targets.push(t);
    db.prepare("INSERT INTO targets (id, full_name, linkedin_url) VALUES (?, ?, ?)").run(t, `T ${i}`, `https://www.linkedin.com/in/t-${n}-${i}/`);
    db.prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run(ids.list, t);
  }
  return ids;
}

test("A1 success creates exactly one run, N profiles, N tracks", () => {
  const f = fixture(3); const before = counts();
  const r = post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct });
  assert.equal(r.status, 201);
  const after_ = counts();
  assert.deepEqual({ runs: after_.runs - before.runs, profiles: after_.profiles - before.profiles, tracks: after_.tracks - before.tracks }, { runs: 1, profiles: 3, tracks: 3 });
});

test("A2 unknown target id → 400 and zero rows", () => {
  const f = fixture(2); const before = counts();
  const r = post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct, target_ids: [f.targets[0], "nope"] });
  assert.equal(r.status, 400);
  assert.deepEqual(counts(), before);
});

test("A3 all targets already enrolled → 400 and zero rows", () => {
  const f = fixture(2);
  assert.equal(post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct }).status, 201);
  getDb().prepare("UPDATE runs SET status = 'completed' WHERE workflow_id = ?").run(f.wf);
  const before = counts();
  const r = post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct });
  assert.equal(r.status, 400);
  assert.equal((r.body as { error: string }).error, "all_already_enrolled");
  assert.deepEqual(counts(), before);
});

test("A4 injected child-write failure rolls back the parent too", () => {
  const f = fixture(3); const before = counts(); const db = getDb();
  // Fires on the FIRST track insert — after the run and first profile rows are already in the transaction.
  db.exec("CREATE TRIGGER a4_fail BEFORE INSERT ON run_profile_tracks BEGIN SELECT RAISE(ABORT, 'injected child failure'); END");
  try {
    const r = post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct });
    assert.equal(r.status, 500);
    assert.match((r.body as { error: string }).error, /injected child failure/);
  } finally { db.exec("DROP TRIGGER a4_fail"); }
  assert.deepEqual(counts(), before, "no run, profile or track may survive a failed child write");
});

test("A5 second create for an active workflow → 409 and zero rows", () => {
  const f = fixture(2);
  assert.equal(post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct }).status, 201);
  getDb().prepare("UPDATE runs SET status = 'running' WHERE workflow_id = ?").run(f.wf);
  const before = counts();
  const r = post({ workflow_id: f.wf, list_id: f.list, account_id: f.acct });
  assert.equal(r.status, 409);
  assert.deepEqual(counts(), before);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `RUN_ONE tests/run-create-atomic.test.ts`
Expected: A4 FAILS (a `runs` row survives: parent insert precedes the child transaction). A1/A2/A3/A5 may already pass — that is fine; A4 is the defect.

- [ ] **Step 3: Restructure the POST branch: validate → compute → write**

In `pages/api/runs/index.ts`, inside `if (req.method === "POST") {`, keep everything up to and including the `emailAccountPool` normalisation, then replace the rest of the branch with:

```ts
    const isActive = db.prepare("SELECT id FROM runs WHERE workflow_id = ? AND status IN ('running', 'paused') LIMIT 1");
    const activeConflict = () => res.status(409).json({
      error: "workflow_already_active",
      message: "This workflow is already running. Stop or pause it before enrolling a new list.",
    });
    // Check 1 (pre-flight): only one active run per workflow. Re-checked inside
    // the write transaction below, which is the one that counts.
    if (isActive.get(workflow_id)) return activeConflict();

    // ── validate (no writes) ────────────────────────────────────────────────
    const candidates: { target_id: string }[] = Array.isArray(target_ids) && target_ids.length > 0
      ? (target_ids as string[]).map((id) => ({ target_id: id }))
      : db.prepare("SELECT target_id FROM list_targets WHERE list_id = ?").all(list_id) as { target_id: string }[];

    if (Array.isArray(target_ids) && target_ids.length > 0) {
      const listErr = idListError(target_ids, "target_ids");
      if (listErr) return res.status(400).json({ error: listErr });
      const ids = target_ids as string[];
      const known = new Set(
        (db.prepare(`SELECT id FROM targets WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { id: string }[]).map(r => r.id)
      );
      const unknown = ids.filter(t => !known.has(t));
      if (unknown.length > 0) return res.status(400).json({ error: `unknown target_ids: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ` (+${unknown.length - 5} more)` : ""}` });
    }

    // ── compute (reads only) ────────────────────────────────────────────────
    const alreadyEnrolled = new Set(
      (db.prepare(`SELECT DISTINCT rp.target_id FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE r.workflow_id = ?`).all(workflow_id) as { target_id: string }[]).map((r) => r.target_id)
    );
    const activeElsewhere = new Set(
      (db.prepare(
        `SELECT DISTINCT rp.target_id FROM run_profiles rp
         JOIN runs r ON r.id = rp.run_id
         WHERE r.status IN ('running', 'paused')
         AND EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped'))`
      ).all() as { target_id: string }[]).map((r) => r.target_id)
    );
    const targets = candidates.filter((t) => !alreadyEnrolled.has(t.target_id) && !activeElsewhere.has(t.target_id));
    if (targets.length === 0) {
      return res.status(400).json({ error: "all_already_enrolled", message: "All selected contacts are already enrolled in this workflow." });
    }

    // Assign email accounts: company-grouped round-robin (unchanged logic)
    const emailAssignment: Map<string, string | null> = new Map();
    if (emailAccountPool.length > 0) {
      const targetIds = targets.map(t => t.target_id);
      const companyRows = db.prepare(`SELECT id, company_id FROM targets WHERE id IN (${targetIds.map(() => "?").join(",")})`).all(...targetIds) as { id: string; company_id: string | null }[];
      const companyAccountMap = new Map<string, string>();
      let poolCursor = 0;
      for (const row of companyRows) {
        if (row.company_id) {
          if (!companyAccountMap.has(row.company_id)) { companyAccountMap.set(row.company_id, emailAccountPool[poolCursor % emailAccountPool.length]); poolCursor++; }
          emailAssignment.set(row.id, companyAccountMap.get(row.company_id)!);
        } else {
          emailAssignment.set(row.id, emailAccountPool[poolCursor % emailAccountPool.length]); poolCursor++;
        }
      }
    }
    const workflowTracks = [...new Set((db.prepare("SELECT DISTINCT track FROM workflow_steps WHERE workflow_id = ?").all(workflow_id) as { track: string }[]).map(r => r.track))];
    if (workflowTracks.length === 0) workflowTracks.push("linkedin");
    const firstStepId = new Map<string, string | null>(workflowTracks.map(track => [track,
      (db.prepare("SELECT id FROM workflow_steps WHERE workflow_id = ? AND track = ? ORDER BY step_order LIMIT 1").get(workflow_id, track) as { id: string } | undefined)?.id ?? null]));

    // ── write (one IMMEDIATE transaction) ───────────────────────────────────
    // PR-11: the parent row used to be inserted before validation and cleaned
    // up by hand on one failure path only. Now nothing is written until every
    // check has passed, and the run, its profiles and its tracks land together
    // or not at all. IMMEDIATE takes the write lock up front so two concurrent
    // creates serialise and the loser sees the winner's active run.
    class WorkflowAlreadyActiveError extends Error {}
    const insertRun = db.prepare("INSERT INTO runs (id, workflow_id, list_id, account_id, email_account_id) VALUES (?, ?, ?, ?, ?)");
    const insertProfile = db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)");
    const insertTrack = db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, current_step_id) VALUES (?, ?, ?, 'pending', 0, ?)");
    const runId = randomUUID();
    const createRun = db.transaction(() => {
      if (isActive.get(workflow_id)) throw new WorkflowAlreadyActiveError();
      insertRun.run(runId, workflow_id, list_id, account_id, emailAccountPool[0] ?? null);
      for (const t of targets) {
        const assignedEmailAccountId = emailAssignment.get(t.target_id) ?? null;
        const rpId = randomUUID();
        insertProfile.run(rpId, runId, t.target_id, assignedEmailAccountId);
        for (const track of workflowTracks) {
          if (track === "email" && !assignedEmailAccountId) continue;
          insertTrack.run(randomUUID(), rpId, track, firstStepId.get(track) ?? null);
        }
      }
    });
    try {
      createRun.immediate();
    } catch (err) {
      if (err instanceof WorkflowAlreadyActiveError) return activeConflict();
      throw err;
    }
    return res.status(201).json({ id: runId });
```

Delete the old `activeRun` check, the early `INSERT INTO runs`, the `DELETE FROM runs WHERE id = ?` cleanup, `firstStepIdFor`, and `insertMany`. Move `class WorkflowAlreadyActiveError` to module scope (above `handler`) so it is not redeclared per request.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `RUN_ONE tests/run-create-atomic.test.ts` → A1–A5 PASS.
Run: `RUN_ONE tests/run-lifecycle-guards.test.ts` and `bash -lc 'npm test' 2>&1 | grep -E "^ℹ (pass|fail)"` → `fail 0`.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bash -lc 'npx eslint . && npx tsc --noEmit'
git add pages/api/runs/index.ts tests/run-create-atomic.test.ts
bash -lc 'git commit -q -m "C2-A/PR-11: run creation validates first, then writes run+profiles+tracks in one IMMEDIATE transaction"'
```

---

### Task 6: Integrated gate, evidence record, push

**Files:**
- Modify: `docs/production-readiness.md` (register rows PR-02, PR-04, PR-11, PR-12; new section "C2-A record")

- [ ] **Step 1: Run the isolated Docker gate**

```bash
env PATH=/usr/bin:/bin /usr/bin/node scripts/c0-verify.mjs 2>&1 | tee /tmp/c2a-gate.log | grep -E "^C0 (snapshot|isolation|RESULT|LINT|SUMMARY)|retained at"
grep -E "^# (pass|fail|skipped)" /tmp/c2a-gate.log
```

Expected: every `C0 RESULT … "exitCode":0`, `gate: true`, `# fail 0`, test count = 490 + (new cases across the five suites). Record the image id (`cat /tmp/linki-c0-*/image-id.txt` of the newest dir) and snapshot hash.

- [ ] **Step 2: Update the register rows**

In `docs/production-readiness.md`, change the last cell of the PR-02, PR-04, PR-11 and PR-12 rows (`grep -n "^| PR-02 \|^| PR-04 \|^| PR-11 \|^| PR-12 " docs/production-readiness.md`) to:

- PR-02: `**Observed (C2-A gate <date>)**: email steps record intent in \`step_side_effects\` before send; SMTP failures classified pre_send/rejected (abandoned) vs ambiguous (held in_flight); retry blocks, \`mark_delivered\`/\`resend\` resolve; 10 tests in \`tests/email-idempotency.test.ts\`, 20 in \`tests/smtp-failure-classification.test.ts\`. Transport acceptance only — bounce scan remains the delivery-failure signal. |`
- PR-04: `**Observed (C2-A gate <date>)**: \`migrations[]\` loop tolerates only duplicate-column/already-exists errors, runs in one IMMEDIATE transaction; injected missing-column and write-lock faults fail \`getDb()\` loudly with no cached handle and resume once fixed (\`tests/migrations-fail-closed.test.ts\`). Residual: the presence-guarded legacy rebuild functions below the loop still swallow errors (they toggle \`PRAGMA foreign_keys\`, which a transaction would neutralise) — open, C4 candidate. |`
- PR-11: `**Observed (C2-A gate <date>)**: validate → compute → single IMMEDIATE transaction; injected child-insert failure leaves zero run/profile/track rows; active-run 409 decided inside the write lock (\`tests/run-create-atomic.test.ts\`). |`
- PR-12: `**Observed (C2-A gate <date>)**: retry uses the runner's \`resolveStep\`; reordered → by id, deleted → blocked, legacy null-id → by index and pinned on re-arm; advance uses the resolved index (\`tests/retry-step-identity.test.ts\`). |`

- [ ] **Step 3: Append the C2-A record**

Append a `## C2-A record (<date>)` section with the same fields as the C1 gate record: timestamp, owner, source revision (the five task commits), toolchain, image identity, isolation, commands/exit codes, counts (container and host), evidence path, findings confirmed/corrected, rollback readiness (all changes are code + one backward-compatible ledger rebuild; reverting the code leaves the widened CHECK, which is harmless), unresolved blockers (legacy rebuild residual; C2-B not started), next action (C2-B), reviewer decision (**pending**).

- [ ] **Step 4: Commit and push**

```bash
git add docs/production-readiness.md
bash -lc 'git commit -q -m "Docs: C2-A gate record; PR-02/PR-04/PR-11/PR-12 observed"'
git push origin main
```

Expected: preflight PASS; push lands on `github.com:Viverun/linki.git main`.

---

## Self-review notes

- Spec §1 sender contract → Task 1; §1 schema + §4 loop → Task 2; §1 runner + retry email → Task 3; §2 → Task 4; §3 → Task 5; §5 tests → Tasks 1–5; §6 evidence → Task 6.
- Spec §1 mentioned widening a UI step-type predicate; inspection shows `pages/workflows/[id].tsx:3399` keys the "I verified delivery" button on the error text `may already have been delivered`, which the new email error preserves — no UI change (noted in Task 3 interfaces).
- Spec §4 said "rebuild in the same transaction as the loop" — Task 2 does exactly that via `widenStepSideEffectActions` inside the `.immediate()` block; the older presence-guarded rebuilds are deliberately left outside and recorded as a residual.
- Names used consistently: `classifySmtpFailure`, `SendResult`, `SideEffectAction`, `widenStepSideEffectActions`, `isAlreadyApplied`, `resolveStep`, `WorkflowAlreadyActiveError`.
