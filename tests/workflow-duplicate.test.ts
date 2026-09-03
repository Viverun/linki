import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

// Throwaway DB before modules load (see tests/accounts-api.test.ts).
const dbDir = mkdtempSync(join(tmpdir(), "linki-duplicate-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-duplicate-tests";

const { default: duplicate } = await import("@/pages/api/workflows/[id]/duplicate");
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

// Source workflow: prompt + an email-track step with signature + a disabled step.
const sourceId = "w-dup-src";
getDb().prepare("INSERT INTO workflows (id, name, description, prompt) VALUES (?, ?, ?, ?)").run(
  sourceId, "Orig", "desc", "Speak like a pirate"
);
getDb().prepare(
  `INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track, connect_note, email_subject, email_signature, enabled)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run("s-dup-1", sourceId, 1, "connect", "linkedin", "note", null, null, 0);
getDb().prepare(
  `INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track, email_subject, email_signature, enabled)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
).run("s-dup-2", sourceId, 1, "email", "email", "Hello", "Sent from my iPhone", 1);

test("duplicate preserves prompt, track, signature and enabled flag", () => {
  const req = { method: "POST", query: { id: sourceId }, body: {} } as unknown as NextApiRequest;
  const { res, captured } = mockRes();
  duplicate(req, res);
  assert.equal(captured.statusCode, 201);
  const newId = (captured.body as { id: string }).id;

  const wf = getDb().prepare("SELECT * FROM workflows WHERE id = ?").get(newId) as Record<string, unknown>;
  assert.equal(wf.prompt, "Speak like a pirate");
  assert.equal(wf.description, "desc");

  const steps = getDb().prepare(
    "SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_type"
  ).all(newId) as Array<Record<string, unknown>>;
  assert.equal(steps.length, 2);
  const connect = steps.find(s => s.step_type === "connect")!;
  const email = steps.find(s => s.step_type === "email")!;
  assert.equal(connect.track, "linkedin");
  assert.equal(connect.enabled, 0);
  assert.equal(email.track, "email");
  assert.equal(email.email_signature, "Sent from my iPhone");
  assert.equal(email.email_subject, "Hello");
});

test("duplicate of missing workflow 404s", () => {
  const req = { method: "POST", query: { id: "missing" }, body: {} } as unknown as NextApiRequest;
  const { res, captured } = mockRes();
  duplicate(req, res);
  assert.equal(captured.statusCode, 404);
});
