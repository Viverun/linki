import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

// lib/db.ts resolves the DB path at first getDb() call, so point it at a
// throwaway file BEFORE the module is loaded.
const dbDir = mkdtempSync(join(tmpdir(), "linki-accounts-api-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-accounts-api-tests";

// Lives here rather than beside the route: Next treats every file under
// pages/api as an API route, so a co-located *.test.ts fails `next build`.
const { default: handler } = await import("@/pages/api/accounts/[id]/index");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened, or already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

// ─── harness ─────────────────────────────────────────────────────────────────

interface Captured {
  statusCode: number;
  body: unknown;
  ended: boolean;
}

/** Minimal NextApiResponse capturing what the handler sends back. */
function mockRes(): { res: NextApiResponse; captured: Captured } {
  const captured: Captured = { statusCode: 200, body: undefined, ended: false };
  const res = {
    status(code: number) { captured.statusCode = code; return this; },
    json(body: unknown) { captured.body = body; return this; },
    end() { captured.ended = true; return this; },
    setHeader() { return this; },
  };
  return { res: res as unknown as NextApiResponse, captured };
}

// The DELETE branch awaits closeSession() before answering (PR-08), so the
// capture is only complete after the handler's promise settles.
async function del(id: string): Promise<Captured> {
  const req = { method: "DELETE", query: { id }, body: {} } as unknown as NextApiRequest;
  const { res, captured } = mockRes();
  await handler(req, res);
  return captured;
}

let seq = 0;
function makeAccount(): string {
  const id = `acct-${++seq}`;
  getDb()
    .prepare("INSERT INTO accounts (id, name, email) VALUES (?, ?, ?)")
    .run(id, `Test ${id}`, `${id}@example.com`);
  return id;
}

function attachRun(accountId: string, status = "running"): string {
  const id = `run-${accountId}`;
  getDb()
    .prepare("INSERT INTO runs (id, account_id, status) VALUES (?, ?, ?)")
    .run(id, accountId, status);
  return id;
}

const accountExists = (id: string) =>
  getDb().prepare("SELECT 1 FROM accounts WHERE id = ?").get(id) !== undefined;

// ─── DELETE ──────────────────────────────────────────────────────────────────

test("DELETE removes an account with no runs and returns 204", async () => {
  const id = makeAccount();
  const r = await del(id);
  assert.equal(r.statusCode, 204);
  assert.equal(r.ended, true);
  assert.equal(accountExists(id), false, "the row should actually be gone");
});

test("DELETE returns 404 when the account does not exist", async () => {
  const r = await del("no-such-account");
  assert.equal(r.statusCode, 404);
  assert.deepEqual(r.body, { error: "Not found" });
});

test("DELETE returns 409 instead of throwing when the account still has runs", async () => {
  // runs.account_id references accounts(id) with no ON DELETE clause, so SQLite
  // refuses the delete. The regression this guards: the raw SqliteError escaped
  // the handler as a 500, the UI ignored it and reported success, and the
  // account reappeared on refresh.
  const id = makeAccount();
  attachRun(id);

  const r = await del(id);

  assert.equal(r.statusCode, 409);
  assert.match((r.body as { error: string }).error, /runs/i);
  assert.equal(accountExists(id), true, "the account must survive a refused delete");
});

test("an account becomes deletable once its runs are gone", async () => {
  const id = makeAccount();
  const runId = attachRun(id);
  assert.equal((await del(id)).statusCode, 409);

  getDb().prepare("DELETE FROM runs WHERE id = ?").run(runId);

  assert.equal((await del(id)).statusCode, 204);
  assert.equal(accountExists(id), false);
});

test("a refused delete leaves other accounts untouched", async () => {
  const blocked = makeAccount();
  const bystander = makeAccount();
  attachRun(blocked);

  assert.equal((await del(blocked)).statusCode, 409);
  assert.equal(accountExists(bystander), true);
});
