import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-deletion-lifecycle-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-deletion-tests";

// The account DELETE closes the live browser context. Replace the session
// module before importing the route so no Playwright import happens and the
// call is observable. Bound + `namedExports` is the repo idiom: Node 22 is the
// deployment target and @types/node is pinned to v20, which types the old shape.
const closedSessions: string[] = [];
const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { namedExports: Record<string, unknown> }) => void;
mockModule("@/lib/linkedin/session", {
  namedExports: {
    closeSession: async (accountId: string) => { closedSessions.push(accountId); },
  },
});

// Resolved to `[id].ts` ahead of the `[id]/` directory by the resolve hook,
// which follows bundler precedence.
const { default: targetHandler } = await import("@/pages/api/targets/[id]");
const { default: targetsHandler } = await import("@/pages/api/targets/index");
const { default: listHandler } = await import("@/pages/api/lists/[id]/index");
const { default: runRemoveHandler } = await import("@/pages/api/runs/[id]/remove");
const { default: emailAccountHandler } = await import("@/pages/api/email-accounts/[id]/index");
const { default: accountHandler } = await import("@/pages/api/accounts/[id]/index");
const { default: companyHandler } = await import("@/pages/api/companies/[id]");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

interface Captured { status: number; body: unknown }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: any) => unknown;

async function invoke(
  handler: Handler,
  method: string,
  query: Record<string, string>,
  body?: unknown
): Promise<Captured> {
  const cap: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) { cap.status = code; return this; },
    json(payload: unknown) { cap.body = payload; return this; },
    end() { return this; },
    setHeader() { return this; },
  };
  await handler({ method, query, body } as never, res as never);
  return cap;
}

const db = getDb();
const count = (table: string, where: string, ...params: unknown[]): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...params) as { c: number }).c;

/** The scenario's run id, for tests that necessarily built one. */
function runId(f: Fixture): string {
  assert.ok(f.run, "scenario was built without a run");
  return f.run;
}

let seq = 0;

interface Fixture {
  workflow: string;
  account: string;
  target: string;
  list: string;
  run: string | null;
  profile: string | null;
  emailAccount: string | null;
}

/**
 * One target in one run, plus a second, unrelated target so tests can prove a
 * delete removed ONLY what it claimed to.
 */
