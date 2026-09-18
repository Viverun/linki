import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

const dbDir = mkdtempSync(join(tmpdir(), "linki-capabilities-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-capabilities-tests";

const { default: premiumStatus } = await import("@/pages/api/premium-status");
const { default: replyPolicy } = await import("@/pages/api/settings/reply-policy");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

function call(handler: (req: NextApiRequest, res: NextApiResponse) => unknown, method: string, body?: unknown) {
  const captured = { status: 200, body: undefined as unknown };
  const res = { status(c: number) { captured.status = c; return this; }, json(p: unknown) { captured.body = p; return this; }, end() { return this; }, setHeader() { return this; } };
  handler({ method, body, query: {} } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return captured;
}

test("C1 premium-status exposes open-core capabilities (this build has no ee/)", () => {
  const r = call(premiumStatus, "GET");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { hasPremium: false, capabilities: { linkedinReplyDetection: false, emailReplyClassification: "open-core" } });
});

test("C2 reply-policy GET returns the default and PUT validates the range", () => {
  assert.deepEqual(call(replyPolicy, "GET").body, { ooo_threshold: 0.9, default: 0.9 });
  assert.equal(call(replyPolicy, "PUT", { ooo_threshold: 0.3 }).status, 400);
  assert.equal(call(replyPolicy, "PUT", { ooo_threshold: "abc" }).status, 400);
  assert.deepEqual(call(replyPolicy, "PUT", { ooo_threshold: 0.8 }).body, { ooo_threshold: 0.8 });
  assert.deepEqual(call(replyPolicy, "GET").body, { ooo_threshold: 0.8, default: 0.9 });
  assert.equal(call(replyPolicy, "DELETE").status, 405);
});
