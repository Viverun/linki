import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throwaway DB before modules load (see tests/accounts-api.test.ts).
const dbDir = mkdtempSync(join(tmpdir(), "linki-secret-mig-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-secret-migration-tests";

const { getDb, encryptLegacySecretsMigration } = await import("@/lib/db");
const { decryptSecret, isEncrypted } = await import("@/lib/crypto");

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

test("migration encrypts plaintext rows and round-trips", () => {
  const db = getDb();
  db.prepare("INSERT INTO accounts (id, name, email, cookies_json) VALUES (?, ?, ?, ?)").run(
    "a-mig", "A", "a@t.dev", JSON.stringify([{ name: "li_at", value: "abc" }])
  );
  db.prepare("INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password, imap_password) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "e-mig", "E", "e@t.dev", "smtp.t.dev", "u", "plain-smtp", "plain-imap"
  );
  db.prepare("INSERT INTO integrations (key, api_key) VALUES (?, ?)").run("apollo", "plain-key");

  encryptLegacySecretsMigration(db);

  const acct = db.prepare("SELECT cookies_json FROM accounts WHERE id = 'a-mig'").get() as { cookies_json: string };
  const email = db.prepare("SELECT password, imap_password FROM email_accounts WHERE id = 'e-mig'").get() as
    { password: string; imap_password: string };
  const integ = db.prepare("SELECT api_key FROM integrations WHERE key = 'apollo'").get() as { api_key: string };
  assert.ok(isEncrypted(acct.cookies_json), "session blob encrypted");
  assert.ok(isEncrypted(email.password) && isEncrypted(email.imap_password), "email passwords encrypted");
  assert.ok(isEncrypted(integ.api_key), "api key encrypted");
  assert.equal(decryptSecret(email.password), "plain-smtp", "round-trips");
  assert.equal(
    (JSON.parse(decryptSecret(acct.cookies_json)!) as Array<{ value: string }>)[0].value,
    "abc", "session round-trips"
  );
});

test("migration is idempotent and leaves encrypted rows untouched", () => {
  const db = getDb();
  const before = db.prepare("SELECT password FROM email_accounts WHERE id = 'e-mig'").get() as { password: string };
  encryptLegacySecretsMigration(db);
  const after = db.prepare("SELECT password FROM email_accounts WHERE id = 'e-mig'").get() as { password: string };
  assert.equal(after.password, before.password, "second pass changes nothing");
});
