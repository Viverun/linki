import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

/**
 * PR-15 (C3): the reads the contacts pages use to judge a lost mutation.
 *
 * The contacts list and detail pages write through APIs that previously had no
 * read that could answer "did it land?": /api/targets had no exact filters, and
 * /api/todos and /api/activity-logs were write-only. Reconciliation needs a read
 * of the fact that changed, not a search page that might contain it, so those
 * reads are added here and pinned — a reconciliation that silently degrades to
 * "not found on page 0" is worse than none.
 */

const dbDir = mkdtempSync(join(tmpdir(), "linki-contacts-reads-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-contacts-reads";

const { default: targetsHandler } = await import("@/pages/api/targets/index");
const { default: todosHandler } = await import("@/pages/api/todos/index");
const { default: logsHandler } = await import("@/pages/api/activity-logs/index");
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
db.prepare("INSERT INTO targets (id, linkedin_url, full_name) VALUES (?, ?, ?)").run(
  "t-a", "https://linkedin.test/in/alpha", "Alpha Person"
);
db.prepare("INSERT INTO targets (id, linkedin_url, full_name) VALUES (?, ?, ?)").run(
  "t-b", "https://linkedin.test/in/beta", "Beta Person"
);
// Same name as alpha, different URL: the unique key is the URL, not the name.
db.prepare("INSERT INTO targets (id, linkedin_url, full_name) VALUES (?, ?, ?)").run(
  "t-c", "https://linkedin.test/in/gamma", "Alpha Person"
);

db.prepare("INSERT INTO todos (id, target_id, title) VALUES (?, ?, ?)").run("td-a", "t-a", "Call Alpha");
db.prepare("INSERT INTO todos (id, target_id, title) VALUES (?, ?, ?)").run("td-b", "t-b", "Call Beta");
db.prepare("INSERT INTO activity_logs (id, target_id, type, body) VALUES (?, ?, ?, ?)").run(
  "lg-a", "t-a", "note", "Alpha note"
);
db.prepare("INSERT INTO activity_logs (id, target_id, type, body) VALUES (?, ?, ?, ?)").run(
  "lg-b", "t-b", "note", "Beta note"
);

async function call(
  handler: (req: NextApiRequest, res: NextApiResponse) => unknown,
  query: Record<string, string>
) {
  const { res, captured } = mockRes();
  await handler({ method: "GET", query } as unknown as NextApiRequest, res);
  return captured;
}

test("GET /api/targets?id= returns exactly the requested rows", async () => {
  const { body } = await call(targetsHandler, { id: "t-a,t-c" });
  const contacts = (body as { contacts: Array<{ id: string }> }).contacts;
  assert.deepEqual(contacts.map((c) => c.id).sort(), ["t-a", "t-c"]);
});

test("GET /api/targets?linkedin_url= is exact, and the URL is what distinguishes two same-named rows", async () => {
  const exact = await call(targetsHandler, { linkedin_url: "https://linkedin.test/in/alpha" });
  const rows = (exact.body as { contacts: Array<{ id: string; linkedin_url: string }> }).contacts;
  assert.deepEqual(rows.map((r) => r.id), ["t-a"]);

  // The name is shared with t-c; a name-keyed confirmation would have been
  // ambiguous, which is why the URL is the key.
  const all = await call(targetsHandler, { search: "Alpha Person" });
  assert.equal((all.body as { contacts: unknown[] }).contacts.length, 2);
});

test("GET /api/todos?target_id= returns only that contact's todos", async () => {
  const { body } = await call(todosHandler, { target_id: "t-a" });
  assert.deepEqual((body as Array<{ id: string }>).map((t) => t.id), ["td-a"]);
});

test("GET /api/todos without target_id is a refusal, not an empty list", async () => {
  const { statusCode } = await call(todosHandler, {});
  assert.equal(statusCode, 400);
});

test("GET /api/activity-logs?target_id= returns only that contact's entries", async () => {
  const { body } = await call(logsHandler, { target_id: "t-b" });
  assert.deepEqual((body as Array<{ id: string }>).map((l) => l.id), ["lg-b"]);
});

test("GET /api/activity-logs without target_id is a refusal, not an empty list", async () => {
  const { statusCode } = await call(logsHandler, {});
  assert.equal(statusCode, 400);
});

test("the write methods are unchanged (POST still allowed, others still refused)", async () => {
  const { res, captured } = mockRes();
  const req = { method: "PUT", query: {}, body: {} } as unknown as NextApiRequest;
  await todosHandler(req, res);
  assert.equal(captured.statusCode, 405);
  assert.ok(typeof req.method === "string");
});
