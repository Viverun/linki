import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * Phase 0: SSR pages must fail closed without a session.
 *
 * Every page with getServerSideProps queries the DB directly (bypassing
 * proxy.ts, which only gates /api/*) and embeds rows in SSR HTML. The
 * client-side AuthGuard hides UI but `curl <page>` still executed SSR.
 * Each page must call requirePageSession(ctx) first and return the guard.
 */

const dbDir = mkdtempSync(join(tmpdir(), "linki-ssr-auth-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-ssr-auth-tests";

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { exports: Record<string, unknown> }) => void;

let tokenValue: { email?: string } | null = null;
mockModule("next-auth/jwt", {
  exports: {
    async getToken() {
      return tokenValue;
    },
  },
});

const { requirePageSession } = await import("@/lib/page-auth");

test("requirePageSession: no token redirects to /login", async () => {
  tokenValue = null;
  const out = await requirePageSession({ req: {}, res: {} } as never);
  assert.deepEqual(out, { redirect: { destination: "/login", permanent: false } });
});

test("requirePageSession: token without email redirects to /login", async () => {
  tokenValue = {};
  const out = await requirePageSession({ req: {}, res: {} } as never);
  assert.deepEqual(out, { redirect: { destination: "/login", permanent: false } });
});

test("requirePageSession: valid token returns null (page proceeds)", async () => {
  tokenValue = { email: "owner@example.com" };
  const out = await requirePageSession({ req: {}, res: {} } as never);
  assert.equal(out, null);
});

const GUARDED_PAGES = [
  "pages/settings.tsx",
  "pages/contacts/index.tsx",
  "pages/contacts/[id].tsx",
  "pages/companies/index.tsx",
  "pages/companies/[id].tsx",
  "pages/lists/index.tsx",
  "pages/lists/[id].tsx",
  "pages/workflows/index.tsx",
  "pages/workflows/[id].tsx",
];

test("Phase 0: all 9 SSR pages call requirePageSession(ctx) and honor the guard", async () => {
  const { stripComments } = await import("@/tests/support/source-text");
  for (const rel of GUARDED_PAGES) {
    const src = stripComments(readFileSync(rel, "utf8"));
    assert.match(src, /requirePageSession\(ctx\)/, `${rel} must call requirePageSession(ctx)`);
    assert.match(src, /if \(guard\) return guard;/, `${rel} must return the guard`);
    const guardIdx = src.indexOf("requirePageSession(ctx)");
    const dbIdx = src.indexOf("getDb()");
    assert.ok(guardIdx !== -1 && dbIdx !== -1 && guardIdx < dbIdx, `${rel}: guard must precede first getDb()`);
  }
});
