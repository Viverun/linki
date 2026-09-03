import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

// Throwaway DB before modules load (see tests/accounts-api.test.ts).
const dbDir = mkdtempSync(join(tmpdir(), "linki-partial-update-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-partial-update-tests";

const { default: companyById } = await import("@/pages/api/companies/[id]");
const { default: stepById } = await import("@/pages/api/workflows/[id]/steps/[stepId]");
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

// ─── companies PUT ──────────────────────────────────────────────────────────

const companyId = "c-partial-1";
getDb().prepare(
  "INSERT INTO companies (id, name, domain, industry) VALUES (?, ?, ?, ?)"
).run(companyId, "Acme", "acme.test", "SaaS");

test("companies PUT partial update preserves omitted fields", () => {
  const out = call(companyById, "PUT", { id: companyId }, { industry: "Fintech" });
  assert.equal(out.statusCode, 200);
  const row = out.body as Record<string, unknown>;
  assert.equal(row.industry, "Fintech");
  assert.equal(row.name, "Acme");
  assert.equal(row.domain, "acme.test");
});

test("companies PUT explicit null clears, empty body 400s, missing 404s", () => {
  const cleared = call(companyById, "PUT", { id: companyId }, { domain: null });
  assert.equal(cleared.statusCode, 200);
  assert.equal((cleared.body as Record<string, unknown>).domain, null);
  assert.equal((cleared.body as Record<string, unknown>).name, "Acme");
  assert.equal(call(companyById, "PUT", { id: companyId }, {}).statusCode, 400);
  assert.equal(call(companyById, "PUT", { id: "missing" }, { name: "x" }).statusCode, 404);
});

// ─── workflow step PUT ──────────────────────────────────────────────────────

const workflowId = "w-partial-1";
const stepId = "s-partial-1";
getDb().prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(workflowId, "W");
getDb().prepare(
  "INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, connect_note, message_body) VALUES (?, ?, ?, ?, ?, ?)"
).run(stepId, workflowId, 1, "connect", "original note", "original body");

test("step PUT partial update preserves omitted bodies", () => {
  const out = call(stepById, "PUT", { id: workflowId, stepId }, { step_order: 2 });
  assert.equal(out.statusCode, 200);
  const row = getDb().prepare("SELECT * FROM workflow_steps WHERE id = ?").get(stepId) as Record<string, unknown>;
  assert.equal(row.step_order, 2);
  assert.equal(row.connect_note, "original note");
  assert.equal(row.message_body, "original body");
});

test("step PUT explicit null clears one body, keeps the other", () => {
  const out = call(stepById, "PUT", { id: workflowId, stepId }, { connect_note: null });
  assert.equal(out.statusCode, 200);
  const row = getDb().prepare("SELECT * FROM workflow_steps WHERE id = ?").get(stepId) as Record<string, unknown>;
  assert.equal(row.connect_note, null);
  assert.equal(row.message_body, "original body");
});
