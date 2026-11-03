/**
 * Restore rehearsal with separately escrowed synthetic key material.
 *
 * This is the operational half of PR-17: the backup tests prove a snapshot is
 * verifiable, and `scripts/restore-drill.ts` proves a snapshot is restorable
 * *given the secret*. Neither proves the thing that actually fails in practice —
 * restoring a database and the key that makes its ciphertext useful from two
 * different places.
 *
 * So this script builds a synthetic installation, backs it up through the real
 * `createBackup` (primary AND secondary, the code path that ships), writes the
 * synthetic NEXTAUTH_SECRET to a location that is deliberately not the backup
 * directory, deletes the primary copy to simulate losing that location, and
 * restores from the secondary in a clean process with the secret supplied by the
 * escrow file alone.
 *
 * What it demonstrates: the pair (database, key) can be recombined from two
 * separate locations using only what an operator would have.
 *
 * What it does NOT demonstrate, and must not be recorded as demonstrating:
 *   - an independent failure domain. Both directories are on this host; a host
 *     or volume loss still takes everything.
 *   - a production RPO/RTO. The measured time is copy+open+verify+decrypt for
 *     THIS synthetic database size, not for the real one.
 *
 * Run:
 *   node --experimental-strip-types --import ./scripts/test-setup.mjs \
 *        scripts/restore-rehearsal.mjs [--tamper]
 *
 * `--tamper` corrupts the escrowed secret before the drill runs. It exists so a
 * test can prove the rehearsal can FAIL — a recovery test that passes with the
 * wrong key would be measuring nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { createBackup, AUTO_RE } from "./backup.mjs";
import { encryptSecret } from "@/lib/crypto";

const TAMPER = process.argv.includes("--tamper");
const REPO = dirname(new URL(import.meta.url).pathname) + "/..";

const root = mkdtempSync(join(tmpdir(), "linki-restore-rehearsal-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const primaryDir = join(root, "primary");
const secondaryDir = join(root, "secondary");
const escrowDir = join(root, "escrow"); // deliberately NOT under either backup dir
mkdirSync(primaryDir, { recursive: true });
mkdirSync(secondaryDir, { recursive: true });
mkdirSync(escrowDir, { recursive: true });

// ── synthetic installation ───────────────────────────────────────────────────
const secret = randomBytes(32).toString("hex");
process.env.NEXTAUTH_SECRET = secret;

const sourcePath = join(root, "source.db");
const db = new Database(sourcePath);
db.exec(`
  CREATE TABLE accounts (id TEXT PRIMARY KEY, cookies_json TEXT);
  CREATE TABLE targets (id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id));
  CREATE TABLE workflows (id TEXT PRIMARY KEY);
  CREATE TABLE runs (id TEXT PRIMARY KEY);
  CREATE TABLE run_profile_tracks (id TEXT PRIMARY KEY);
  CREATE TABLE logs (id TEXT PRIMARY KEY);
  CREATE TABLE step_side_effects (id TEXT PRIMARY KEY, run_profile_id TEXT, target_id TEXT);
`);
// A real envelope, produced by the shipping code, so the drill's decrypt step is
// the real one. `li_at` is what the drill looks for: without it an account
// cannot act.
const cookies = encryptSecret(JSON.stringify([
  { name: "li_at", value: "synthetic-session-value-not-a-real-token" },
  { name: "JSESSIONID", value: "ajax:1234567890" },
]));
db.prepare("INSERT INTO accounts (id, cookies_json) VALUES (?, ?)").run("acc-1", cookies);
db.prepare("INSERT INTO targets (id, account_id) VALUES ('t1', 'acc-1')").run();
db.close();

// ── back up through the shipping code, including the secondary ───────────────
const primarySnapshot = createBackup({ sourcePath, destDir: primaryDir, offsiteDir: secondaryDir, retain: 2 });
const secondaries = readdirSync(secondaryDir).filter((f) => AUTO_RE.test(f)).sort();
if (secondaries.length !== 1) throw new Error(`expected one secondary, found ${secondaries.length}`);
const secondarySnapshot = join(secondaryDir, secondaries[0]);

const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
if (digest(primarySnapshot) !== digest(secondarySnapshot)) {
  throw new Error("secondary differs from the primary it was copied from");
}

// ── escrow the key where a backup is not ─────────────────────────────────────
const escrowFile = join(escrowDir, "NEXTAUTH_SECRET");
writeFileSync(escrowFile, `${secret}\n`, { mode: 0o400 });

if (TAMPER) {
  // The escrow file is 0400 — owner may read, nobody may write, which is the
  // point of an escrow copy. Tampering therefore has to reopen it explicitly,
  // and puts the mode back afterwards so the drill still sees the real thing.
  chmodSync(escrowFile, 0o600);
  writeFileSync(escrowFile, `${randomBytes(32).toString("hex")}\n`);
  chmodSync(escrowFile, 0o400);
}

// ── lose the primary location, restore from the secondary ────────────────────
rmSync(primaryDir, { recursive: true, force: true });

const restoredSecret = readFileSync(escrowFile, "utf8").trim();
const started = Date.now();
const drill = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--disable-warning=ExperimentalWarning",
    "--import", join(REPO, "scripts", "test-setup.mjs"),
    join(REPO, "scripts", "restore-drill.ts"),
    secondarySnapshot,
  ],
  {
    cwd: REPO,
    encoding: "utf8",
    // A clean environment: the secret comes from escrow, not from a shell that
    // happens to export it. No runner markers, so the bootstrap leaves it alone.
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, NEXTAUTH_SECRET: restoredSecret },
  }
);
const elapsed = Date.now() - started;

const output = `${drill.stdout ?? ""}${drill.stderr ?? ""}`;
process.stdout.write(output);

const passed =
  drill.status === 0 &&
  /DRILL PASSED/.test(output) &&
  /PASS\s+account session decrypts \(correct secret\)/.test(output);

console.log(`REHEARSAL ${JSON.stringify({
  result: passed ? "PASSED" : "FAILED",
  tampered: TAMPER,
  secondaryBytes: readFileSync(secondarySnapshot).length,
  drillMs: elapsed,
  escrowSeparateFromBackups: !escrowDir.startsWith(primaryDir) && !escrowDir.startsWith(secondaryDir),
})}`);

if (!passed) process.exit(1);