function scenario(opts: {
  runStatus?: string;
  listId?: string | null;
  runEmailAccountId?: string | null;
  profileEmailAccountId?: string | null;
  withRun?: boolean;
  emailAccount?: boolean;
} = {}): Fixture {
  const n = ++seq;
  const f: Fixture = {
    workflow: `w-${n}`,
    account: `a-${n}`,
    target: `t-${n}`,
    list: `l-${n}`,
    run: null,
    profile: null,
    emailAccount: null,
  };
  db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(f.workflow, `WF ${n}`);
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES (?, ?, ?, 1)")
    .run(f.account, `Acct ${n}`, `acct${n}@example.invalid`);
  db.prepare("INSERT INTO targets (id, full_name, linkedin_url) VALUES (?, ?, ?)")
    .run(f.target, `Person ${n}`, `https://www.linkedin.com/in/person-${n}/`);
  db.prepare("INSERT INTO lists (id, name) VALUES (?, ?)").run(f.list, `List ${n}`);

  if (opts.emailAccount !== false) {
    f.emailAccount = `ea-${n}`;
    db.prepare(
      `INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password)
       VALUES (?, ?, ?, 'smtp.example.invalid', ?, 'secret')`
    ).run(f.emailAccount, `Mail ${n}`, `mail${n}@example.invalid`, `mail${n}@example.invalid`);
  }

  if (opts.withRun !== false) {
    f.run = `r-${n}`;
    db.prepare(
      `INSERT INTO runs (id, workflow_id, account_id, list_id, email_account_id, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      f.run,
      f.workflow,
      f.account,
      opts.listId === undefined ? f.list : opts.listId,
      opts.runEmailAccountId === undefined ? f.emailAccount : opts.runEmailAccountId,
      opts.runStatus ?? "completed",
    );
    f.profile = `p-${n}`;
    db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)")
      .run(f.profile, f.run, f.target, opts.profileEmailAccountId ?? null);
    db.prepare("INSERT INTO logs (id, run_id, target_id, level, message) VALUES (?, ?, ?, 'info', 'seed')")
      .run(`log-${n}`, f.run, f.target);
  }
  return f;
}

// ─── targets ─────────────────────────────────────────────────────────────────

test("target delete is refused while its run is running", async () => {
  const f = scenario({ runStatus: "running" });
  const r = await invoke(targetHandler, "DELETE", { id: f.target });
  assert.equal(r.status, 409);
  assert.equal((r.body as { active_runs: number }).active_runs, 1);
  assert.equal(count("targets", "id = ?", f.target), 1, "the contact must survive");
  assert.equal(count("run_profiles", "target_id = ?", f.target), 1, "the runner's profile must survive");
  assert.equal(count("logs", "target_id = ?", f.target), 1, "its log must survive");
});

test("target delete is refused while its run is paused", async () => {
  const f = scenario({ runStatus: "paused" });
  const r = await invoke(targetHandler, "DELETE", { id: f.target });
  assert.equal(r.status, 409);
  assert.equal(count("targets", "id = ?", f.target), 1);
});

test("target delete succeeds for a terminal run and removes only that target's history", async () => {
  const f = scenario({ runStatus: "completed" });
  const other = scenario({ runStatus: "completed" });

  const r = await invoke(targetHandler, "DELETE", { id: f.target });
  assert.equal(r.status, 200);
  assert.equal(count("targets", "id = ?", f.target), 0);
  assert.equal(count("run_profiles", "target_id = ?", f.target), 0);
  assert.equal(count("logs", "target_id = ?", f.target), 0);
  // The run row (accounting) and the other contact stay.
  assert.equal(count("runs", "id = ?", f.run), 1, "run-level accounting must survive");
  assert.equal(count("targets", "id = ?", other.target), 1, "unrelated contact must survive");
  assert.equal(count("run_profiles", "target_id = ?", other.target), 1);
});

test("bulk target delete refuses the whole batch when one contact is live", async () => {
  const live = scenario({ runStatus: "running" });
  const idle = scenario({ runStatus: "completed" });

  const r = await invoke(targetsHandler, "DELETE", {}, { target_ids: [live.target, idle.target] });
  assert.equal(r.status, 409);
  assert.equal(count("targets", "id = ?", live.target), 1);
  assert.equal(count("targets", "id = ?", idle.target), 1, "an all-or-nothing batch must not delete the idle one");
});

test("bulk target delete removes idle contacts", async () => {
  const a = scenario({ runStatus: "completed" });
  const b = scenario({ runStatus: "completed" });
  const r = await invoke(targetsHandler, "DELETE", {}, { target_ids: [a.target, b.target] });
  assert.equal(r.status, 200);
  assert.equal((r.body as { deleted: number }).deleted, 2);
  assert.equal(count("targets", "id = ?", a.target), 0);
  assert.equal(count("targets", "id = ?", b.target), 0);
});

// ─── lists ───────────────────────────────────────────────────────────────────

test("list delete is refused while one of its runs is active", async () => {
  const f = scenario({ runStatus: "running" });
  const r = await invoke(listHandler, "DELETE", { id: f.list });
  assert.equal(r.status, 409);
  assert.equal(count("lists", "id = ?", f.list), 1);
  assert.equal(count("runs", "id = ?", f.run), 1);
});

test("list delete removes the list and its terminal runs", async () => {
  const f = scenario({ runStatus: "completed" });
  const r = await invoke(listHandler, "DELETE", { id: f.list });
  assert.equal(r.status, 204);
  assert.equal(count("lists", "id = ?", f.list), 0);
  assert.equal(count("runs", "id = ?", f.run), 0);
  assert.equal(count("run_profiles", "target_id = ?", f.target), 0, "profiles cascade off the run");
});

// ─── removing contacts from a run ────────────────────────────────────────────

test("run remove is refused while the run is running", async () => {
  const f = scenario({ runStatus: "running" });
  const r = await invoke(runRemoveHandler, "POST", { id: runId(f) }, { target_ids: [f.target] });
  assert.equal(r.status, 409);
  assert.equal(count("run_profiles", "target_id = ?", f.target), 1);
  assert.equal(count("logs", "target_id = ?", f.target), 1);
});

test("run remove succeeds on a terminal run", async () => {
  const f = scenario({ runStatus: "completed" });
  const r = await invoke(runRemoveHandler, "POST", { id: runId(f) }, { target_ids: [f.target] });
  assert.equal(r.status, 200);
  assert.equal((r.body as { removed: number }).removed, 1);
  assert.equal(count("run_profiles", "target_id = ?", f.target), 0);
  assert.equal(count("logs", "target_id = ?", f.target), 0);
});

// ─── email accounts ──────────────────────────────────────────────────────────

test("email account delete is refused while an active run sends from it", async () => {
  // The run row does not name the sender; the profile does. The guard must
  // follow run_profiles, not just runs.email_account_id.
  scenario({
    runStatus: "running",
    runEmailAccountId: null,
    profileEmailAccountId: "ea-live",
  });
  db.prepare(
    `INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password)
     VALUES ('ea-live', 'Live', 'live@example.invalid', 'smtp.example.invalid', 'live', 'secret')`
  ).run();
  const r = await invoke(emailAccountHandler, "DELETE", { id: "ea-live" });
  assert.equal(r.status, 409);
  assert.equal(count("email_accounts", "id = 'ea-live'"), 1);
});

test("email account delete reports run history as a conflict, not a 500", async () => {
  const f = scenario({ runStatus: "completed" });
  assert.ok(f.emailAccount);
  const r = await invoke(emailAccountHandler, "DELETE", { id: f.emailAccount });
  assert.equal(r.status, 409, "FK refusal must be a readable conflict");
  assert.match(String((r.body as { error: string }).error), /history/i);
  assert.equal(count("email_accounts", "id = ?", f.emailAccount), 1);
});

test("email account delete removes an unreferenced account", async () => {
  const f = scenario({ withRun: false });
  assert.ok(f.emailAccount);
  const r = await invoke(emailAccountHandler, "DELETE", { id: f.emailAccount });
  assert.equal(r.status, 200);
  assert.equal(count("email_accounts", "id = ?", f.emailAccount), 0);
});

// ─── companies ───────────────────────────────────────────────────────────────

test("company delete unlinks its contacts and removes only that company", async () => {
  const n = ++seq;
  const company = `co-${n}`;
  const untouched = `co-other-${n}`;
  const contact = `ct-${n}`;
  const contactElsewhere = `ct-other-${n}`;
  db.prepare("INSERT INTO companies (id, name) VALUES (?, ?)").run(company, `Co ${n}`);
  db.prepare("INSERT INTO companies (id, name) VALUES (?, ?)").run(untouched, `Co Other ${n}`);
  db.prepare("INSERT INTO targets (id, full_name, company_id) VALUES (?, ?, ?)")
    .run(contact, `Person ${n}`, company);
  db.prepare("INSERT INTO targets (id, full_name, company_id) VALUES (?, ?, ?)")
    .run(contactElsewhere, `Person Other ${n}`, untouched);

  const r = await invoke(companyHandler, "DELETE", { id: company });
  assert.equal(r.status, 200);
  assert.equal(count("companies", "id = ?", company), 0);
  // The contact survives, detached — deleting a company must not delete people.
  assert.equal(count("targets", "id = ?", contact), 1);
  assert.equal(count("targets", "id = ? AND company_id IS NULL", contact), 1);
  // The bystander company and its contact are untouched.
  assert.equal(count("companies", "id = ?", untouched), 1);
  assert.equal(count("targets", "id = ? AND company_id = ?", contactElsewhere, untouched), 1);
});

test("company delete of an unknown company is a 404", async () => {
  const r = await invoke(companyHandler, "DELETE", { id: "no-such-company" });
  assert.equal(r.status, 404);
});

// ─── accounts (browser ownership) ────────────────────────────────────────────

test("account delete is refused by run history and leaves the session open", async () => {
  const f = scenario({ runStatus: "completed" });
  const r = await invoke(accountHandler, "DELETE", { id: f.account });
  assert.equal(r.status, 409);
  assert.equal(count("accounts", "id = ?", f.account), 1);
  assert.ok(!closedSessions.includes(f.account), "a refused delete must not tear down a live context");
});

test("account delete closes the live browser context after the row is gone", async () => {
  const f = scenario({ withRun: false });
  const r = await invoke(accountHandler, "DELETE", { id: f.account });
  assert.equal(r.status, 204);
  assert.equal(count("accounts", "id = ?", f.account), 0);
  assert.ok(closedSessions.includes(f.account), "the context must not outlive its account row");
});
