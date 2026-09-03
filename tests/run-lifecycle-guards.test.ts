import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

// Throwaway DB before modules load (see tests/accounts-api.test.ts).
const dbDir = mkdtempSync(join(tmpdir(), "linki-run-guards-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-run-guards-tests";

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { exports: Record<string, unknown> }) => void;

// start.ts calls ensureGlobalRunnerStarted() on success, which parks a ref'd
// 30s poll loop on the event loop — the test process would never exit.
// Stub the boundary; the status transition (the part under test) happens first.
mockModule("@/lib/linkedin/runner", {
  exports: {
    ensureGlobalRunnerStarted() { /* stubbed: no loop in tests */ },
  },
});

const { default: start } = await import("@/pages/api/runs/[id]/start");
const { default: enroll } = await import("@/pages/api/runs/[id]/enroll");
const { default: remove } = await import("@/pages/api/runs/[id]/remove");
const { default: runById } = await import("@/pages/api/runs/[id]/index");
const { default: listById } = await import("@/pages/api/lists/[id]/index");
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
// Minimal graph: workflow + list + runs in each terminal state.
db().prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run("w-guards", "W");
db().prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, step_type) VALUES (?, ?, ?, ?)").run("s-guards", "w-guards", 1, "visit");
db().prepare("INSERT INTO lists (id, name) VALUES (?, ?)").run("l-guards", "L");
for (const [id, status] of [["r-running", "running"], ["r-paused", "paused"], ["r-completed", "completed"]] as const) {
  db().prepare("INSERT INTO runs (id, workflow_id, list_id, status) VALUES (?, ?, ?, ?)").run(id, "w-guards", "l-guards", status);
}
db().prepare("INSERT INTO targets (id, full_name) VALUES (?, ?)").run("t-guards-1", "Guard One");

// ─── start ──────────────────────────────────────────────────────────────────

test("start refuses a completed run (terminal), allows paused", () => {
  const dead = call(start, "POST", { id: "r-completed" }, {});
  assert.equal(dead.statusCode, 409);
  assert.equal((dead.body as { status: string }).status, "completed");
  assert.equal(call(start, "POST", { id: "missing" }, {}).statusCode, 404);
  assert.equal(call(start, "POST", { id: "r-running" }, {}).statusCode, 400);
  const resumed = call(start, "POST", { id: "r-paused" }, {});
  assert.equal(resumed.statusCode, 200);
  db().prepare("UPDATE runs SET status = 'paused' WHERE id = 'r-paused'").run();
});

// ─── enroll ─────────────────────────────────────────────────────────────────

test("enroll refuses completed runs and non-string target_ids", () => {
  const dead = call(enroll, "POST", { id: "r-completed" }, { target_ids: ["t-guards-1"] });
  assert.equal(dead.statusCode, 409);
  assert.equal(call(enroll, "POST", { id: "missing" }, { target_ids: ["t-guards-1"] }).statusCode, 404);
  assert.equal(call(enroll, "POST", { id: "r-running" }, { target_ids: "t-guards-1" }).statusCode, 400);
  const ok = call(enroll, "POST", { id: "r-running" }, { target_ids: ["t-guards-1"] });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.body as { enrolled: number }).enrolled, 1);
});

// ─── remove ─────────────────────────────────────────────────────────────────

test("remove validates strictly, 404s unknown runs, clears logs", () => {
  assert.equal(call(remove, "POST", { id: "r-running" }, { target_ids: "t-guards-1" }).statusCode, 400);
  assert.equal(call(remove, "POST", { id: "missing" }, { target_ids: ["t-guards-1"] }).statusCode, 404);
  db().prepare("INSERT INTO logs (id, run_id, target_id, message) VALUES (?, ?, ?, ?)").run(
    "log-guards-1", "r-running", "t-guards-1", "hello"
  );
  const out = call(remove, "POST", { id: "r-running" }, { target_ids: ["t-guards-1"] });
  assert.equal(out.statusCode, 200);
  assert.equal((out.body as { removed: number }).removed, 1);
  assert.equal(db().prepare("SELECT 1 FROM logs WHERE id = 'log-guards-1'").get(), undefined);
  assert.equal(db().prepare("SELECT 1 FROM run_profiles WHERE run_id = 'r-running'").get(), undefined);
});

// ─── runs DELETE / lists DELETE ─────────────────────────────────────────────

test("runs DELETE refuses live runs and 404s missing", () => {
  assert.equal(call(runById, "DELETE", { id: "r-running" }, {}).statusCode, 409);
  assert.equal(call(runById, "DELETE", { id: "missing" }, {}).statusCode, 404);
  assert.equal(call(runById, "DELETE", { id: "r-completed" }, {}).statusCode, 200);
});

test("lists DELETE 404s missing lists", () => {
  assert.equal(call(listById, "DELETE", { id: "missing" }, {}).statusCode, 404);
});
