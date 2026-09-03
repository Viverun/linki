import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

// Throwaway DB before modules load (see tests/accounts-api.test.ts).
const dbDir = mkdtempSync(join(tmpdir(), "linki-phase5-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-phase5-tests";

const { default: cancelImport } = await import("@/pages/api/imports/[id]/cancel");
const { default: integrations } = await import("@/pages/api/integrations/index");
const { default: tour } = await import("@/pages/api/tour");
const { default: workflowById } = await import("@/pages/api/workflows/[id]/index");
const { default: companyById } = await import("@/pages/api/companies/[id]");
const { default: retry } = await import("@/pages/api/runs/[id]/retry");
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

const db = () => getDb();

test("import cancel 409s terminal imports, 404s missing", () => {
  db().prepare("INSERT INTO lists (id, name) VALUES (?, ?)").run("l-p5", "L");
  db().prepare(
    "INSERT INTO list_imports (id, list_id, status) VALUES (?, ?, ?)"
  ).run("imp-done", "l-p5", "done");
  const dead = call(cancelImport, "POST", { id: "imp-done" }, {});
  assert.equal(dead.statusCode, 409);
  assert.equal((dead.body as { status: string }).status, "done");
  assert.equal(call(cancelImport, "POST", { id: "missing" }, {}).statusCode, 404);
  db().prepare("INSERT INTO list_imports (id, list_id, status) VALUES (?, ?, ?)").run("imp-run", "l-p5", "running");
  assert.equal(call(cancelImport, "POST", { id: "imp-run" }, {}).statusCode, 200);
});

test("integrations POST rejects non-slug keys", () => {
  assert.equal(call(integrations, "POST", {}, { key: "a b", api_key: "k" }).statusCode, 400);
  assert.equal(call(integrations, "POST", {}, { key: "a".repeat(33), api_key: "k" }).statusCode, 400);
  assert.equal(call(integrations, "POST", {}, { key: 42, api_key: "k" }).statusCode, 400);
  const ok = call(integrations, "POST", {}, { key: "apollo", api_key: "k" });
  assert.equal(ok.statusCode, 200);
});

test("tour POST rejects unknown pages, accepts known ones", () => {
  assert.equal(call(tour, "POST", {}, { page: "billing" }).statusCode, 400);
  assert.equal(call(tour, "POST", {}, {}).statusCode, 400);
  assert.equal(call(tour, "POST", {}, { page: "lists" }).statusCode, 200);
  const seen = call(tour, "GET", {}, {});
  assert.ok(((seen.body as { seen: string[] }).seen ?? []).includes("lists"));
});

test("workflows PATCH and companies DELETE 404 missing rows", () => {
  assert.equal(call(workflowById, "PATCH", { id: "missing" }, { is_archived: true }).statusCode, 404);
  assert.equal(call(companyById, "DELETE", { id: "missing" }, {}).statusCode, 404);
});

// ─── InMail mark_delivered ──────────────────────────────────────────────────

db().prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run("w-p5", "W");
db().prepare(
  "INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, message_body, email_subject, message_position, ai_enabled) VALUES (?, ?, 1, 'linkedin', 'sales_inmail', 'Hi', 'Subj', 1, 0)"
).run("s-p5", "w-p5");
db().prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, 'running')").run("r-p5", "w-p5");
db().prepare("INSERT INTO targets (id, full_name) VALUES (?, ?)").run("t-p5", "T Five");
db().prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run("rp-p5", "r-p5", "t-p5");
db().prepare(
  "INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, current_step_id) VALUES (?, ?, 'linkedin', 'failed', 0, ?)"
).run("rt-p5", "rp-p5", "s-p5");
db().prepare(
  `INSERT INTO step_side_effects (id, run_profile_id, track, step_ref, target_id, action, status, body_fingerprint, started_at)
   VALUES (?, ?, 'linkedin', ?, ?, 'inmail', 'in_flight', 'fp', datetime('now'))`
).run("se-p5", "rp-p5", "stepid:s-p5", "t-p5");

test("retry mark_delivered stamps an in-flight InMail without sending", () => {
  const out = call(retry, "POST", { id: "r-p5" }, { target_ids: ["t-p5"], resolve: "mark_delivered" });
  assert.equal(out.statusCode, 200);
  const body = out.body as { retried: number; outcomes: Array<{ outcome: string; reason?: string }> };
  assert.equal(body.retried, 1);
  assert.equal(body.outcomes[0].outcome, "marked_delivered");
  const ledger = db().prepare("SELECT status FROM step_side_effects WHERE id = 'se-p5'").get() as { status: string };
  assert.equal(ledger.status, "confirmed");
  const target = db().prepare("SELECT inmail_sent_at FROM targets WHERE id = 't-p5'").get() as { inmail_sent_at: string | null };
  assert.ok(target.inmail_sent_at, "inmail_sent_at stamped by operator assertion");
  const track = db().prepare("SELECT state, current_step FROM run_profile_tracks WHERE id = 'rt-p5'").get() as
    { state: string; current_step: number };
  assert.equal(track.state, "in_progress");
  assert.equal(track.current_step, 1);
});
