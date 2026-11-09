import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * PR-15 (C3): the prospects endpoint gained a `target_id` filter so that a
 * mutation's outcome can be judged by reading the rows it touched, rather than
 * paging the table and hoping the row lands in the first 25.
 *
 * That distinction is the difference between "it is not there" and "I did not
 * look far enough", which `reconcileMutation` is built to preserve — so the
 * filter is load-bearing for the reconciliation on the campaign detail page and
 * gets a test of its own rather than being covered incidentally by the UI drill.
 */

const dbDir = mkdtempSync(join(tmpdir(), "linki-prospects-filter-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-prospects-filter";

const { default: handler } = await import("@/pages/api/workflows/[id]/prospects");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

function mockRes() {
  const captured = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) { captured.statusCode = code; return this; },
    json(body: unknown) { captured.body = body; return this; },
    end() { return this; },
    setHeader() { return this; },
  };
  return { res: res as unknown as NextApiResponse, captured };
}

const db = getDb();
const workflowId = "w-prospects";
db.prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run(workflowId, "Filter campaign");
db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track) VALUES (?, ?, ?, ?, ?)")
  .run("ws-1", workflowId, 1, "connect", "linkedin");
db.prepare("INSERT INTO runs (id, workflow_id, status) VALUES (?, ?, ?)").run("run-1", workflowId, "running");

// 30 prospects so that the unfiltered first page (25) cannot contain them all —
// which is exactly the reason a filter is needed.
for (let i = 0; i < 30; i++) {
  const n = String(i).padStart(2, "0");
  db.prepare("INSERT INTO targets (id, linkedin_url, full_name) VALUES (?, ?, ?)").run(
    `t-${n}`, `https://example.test/in/${n}`, `Zeta Person ${n}`
  );
  db.prepare("INSERT INTO run_profiles (id, run_id, target_id) VALUES (?, ?, ?)").run(`rp-${n}`, "run-1", `t-${n}`);
  db.prepare(
    "INSERT INTO run_profile_tracks (id, run_profile_id, track, state) VALUES (?, ?, 'linkedin', 'pending')"
  ).run(`rpt-${n}`, `rp-${n}`);
}
// Sorts last by name, so it is certainly outside page 0 without the filter.
db.prepare("UPDATE targets SET full_name = 'Zzz Last' WHERE id = 't-29'").run();

async function get(query: Record<string, string>) {
  const { res, captured } = mockRes();
  await handler({ method: "GET", query: { id: workflowId, ...query } } as unknown as NextApiRequest, res);
  return captured.body as { prospects: Array<{ target_id: string }>; total: number };
}

test("without a target filter the first page is what it always was (25 rows)", async () => {
  const body = await get({});
  assert.equal(body.total, 30);
  assert.equal(body.prospects.length, 25);
  assert.ok(
    !body.prospects.some((p) => p.target_id === "t-29"),
    "the control target must not be on page 0, or the filter test proves nothing"
  );
});

test("a target_id filter returns that row even when it is not on the first page", async () => {
  const body = await get({ target_id: "t-29" });
  assert.equal(body.total, 1);
  assert.deepEqual(body.prospects.map((p) => p.target_id), ["t-29"]);
});

test("a comma-separated filter returns exactly the requested rows", async () => {
  const body = await get({ target_id: "t-00,t-29" });
  assert.equal(body.total, 2);
  assert.deepEqual(body.prospects.map((p) => p.target_id).sort(), ["t-00", "t-29"]);
});

test("a filter for an unknown id confirms absence rather than returning a page", async () => {
  const body = await get({ target_id: "t-not-here" });
  assert.equal(body.total, 0);
  assert.deepEqual(body.prospects, []);
});
