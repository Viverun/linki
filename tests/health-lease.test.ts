import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-health-lease-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-health-lease-tests";

const { default: health } = await import("@/pages/api/health");
const lease = await import("@/lib/linkedin/lease");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

function get() {
  const captured = { status: 200, body: undefined as unknown };
  const res = { status(c: number) { captured.status = c; return this; }, json(p: unknown) { captured.body = p; return this; }, setHeader() { return this; }, end() { return this; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  health({ method: "GET", query: {}, headers: {} } as any, res as any);
  return captured.body as { runner?: { lease?: { owner: string | null; mine: boolean; expires_in_s: number | null } } };
}

test("HL1 health reports no lease when none is stored", () => {
  getDb().prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('runner_progress_at', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(new Date().toISOString());
  assert.deepEqual(get().runner?.lease, { owner: null, mine: false, expires_in_s: null });
});

test("HL2 health reports a foreign lease as not mine with a positive expiry", () => {
  lease.acquireRunnerLease(getDb(), "other:1:deadbeef", 120_000);
  const l = get().runner!.lease!;
  assert.equal(l.owner, "other:1:deadbeef");
  assert.equal(l.mine, false);
  assert.ok(l.expires_in_s! > 100 && l.expires_in_s! <= 120);
});

test("HL3 health reports our own lease as mine", () => {
  lease.acquireRunnerLease(getDb(), lease.RUNNER_OWNER, 120_000, Date.now() + 200_000);
  assert.equal(get().runner!.lease!.mine, true);
});
