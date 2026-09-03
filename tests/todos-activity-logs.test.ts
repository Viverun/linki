import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

// Throwaway DB before modules load (see tests/accounts-api.test.ts).
const dbDir = mkdtempSync(join(tmpdir(), "linki-todos-logs-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-todos-logs-tests";

const { default: todosPost } = await import("@/pages/api/todos/index");
const { default: todosById } = await import("@/pages/api/todos/[id]");
const { default: activityLogs } = await import("@/pages/api/activity-logs/index");
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

const targetId = "t-todos-1";
getDb().prepare("INSERT INTO targets (id, full_name) VALUES (?, ?)").run(targetId, "Todo Test");

// ─── todos ──────────────────────────────────────────────────────────────────

test("POST /api/todos creates and returns the row", () => {
  const out = call(todosPost, "POST", {}, { target_id: targetId, title: "Call back", due_date: "2026-09-01" });
  assert.equal(out.statusCode, 201);
  const row = out.body as Record<string, unknown>;
  assert.equal(row.title, "Call back");
  assert.equal(row.status, "open");
  assert.equal(row.target_id, targetId);
});

test("POST /api/todos rejects missing title and unknown target", () => {
  assert.equal(call(todosPost, "POST", {}, { target_id: targetId }).statusCode, 400);
  assert.equal(call(todosPost, "POST", {}, { target_id: "nope", title: "x" }).statusCode, 404);
  assert.equal(call(todosPost, "GET", {}, {}).statusCode, 405);
});

test("PATCH /api/todos/[id] partial-updates and validates status", () => {
  const created = call(todosPost, "POST", {}, { target_id: targetId, title: "Orig", description: "keep me" });
  const id = (created.body as { id: string }).id;
  const patched = call(todosById, "PATCH", { id }, { status: "done" });
  assert.equal(patched.statusCode, 200);
  assert.equal((patched.body as { status: string }).status, "done");
  assert.equal((patched.body as { description: string }).description, "keep me");
  assert.equal(call(todosById, "PATCH", { id }, { status: "bogus" }).statusCode, 400);
  assert.equal(call(todosById, "PATCH", { id }, {}).statusCode, 400);
  assert.equal(call(todosById, "PATCH", { id: "missing" }, { status: "done" }).statusCode, 404);
});

test("DELETE /api/todos/[id] removes, 404 when missing", () => {
  const created = call(todosPost, "POST", {}, { target_id: targetId, title: "bye" });
  const id = (created.body as { id: string }).id;
  assert.equal(call(todosById, "DELETE", { id }, {}).statusCode, 200);
  assert.equal(call(todosById, "DELETE", { id }, {}).statusCode, 404);
});

// ─── activity_logs ──────────────────────────────────────────────────────────

test("POST /api/activity-logs creates; rejects bad type and unknown target", () => {
  const out = call(activityLogs, "POST", {}, { target_id: targetId, type: "call", body: "Talked" });
  assert.equal(out.statusCode, 201);
  assert.equal((out.body as { type: string }).type, "call");
  assert.equal(call(activityLogs, "POST", {}, { target_id: targetId, type: "hug", body: "x" }).statusCode, 400);
  assert.equal(call(activityLogs, "POST", {}, { target_id: targetId, type: "note" }).statusCode, 400);
  assert.equal(call(activityLogs, "POST", {}, { target_id: "nope", type: "note", body: "x" }).statusCode, 404);
});

test("PATCH/DELETE /api/activity-logs?id= edits and removes", () => {
  const created = call(activityLogs, "POST", {}, { target_id: targetId, type: "note", body: "first" });
  const id = (created.body as { id: string }).id;
  const patched = call(activityLogs, "PATCH", { id }, { body: "second" });
  assert.equal(patched.statusCode, 200);
  assert.equal((patched.body as { body: string }).body, "second");
  assert.equal((patched.body as { type: string }).type, "note");
  assert.equal(call(activityLogs, "PATCH", {}, { body: "x" }).statusCode, 400);
  assert.equal(call(activityLogs, "DELETE", { id }, {}).statusCode, 200);
  assert.equal(call(activityLogs, "DELETE", { id }, {}).statusCode, 404);
  assert.equal(call(activityLogs, "GET", {}, {}).statusCode, 405);
});
