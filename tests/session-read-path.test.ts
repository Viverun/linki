import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * NF-8, second half: the guard must be ON THE PATH, not merely present.
 *
 * `lib/linkedin/session.test.ts` proves `decryptSessionState` refuses a
 * plaintext blob. That says nothing about whether anything calls it. Reverting
 * `getOrCreateContext` to its previous inline `JSON.parse(decryptSecret(...))`
 * leaves the guard exported, tested, green — and dead. A mutation doing exactly
 * that survived the unit tests, which is what this file exists to close.
 *
 * Reaching `getOrCreateContext` means reaching a browser launch, so playwright
 * is mocked at the module boundary. No chromium starts, no network, no LinkedIn.
 */

const dbDir = mkdtempSync(join(tmpdir(), "linki-readpath-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-read-path-tests";

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { exports: Record<string, unknown> }) => void;

/** Records what the "browser" was handed, so we can tell a refusal from a load. */
let contextsCreated: Array<{ storageState: unknown }> = [];

const fakeContext = {
  on() { /* close handler */ },
  async close() { /* noop */ },
  async newPage() { return {}; },
};

mockModule("playwright-extra", {
  exports: {
    chromium: {
      use() { /* stealth plugin */ },
      async launch() {
        return {
          isConnected: () => true,
          async close() { /* noop */ },
          async newContext(options: { storageState?: unknown }) {
            contextsCreated.push({ storageState: options?.storageState });
            return fakeContext;
          },
        };
      },
    },
  },
});

const session = await import("@/lib/linkedin/session");
const { getDb } = await import("@/lib/db");
const { encryptSecret } = await import("@/lib/crypto");
const db = getDb();

after(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

let seq = 0;
function makeAccount(cookiesJson: string | null): string {
  const id = `acct-${seq++}`;
  db.prepare(
    "INSERT INTO accounts (id, name, email, cookies_json, is_authenticated) VALUES (?, ?, ?, ?, 1)"
  ).run(id, "Test", `${id}@example.com`, cookiesJson);
  return id;
}

const storageState = { cookies: [{ name: "li_at", value: "v", domain: ".linkedin.com", path: "/" }], origins: [] };

test("NF-8 path: getSessionContext REFUSES an account whose session is stored in plaintext", async () => {
  contextsCreated = [];
  const id = makeAccount(JSON.stringify(storageState));   // never enveloped

  await assert.rejects(
    () => session.getSessionContext(id),
    (err: unknown) => err instanceof Error && err.name === "UnencryptedSessionError",
    "the read path itself must refuse, not just the helper in isolation"
  );
  assert.equal(contextsCreated.length, 0,
    "and it must refuse BEFORE handing anything to a browser context");
});

test("NF-8 path: an enveloped session is loaded into the context as before", async () => {
  contextsCreated = [];
  const id = makeAccount(encryptSecret(JSON.stringify(storageState)));

  const ctx = await session.getSessionContext(id);
  assert.ok(ctx, "a context is returned");
  assert.equal(contextsCreated.length, 1, "exactly one context created");
  assert.deepEqual(
    (contextsCreated[0].storageState as typeof storageState).cookies.map(c => c.name),
    ["li_at"],
    "with the decrypted state actually passed through — the guard must not have eaten it"
  );

  await session.closeSession(id);
});

test("NF-8 path: an account with no stored session still starts a clean context", async () => {
  contextsCreated = [];
  const id = makeAccount(null);

  const ctx = await session.getSessionContext(id);
  assert.ok(ctx);
  assert.equal(contextsCreated.length, 1);
  assert.equal(contextsCreated[0].storageState, undefined,
    "no session means no storage state — not an error");

  await session.closeSession(id);
});
