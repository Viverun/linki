import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";

// Throwaway DB before modules load (see tests/accounts-api.test.ts).
const dbDir = mkdtempSync(join(tmpdir(), "linki-phase4-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-phase4-tests";

const { profileVanityOf } = await import("@/lib/linkedin-url");
const { default: targets } = await import("@/pages/api/targets/index");
const { default: runs } = await import("@/pages/api/runs/index");
const { default: listTargets } = await import("@/pages/api/lists/[id]/targets");
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

// ─── profileVanityOf unit (N7b + NF-9 at the boundary) ──────────────────────

test("profileVanityOf accepts shaped URLs, rejects the N7b/NF-9 shapes", () => {
  assert.equal(profileVanityOf("https://www.linkedin.com/in/jamil-khan-55a621346"), "jamil-khan-55a621346");
  assert.equal(profileVanityOf("https://uk.linkedin.com/in/bob?trk=x"), "bob");
  assert.equal(profileVanityOf("https://www.linkedin.com/in/"), null);
  assert.equal(profileVanityOf("https://example.com/in/"), null);
  assert.equal(profileVanityOf("https://example.com/in/bob"), null);
  assert.equal(profileVanityOf("https://linkedin.com.evil.tld/in/bob"), null);
  assert.equal(profileVanityOf("not a url"), null);
  assert.equal(profileVanityOf(null), null);
  assert.equal(profileVanityOf(undefined), null);
});

// ─── fixtures ───────────────────────────────────────────────────────────────

const db = () => getDb();
db().prepare("INSERT INTO workflows (id, name) VALUES (?, ?)").run("w-p4", "W");
db().prepare("INSERT INTO lists (id, name) VALUES (?, ?)").run("l-p4", "L");
db().prepare("INSERT INTO accounts (id, name, email) VALUES (?, ?, ?)").run("a-p4", "A", "a@t.dev");

// ─── targets POST shape validation ──────────────────────────────────────────

test("targets POST rejects null-vanity, foreign-host and non-URL linkedin_urls", () => {
  for (const bad of [
    "https://www.linkedin.com/in/",
    "https://example.com/in/bob",
    "https://linkedin.com.evil.tld/in/bob",
    "not a url",
  ]) {
    const out = call(targets, "POST", {}, { full_name: "Bad", linkedin_url: bad });
    assert.equal(out.statusCode, 400, bad);
    assert.match((out.body as { error: string }).error, /valid LinkedIn profile URL/);
  }
});

test("targets POST accepts a shaped URL and pins duplicate + unknown-list behavior", () => {
  const good = "https://www.linkedin.com/in/ada-lovelace-testonly";
  const created = call(targets, "POST", {}, { full_name: "Ada", linkedin_url: good, list_id: "l-p4" });
  assert.equal(created.statusCode, 201);
  const dup = call(targets, "POST", {}, { full_name: "Ada 2", linkedin_url: good });
  assert.equal(dup.statusCode, 409);
  const badList = call(targets, "POST", {}, {
    full_name: "No List", linkedin_url: "https://www.linkedin.com/in/no-list-row", list_id: "missing",
  });
  assert.equal(badList.statusCode, 404);
  // The rejected insert must not leave a half-created target behind.
  const orphan = db().prepare("SELECT 1 FROM targets WHERE linkedin_url = ?").get("https://www.linkedin.com/in/no-list-row");
  assert.equal(orphan, undefined);
});

// ─── runs POST + list-targets DELETE ────────────────────────────────────────

test("runs POST rejects unknown explicit target_ids instead of FK-throwing", () => {
  const out = call(runs, "POST", {}, {
    workflow_id: "w-p4", list_id: "l-p4", account_id: "a-p4", target_ids: ["ghost"],
  });
  assert.equal(out.statusCode, 400);
  assert.match((out.body as { error: string }).error, /unknown target_ids/);
});

test("list-targets DELETE 404s unknown lists and 400s malformed bodies", () => {
  assert.equal(call(listTargets, "DELETE", { id: "missing" }, { target_ids: ["x"] }).statusCode, 404);
  assert.equal(call(listTargets, "DELETE", { id: "l-p4" }, { target_ids: "x" }).statusCode, 400);
});
