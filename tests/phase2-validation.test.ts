import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

// Throwaway DB before modules load (see tests/accounts-api.test.ts).
const dbDir = mkdtempSync(join(tmpdir(), "linki-phase2-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-phase2-tests";

const { isStringArray, pageParams, methodNotAllowed } = await import("@/lib/api-validate");
const { default: targets } = await import("@/pages/api/targets/index");
const { default: runs } = await import("@/pages/api/runs/index");
const { default: listImport } = await import("@/pages/api/lists/[id]/import");
const { default: listEnrich } = await import("@/pages/api/lists/[id]/enrich");
const { default: syncStatus } = await import("@/pages/api/lists/[id]/sync-status");
const { default: emailAccountById } = await import("@/pages/api/email-accounts/[id]/index");
const { default: templateById } = await import("@/pages/api/templates/[id]");
const { default: accountById } = await import("@/pages/api/accounts/[id]/index");
const { default: update } = await import("@/pages/api/system/update");
const { default: premium } = await import("@/pages/api/premium-status");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

function mockRes() {
  const headers: Record<string, unknown> = {};
  const captured = { statusCode: 200, body: undefined as unknown, ended: false, headers };
  const res = {
    status(code: number) { captured.statusCode = code; return this; },
    json(body: unknown) { captured.body = body; return this; },
    end() { captured.ended = true; return this; },
    setHeader(k: string, v: unknown) { headers[k] = v; return this; },
  };
  return { res: res as unknown as NextApiResponse, captured };
}

function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, method: string, query: object, body: unknown) {
  const req = { method, query, body: body ?? {} } as unknown as NextApiRequest;
  const { res, captured } = mockRes();
  (handler as (req: NextApiRequest, res: NextApiResponse) => void)(req, res);
  return captured;
}

// ─── helper unit ────────────────────────────────────────────────────────────

test("isStringArray rejects strings, empties and mixed arrays", () => {
  assert.equal(isStringArray(["a", "b"]), true);
  assert.equal(isStringArray("abc"), false);
  assert.equal(isStringArray([]), false);
  assert.equal(isStringArray(["a", 1]), false);
  assert.equal(isStringArray(undefined), false);
});

test("pageParams clamps garbage to safe ints", () => {
  assert.deepEqual(pageParams({ page: "2", limit: "10" }), { limit: 10, offset: 20 });
  assert.deepEqual(pageParams({ page: "abc", limit: "-5" }), { limit: 1, offset: 0 });
  assert.deepEqual(pageParams({ page: "-3", limit: "99999" }), { limit: 500, offset: 0 });
  assert.deepEqual(pageParams({}), { limit: 50, offset: 0 });
});

test("methodNotAllowed sets Allow and 405s", () => {
  const { res, captured } = mockRes();
  methodNotAllowed(res, ["GET", "POST"]);
  assert.equal(captured.statusCode, 405);
  assert.deepEqual(captured.headers["Allow"], ["GET", "POST"]);
  assert.equal(captured.ended, true);
});

// ─── fixtures ───────────────────────────────────────────────────────────────

const db = () => getDb();
db().prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run("w-p2", "W");
db().prepare("INSERT INTO lists (id, name, sales_nav_url) VALUES (?, ?, ?)").run("l-p2", "L", "https://www.linkedin.com/search/results/people/?x=1");
db().prepare("INSERT INTO accounts (id, name, email) VALUES (?, ?, ?)").run("a-p2", "A", "a@test.dev");
db().prepare("INSERT INTO targets (id, full_name) VALUES (?, ?)").run("t-p2", "P Two");

// ─── crash vectors + status codes ───────────────────────────────────────────

test("targets GET survives garbage paging", () => {
  const out = call(targets, "GET", { page: "abc", limit: "-5" }, {});
  assert.equal(out.statusCode, 200);
  assert.equal(typeof (out.body as { total: number }).total, "number");
  const clamped = call(targets, "GET", { limit: "99999" }, {});
  assert.equal(clamped.statusCode, 200);
});

test("runs POST 404s unknown FKs and 409s an active workflow", () => {
  assert.equal(call(runs, "POST", {}, { workflow_id: "nope", list_id: "l-p2", account_id: "a-p2" }).statusCode, 404);
  assert.equal(call(runs, "POST", {}, { workflow_id: "w-p2", list_id: "nope", account_id: "a-p2" }).statusCode, 404);
  assert.equal(call(runs, "POST", {}, { workflow_id: "w-p2", list_id: "l-p2", account_id: "nope" }).statusCode, 404);
  db().prepare("INSERT INTO runs (id, workflow_id, list_id, account_id, status) VALUES (?, ?, ?, ?, ?)").run(
    "r-p2-live", "w-p2", "l-p2", "a-p2", "running"
  );
  const conflict = call(runs, "POST", {}, { workflow_id: "w-p2", list_id: "l-p2", account_id: "a-p2" });
  assert.equal(conflict.statusCode, 409);
  assert.equal((conflict.body as { error: string }).error, "workflow_already_active");
});

test("import/enrich/sync-status 404 a missing account", () => {
  assert.equal(call(listImport, "POST", { id: "l-p2" }, { sales_nav_url: "https://x", account_id: "nope" }).statusCode, 404);
  assert.equal(call(listEnrich, "POST", { id: "l-p2" }, { account_id: "nope" }).statusCode, 404);
  assert.equal(call(syncStatus, "POST", { id: "l-p2" }, { account_id: "nope" }).statusCode, 404);
  const unauthed = call(syncStatus, "POST", { id: "l-p2" }, { account_id: "a-p2" });
  assert.equal(unauthed.statusCode, 400);
});

test("DELETE 404s and PUT 404s on single-resource routes", () => {
  assert.equal(call(emailAccountById, "DELETE", { id: "missing" }, {}).statusCode, 404);
  assert.equal(call(templateById, "DELETE", { id: "missing" }, {}).statusCode, 404);
  assert.equal(call(templateById, "PUT", { id: "missing" }, { name: "x" }).statusCode, 404);
  assert.equal(call(accountById, "PUT", { id: "missing" }, { name: "x" }).statusCode, 404);
});

test("update + premium-status reject non-GET with Allow", () => {
  const u = call(update, "POST", {}, {});
  assert.equal(u.statusCode, 405);
  assert.deepEqual(u.headers["Allow"], ["GET"]);
  const p = call(premium, "POST", {}, {});
  assert.equal(p.statusCode, 405);
  assert.deepEqual(p.headers["Allow"], ["GET"]);
  assert.equal(call(premium, "GET", {}, {}).statusCode, 200);
});
