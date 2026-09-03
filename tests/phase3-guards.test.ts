import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

// Throwaway DB before modules load (see tests/accounts-api.test.ts).
const dbDir = mkdtempSync(join(tmpdir(), "linki-phase3-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-phase3-tests";

const { escapeLike, idListError, MAX_ID_LIST } = await import("@/lib/api-validate");
const { default: companies } = await import("@/pages/api/companies/index");
const { default: removeMembers } = await import("@/pages/api/lists/[id]/remove-members");
const { default: addMembers } = await import("@/pages/api/lists/[id]/add-members");
const { default: moveTargets } = await import("@/pages/api/lists/[id]/move-targets");
const { default: enroll } = await import("@/pages/api/runs/[id]/enroll");
const { default: apolloEnrich } = await import("@/pages/api/lists/[id]/apollo-enrich");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

function mockRes() {
  const captured = { statusCode: 200, body: undefined as unknown, ended: false };
  const res = {
    status(code: number) { captured.statusCode = code; return this; },
    json(body: unknown) { captured.body = body; return this; },
    end() { captured.ended = true; return this; },
    setHeader() { return this; },
  };
  return { res: res as unknown as NextApiResponse, captured };
}

function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, method: string, query: object, body: unknown) {
  const req = { method, query, body: body ?? {} } as unknown as NextApiRequest;
  const { res, captured } = mockRes();
  (handler as (req: NextApiRequest, res: NextApiResponse) => void)(req, res);
  return captured;
}

// ─── escapeLike unit ────────────────────────────────────────────────────────

test("escapeLike neutralizes %, _ and backslash", () => {
  assert.equal(escapeLike("100%"), "100\\%");
  assert.equal(escapeLike("a_b"), "a\\_b");
  assert.equal(escapeLike("a\\b"), "a\\\\b");
  assert.equal(escapeLike("plain"), "plain");
});

test("idListError enforces shape and the 500 cap", () => {
  assert.equal(idListError(["a"], "ids"), null);
  assert.ok((idListError("abc", "ids") ?? "").includes("non-empty array"));
  assert.ok((idListError([], "ids") ?? "").includes("non-empty array"));
  assert.ok((idListError(new Array(MAX_ID_LIST + 1).fill("x"), "ids") ?? "").includes("exceeds"));
  assert.equal(idListError(new Array(MAX_ID_LIST).fill("x"), "ids"), null);
});

// ─── fixtures ───────────────────────────────────────────────────────────────

const db = () => getDb();
db().prepare("INSERT INTO companies (id, name) VALUES (?, ?)").run("c-pct", "100% Real");
db().prepare("INSERT INTO companies (id, name) VALUES (?, ?)").run("c-thou", "1000 Fake");
db().prepare("INSERT INTO lists (id, name) VALUES (?, ?)").run("l-p3", "L");
db().prepare("INSERT INTO lists (id, name) VALUES (?, ?)").run("l-p3-dest", "LD");
db().prepare("INSERT INTO targets (id, full_name, title) VALUES (?, ?, ?)").run("t-under", "U", "Senior_Dev");
db().prepare("INSERT INTO targets (id, full_name, title) VALUES (?, ?, ?)").run("t-x", "X", "SeniorXDev");
db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run("l-p3", "t-under");
db().prepare("INSERT INTO list_targets (list_id, target_id) VALUES (?, ?)").run("l-p3", "t-x");
db().prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run("w-p3", "W");
db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, step_type) VALUES (?, ?, ?, ?)").run("s-p3", "w-p3", 1, "visit");
db().prepare("INSERT INTO runs (id, workflow_id, list_id, status) VALUES (?, ?, ?, ?)").run("r-p3", "w-p3", "l-p3", "running");

// ─── wildcard escaping ──────────────────────────────────────────────────────

test("companies search treats % literally", () => {
  const out = call(companies, "GET", { search: "100%", full: "1" }, {});
  assert.equal(out.statusCode, 200);
  const names = ((out.body as { companies: Array<{ name: string }> }).companies ?? out.body as Array<{ name: string }>);
  const list = Array.isArray(names) ? names : (out.body as { companies: Array<{ name: string }> }).companies;
  assert.ok(list.some(c => c.name === "100% Real"), "literal match present");
  assert.ok(!list.some(c => c.name === "1000 Fake"), "unescaped % must not widen to 1000");
});

test("remove-members patterns treat _ literally (dry_run)", () => {
  const out = call(removeMembers, "POST", { id: "l-p3" }, { title_patterns: ["Senior_Dev"], dry_run: true });
  assert.equal(out.statusCode, 200);
  const body = out.body as { would_remove: number; contacts: Array<{ id: string }> };
  assert.equal(body.would_remove, 1);
  assert.equal(body.contacts[0].id, "t-under");
});

// ─── caps ───────────────────────────────────────────────────────────────────

test("add-members rejects oversized and malformed lists", () => {
  const big = new Array(MAX_ID_LIST + 1).fill("t-under");
  const over = call(addMembers, "POST", { id: "l-p3" }, { contact_ids: big });
  assert.equal(over.statusCode, 400);
  assert.equal(call(addMembers, "POST", { id: "l-p3" }, { contact_ids: "t-under" }).statusCode, 400);
});

// ─── FK checks ──────────────────────────────────────────────────────────────

test("move-targets 404s a missing source and reports unknown targets", () => {
  assert.equal(call(moveTargets, "POST", { id: "missing" }, { target_ids: ["t-under"], destination_list_id: "l-p3-dest" }).statusCode, 404);
  const out = call(moveTargets, "POST", { id: "l-p3" }, { target_ids: ["t-under", "ghost"], destination_list_id: "l-p3-dest" });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.body, { moved: 1, skipped_unknown: 1 });
  const member = db().prepare("SELECT 1 FROM list_targets WHERE list_id = 'l-p3-dest' AND target_id = 't-under'").get();
  assert.ok(member, "known target actually moved");
});

test("enroll reports unknown targets instead of FK-throwing", () => {
  const out = call(enroll, "POST", { id: "r-p3" }, { target_ids: ["ghost"] });
  assert.equal(out.statusCode, 200);
  assert.equal((out.body as { enrolled: number; skipped_unknown: number }).skipped_unknown, 1);
});

test("apollo-enrich rejects a malformed target_ids", () => {
  const out = call(apolloEnrich, "POST", { id: "l-p3" }, { target_ids: "t-under" });
  assert.equal(out.statusCode, 400);
});

// ─── TLS single-decision tripwire ───────────────────────────────────────────

test("email TLS verification is decided only in lib/email/tls.ts", async () => {
  const { emailTlsOptions, EMAIL_TLS_REJECT_UNAUTHORIZED } = await import("@/lib/email/tls");
  assert.deepEqual(emailTlsOptions(), { rejectUnauthorized: EMAIL_TLS_REJECT_UNAUTHORIZED });
  // Tripwire (source-text-drift precedent): a new inline rejectUnauthorized
  // reintroduces a second decision point — route it through the helper instead.
  const hits = execFileSync("rg", ["-l", "rejectUnauthorized", "lib", "pages", "scripts"], { encoding: "utf8" })
    .split("\n").map(s => s.trim()).filter(Boolean);
  assert.deepEqual(hits, ["lib/email/tls.ts"]);
});
