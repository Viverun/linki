/**
 * Restore drill: prove a backup is RESTORABLE, not merely readable.
 *
 * Run:
 *   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *        --disable-warning=ExperimentalWarning --import ./scripts/test-setup.mjs \
 *        scripts/restore-drill.ts [path/to/snapshot.db]
 *
 * Read-only with respect to the live database. Everything happens on a copy in a
 * scratch directory, which is removed at the end.
 *
 * ── why this goes further than "health returns 200" ──────────────────────────
 *
 * A restored database that opens, passes integrity_check and serves /api/health
 * proves the SCHEMA came back. It does not prove the system came back.
 *
 * Every LinkedIn account's session lives in `accounts.cookies_json`, encrypted
 * with a key derived from NEXTAUTH_SECRET. If the secret and the database are
 * not restored together, the rows are intact, decryptable by nobody, and the
 * automation cannot act as any account. The database alone is not a backup —
 * which is exactly why the secret is part of the backup set, and why this drill
 * decrypts a real cookie rather than asserting in a document that it would work.
 *
 * ── I9 ───────────────────────────────────────────────────────────────────────
 *
 * The plaintext is never printed, never written, and never included in an error.
 * Only its SHAPE is reported: how many cookies, and which cookie NAMES are
 * present. A drill that leaks the session it is validating has failed.
 */

import { copyFileSync, mkdtempSync, rmSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { decryptSecret, isEncrypted } from "@/lib/crypto";

const SOURCE_DIR = join("data", "backups");

function newestSnapshot(): string {
  const candidates = readdirSync(SOURCE_DIR)
    .filter(f => /^linki-auto-\d{8}T\d{6}Z\.db$/.test(f))
    .sort()
    .reverse();
  if (candidates.length === 0) throw new Error(`no auto snapshot found in ${SOURCE_DIR} — run scripts/backup.mjs first`);
  return join(SOURCE_DIR, candidates[0]);
}

interface Step { name: string; ok: boolean; detail: string }
const steps: Step[] = [];
function record(name: string, ok: boolean, detail: string) {
  steps.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail}`);
}

function main() {
  const snapshot = process.argv[2] ?? newestSnapshot();
  if (!existsSync(snapshot)) throw new Error(`snapshot not found: ${snapshot}`);

  console.log(`\nRESTORE DRILL`);
  console.log(`  snapshot: ${snapshot} (${statSync(snapshot).size} B)\n`);

  // ── the clock starts here: this is what an operator would actually do ──────
  const t0 = Date.now();

  const scratch = mkdtempSync(join(tmpdir(), "linki-restore-drill-"));
  const restored = join(scratch, "linki.db");
  copyFileSync(snapshot, restored);

  const db = new Database(restored, { readonly: true });
  try {
    // 1. structural
    const integrity = db.pragma("integrity_check", { simple: true });
    record("integrity_check", integrity === "ok", String(integrity));

    const fk = db.pragma("foreign_key_check") as unknown[];
    record("foreign_key_check", fk.length === 0, `${fk.length} violations`);

    // 2. the schema /api/health insists on
    const ledger = db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = 'step_side_effects'"
    ).get() as { c: number };
    record("step_side_effects present", ledger.c === 1, ledger.c === 1 ? "present" : "MISSING");

    const tables = db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).get() as { c: number };
    record("tables restored", tables.c > 0, `${tables.c} tables`);

    // 3. the data an operator would check first
    const counts: Record<string, number> = {};
    for (const t of ["accounts", "targets", "workflows", "runs", "run_profile_tracks", "logs"]) {
      try {
        counts[t] = (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
      } catch {
        counts[t] = -1;
      }
    }
    record("key tables readable", Object.values(counts).every(c => c >= 0),
      Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" "));

    // 4. THE POINT OF THE DRILL — does an account actually come back?
    const account = db.prepare(
      "SELECT id, cookies_json FROM accounts WHERE cookies_json IS NOT NULL LIMIT 1"
    ).get() as { id: string; cookies_json: string } | undefined;

    if (!account) {
      record("account session decrypts", false, "no account with cookies_json — drill inconclusive");
    } else {
      // Guard first: decryptSecret passes NON-encrypted values through unchanged,
      // so without this a plaintext row would "decrypt" perfectly and prove
      // nothing about the secret at all.
      const encrypted = isEncrypted(account.cookies_json);
      record("cookies_json is encrypted at rest", encrypted, encrypted ? "v1 envelope" : "PLAINTEXT — drill invalid");

      // POSITIVE: the real secret, from the environment this drill inherits.
      let shape = "";
      let ok = false;
      try {
        const plaintext = decryptSecret(account.cookies_json);
        const parsed = JSON.parse(plaintext ?? "null");
        const cookies: Array<{ name?: string }> = Array.isArray(parsed) ? parsed : parsed?.cookies ?? [];
        const names = cookies.map(c => c.name).filter(Boolean) as string[];
        ok = cookies.length > 0 && names.includes("li_at");
        // NAMES only. The values are the session itself.
        shape = `${cookies.length} cookies; li_at ${names.includes("li_at") ? "present" : "ABSENT"}`;
      } catch (err) {
        shape = `decrypt/parse failed: ${err instanceof Error ? err.constructor.name : "unknown"}`;
      }
      record("account session decrypts (correct secret)", ok, shape);

      // NEGATIVE: the same ciphertext, a different key. This is the documented
      // caveat turned into evidence — a backup without NEXTAUTH_SECRET restores
      // a database nobody can act as.
      const realSecret = process.env.NEXTAUTH_SECRET;
      process.env.NEXTAUTH_SECRET = "definitely-not-the-real-secret-for-the-drill";
      let failedAsExpected = false;
      let how = "";
      try {
        decryptSecret(account.cookies_json);
        how = "DECRYPTED — the secret is not protecting anything";
      } catch (err) {
        failedAsExpected = true;
        how = err instanceof Error ? err.constructor.name : "threw";
      } finally {
        if (realSecret === undefined) delete process.env.NEXTAUTH_SECRET;
        else process.env.NEXTAUTH_SECRET = realSecret;
      }
      record("wrong secret CANNOT decrypt", failedAsExpected, how);
    }
  } finally {
    db.close();
  }

  const rtoMs = Date.now() - t0;
  rmSync(scratch, { recursive: true, force: true });

  const failed = steps.filter(s => !s.ok);
  console.log(`\n  RTO (copy + open + verify + decrypt): ${(rtoMs / 1000).toFixed(2)}s`);
  console.log(`  ${steps.length - failed.length}/${steps.length} checks passed\n`);

  if (failed.length > 0) {
    console.error(`DRILL FAILED: ${failed.map(f => f.name).join(", ")}`);
    process.exit(1);
  }
  console.log("DRILL PASSED\n");
}

main();
