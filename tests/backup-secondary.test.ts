import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * PR-17 (C4) — secondary backups.
 *
 * The off-volume copy was `fs.copyFileSync` straight onto the final name, then
 * `prune`. Two consequences, both silent:
 *
 *  - an interrupted or short copy left a truncated file with a valid-looking
 *    name, indistinguishable from a real snapshot; and
 *  - retention then counted that file as the newest good snapshot and kept it in
 *    preference to a verified one.
 *
 * These tests pin the ordering: partial → verify → promote → prune, and that no
 * failure path can remove the last good secondary.
 */

const backup = await import("@/scripts/backup.mjs");

const root = mkdtempSync(join(tmpdir(), "linki-backup-secondary-"));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function makeSource(rows = 5): string {
  const dir = mkdtempSync(join(root, `src${n++}-`));
  const p = join(dir, "linki.db");
  const db = new Database(p);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY);
    CREATE TABLE targets (id TEXT PRIMARY KEY, account_id TEXT);
  `);
  db.prepare("INSERT INTO accounts (id) VALUES ('a1')").run();
  const ins = db.prepare("INSERT INTO targets (id, account_id) VALUES (?, 'a1')");
  for (let i = 0; i < rows; i++) ins.run(`t${i}`);
  db.close();
  return p;
}

/** A file whose name retention recognises but whose contents are irrelevant. */
function plantOldSecondary(dir: string, stamp = "20200101T000000Z"): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${backup.AUTO_PREFIX}${stamp}.db`);
  writeFileSync(p, "old-but-valid-enough-for-retention");
  return p;
}

const autos = (dir: string) =>
  readdirSync(dir).filter((f) => backup.AUTO_RE.test(f)).sort();

// ─── happy path ──────────────────────────────────────────────────────────────

test("the secondary is verified and promoted, with no .partial left behind", () => {
  const src = makeSource();
  const dest = join(root, "dest-ok");
  const offsite = join(root, "offsite-ok");

  const out = backup.createBackup({ sourcePath: src, destDir: dest, offsiteDir: offsite });

  const copied = join(offsite, out.split("/").pop()!);
  assert.ok(existsSync(copied), "the secondary exists at the final name");
  assert.deepEqual(autos(offsite).length, 1);
  assert.equal(
    readdirSync(offsite).filter((f) => f.endsWith(".partial")).length,
    0,
    "a verified copy is renamed, not left as .partial"
  );

  // And it is a real, usable database — not just a file of the right name.
  const db = new Database(copied, { readonly: true });
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((db.prepare("SELECT COUNT(*) c FROM targets").get() as { c: number }).c, 5);
  db.close();
});

// ─── interrupted copy ────────────────────────────────────────────────────────

test("an interrupted copy never looks like a backup and never prunes the last good one", () => {
  const src = makeSource();
  const dest = join(root, "dest-int");
  const offsite = join(root, "offsite-int");
  const lastGood = plantOldSecondary(offsite);

  assert.throws(
    () =>
      backup.createBackup({
        sourcePath: src,
        destDir: dest,
        offsiteDir: offsite,
        retain: 1, // would delete `lastGood` if prune ran
        copyFile: () => { throw new Error("ENOSPC: no space left on device"); },
      }),
    /offsite copy failed/i
  );

  assert.ok(existsSync(lastGood), "the last good secondary must survive a failed copy");
  assert.deepEqual(autos(offsite), [`${backup.AUTO_PREFIX}20200101T000000Z.db`], "no new snapshot appeared");
  assert.equal(
    readdirSync(offsite).filter((f) => f.endsWith(".partial")).length,
    0,
    "the short copy is removed, not left as a plausible-looking file"
  );
});

// ─── failed verification of the copy ─────────────────────────────────────────

test("a secondary that fails verification is quarantined, not promoted, and not pruned against", () => {
  const src = makeSource();
  const dest = join(root, "dest-verify");
  const offsite = join(root, "offsite-verify");
  const lastGood = plantOldSecondary(offsite);

  // The primary verifies (call 1); the off-volume copy fails (call 2).
  let calls = 0;
  const verify = (p: string, tables: string[]) => {
    calls++;
    if (calls === 2) throw new Error("integrity_check failed: database disk image is malformed");
    return backup.verifySnapshot(p, tables);
  };

  assert.throws(
    () => backup.createBackup({ sourcePath: src, destDir: dest, offsiteDir: offsite, retain: 1, verify }),
    /offsite copy FAILED verification/
  );

  assert.ok(existsSync(lastGood), "retention must not run after a failed secondary");
  assert.deepEqual(autos(offsite), [`${backup.AUTO_PREFIX}20200101T000000Z.db`]);
  const rejected = readdirSync(offsite).filter((f) => f.endsWith(".rejected"));
  assert.equal(rejected.length, 1, "the evidence is kept, as for the primary");
});

// ─── collisions and capacity ─────────────────────────────────────────────────

test("an existing secondary is never overwritten", () => {
  const src = makeSource();
  const dest = join(root, "dest-collide");
  const offsite = join(root, "offsite-collide");
  const when = new Date("2026-03-04T05:06:07.000Z");
  const name = `${backup.AUTO_PREFIX}${backup.stamp(when)}.db`;
  mkdirSync(offsite, { recursive: true });
  const existing = join(offsite, name);
  writeFileSync(existing, "a verified snapshot from an earlier run");

  assert.throws(
    () => backup.createBackup({ sourcePath: src, destDir: dest, offsiteDir: offsite, now: when }),
    /already exists/
  );

  assert.equal(
    readdirSync(offsite).filter((f) => f === name).length,
    1,
    "silently replacing a good off-volume snapshot is unrecoverable"
  );
  assert.equal(autos(offsite).length, 1);
});

test("an off-volume capacity failure is reported before anything is written", () => {
  const src = makeSource();
  const dest = join(root, "dest-space");
  const offsite = join(root, "offsite-space");
  const lastGood = plantOldSecondary(offsite);

  // Plenty at the primary, nothing at the secondary.
  const statfs = (dir: string) =>
    dir === offsite
      ? { bavail: 0, bsize: 4096 }
      : { bavail: 1_000_000, bsize: 4096 };

  assert.throws(
    () => backup.createBackup({ sourcePath: src, destDir: dest, offsiteDir: offsite, retain: 1, statfs }),
    /insufficient free space/
  );

  assert.ok(existsSync(lastGood));
  assert.deepEqual(autos(offsite), [`${backup.AUTO_PREFIX}20200101T000000Z.db`]);
});

// ─── retention on the secondary ──────────────────────────────────────────────

test("retention on the secondary keeps the newest and is applied only after verification", () => {
  const src = makeSource();
  const dest = join(root, "dest-retain");
  const offsite = join(root, "offsite-retain");
  plantOldSecondary(offsite, "20200101T000000Z");
  plantOldSecondary(offsite, "20200102T000000Z");

  backup.createBackup({ sourcePath: src, destDir: dest, offsiteDir: offsite, retain: 2 });

  const kept = autos(offsite);
  assert.equal(kept.length, 2, "retain=2 keeps two secondaries");
  assert.ok(!kept.includes(`${backup.AUTO_PREFIX}20200101T000000Z.db`), "the oldest was pruned");
  assert.ok(kept.includes(`${backup.AUTO_PREFIX}20200102T000000Z.db`), "the newer pre-existing one survived");
});
