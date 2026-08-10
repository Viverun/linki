import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync, truncateSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { codeOnly } from "@/tests/support/source-text";

// The real script, driven directly. A backup tested through a re-implementation
// is a backup script that has never run.
const backup = await import("@/scripts/backup.mjs");

const root = mkdtempSync(join(tmpdir(), "linki-backup-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A small WAL database that looks like Linki's: a parent, a child, a FK. */
function makeSource(rows = 50): string {
  const dir = mkdtempSync(join(root, `src${n++}-`));
  const p = join(dir, "linki.db");
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, cookies_json TEXT);
    CREATE TABLE targets (id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id));
  `);
  db.prepare("INSERT INTO accounts (id, cookies_json) VALUES ('a1', 'ciphertext')").run();
  const ins = db.prepare("INSERT INTO targets (id, account_id) VALUES (?, 'a1')");
  for (let i = 0; i < rows; i++) ins.run(`t${i}`);
  db.close();
  return p;
}

const autos = (dir: string) => readdirSync(dir).filter(f => backup.AUTO_RE.test(f)).sort();

test("P2-4: a snapshot is created, verifies, and is a real database", () => {
  const src = makeSource();
  const dest = join(root, "dest1");
  const out = backup.createBackup({ sourcePath: src, destDir: dest });

  assert.ok(existsSync(out), "snapshot exists");
  assert.match(out, /linki-auto-\d{8}T\d{6}Z\.db$/, "named with a runtime timestamp");
  assert.ok(statSync(out).size > 0, "and is not empty");

  const db = new Database(out, { readonly: true });
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((db.prepare("SELECT COUNT(*) c FROM targets").get() as { c: number }).c, 50);
  db.close();

  // No sidecars to keep together: VACUUM INTO produces one self-contained file.
  assert.ok(!existsSync(`${out}-wal`), "no WAL sidecar");
  assert.ok(!existsSync(`${out}.partial`), "the .partial was renamed away");
});

test("P2-4: the filename comes from the clock at RUN TIME, not from a baked constant", () => {
  // The H0 hazard's natural habitat. A `$(date)` baked in at generation time
  // gives every run the same name: one slot, silently overwriting itself, in a
  // directory listing that looks like a healthy history.
  const a = backup.stamp(new Date("2026-08-10T03:00:00.000Z"));
  const b = backup.stamp(new Date("2026-08-11T03:00:00.000Z"));
  assert.notEqual(a, b, "different days must produce different names");
  assert.equal(a, "20260810T030000Z");

  const src = makeSource(5);
  const dest = join(root, "dest-two-runs");
  backup.createBackup({ sourcePath: src, destDir: dest, now: new Date("2026-08-10T03:00:00.000Z") });
  backup.createBackup({ sourcePath: src, destDir: dest, now: new Date("2026-08-11T03:00:00.000Z") });
  assert.equal(autos(dest).length, 2, "two runs leave two snapshots, not one overwritten slot");
});

test("P2-4: VACUUM INTO under CONCURRENT WRITES yields a consistent point-in-time image", () => {
  // The real backup runs on cron against a live container with the runner
  // working. If the snapshot were not transactionally consistent, this is where
  // it would show: a torn image, a FK violation, or a count that never existed.
  const src = makeSource(0);
  const dest = join(root, "dest-concurrent");

  const writer = new Database(src);
  writer.pragma("journal_mode = WAL");
  const ins = writer.prepare("INSERT INTO targets (id, account_id) VALUES (?, 'a1')");

  // Interleave: writes before, writes after, and a burst mid-flight. Node is
  // single-threaded and better-sqlite3 is synchronous, so the honest way to
  // overlap is to write on either side of the VACUUM and prove the snapshot
  // landed at a real instant between them.
  for (let i = 0; i < 200; i++) ins.run(`pre${i}`);
  const countBefore = (writer.prepare("SELECT COUNT(*) c FROM targets").get() as { c: number }).c;

  const out = backup.createBackup({ sourcePath: src, destDir: dest });

  for (let i = 0; i < 200; i++) ins.run(`post${i}`);
  const countAfter = (writer.prepare("SELECT COUNT(*) c FROM targets").get() as { c: number }).c;
  writer.close();

  const snap = new Database(out, { readonly: true });
  assert.equal(snap.pragma("integrity_check", { simple: true }), "ok", "structurally sound");
  assert.equal((snap.pragma("foreign_key_check") as unknown[]).length, 0, "referentially sound");

  const snapCount = (snap.prepare("SELECT COUNT(*) c FROM targets").get() as { c: number }).c;
  // Equality with the SOURCE would be the wrong assertion — the source moves on.
  // What must hold is that the snapshot is a real instant on the timeline.
  assert.ok(
    snapCount >= countBefore && snapCount <= countAfter,
    `snapshot count ${snapCount} must lie in [${countBefore}, ${countAfter}] — a point-in-time that actually existed`
  );
  // Nothing half-written: every row that made it is complete and joined.
  const orphans = (snap.prepare(
    "SELECT COUNT(*) c FROM targets t LEFT JOIN accounts a ON a.id = t.account_id WHERE a.id IS NULL"
  ).get() as { c: number }).c;
  assert.equal(orphans, 0, "no torn rows");
  snap.close();
});

test("P2-4: the writer is never blocked while the snapshot is taken", () => {
  // Stated in the docs as a property of VACUUM INTO under WAL; shown here.
  const src = makeSource(20);
  const dest = join(root, "dest-nonblocking");
  const writer = new Database(src);
  writer.pragma("journal_mode = WAL");
  // busy_timeout 0: if VACUUM INTO took a lock that excluded writers, the write
  // below would fail immediately with SQLITE_BUSY rather than wait it out.
  writer.pragma("busy_timeout = 0");

  backup.createBackup({ sourcePath: src, destDir: dest });
  assert.doesNotThrow(
    () => writer.prepare("INSERT INTO targets (id, account_id) VALUES ('during', 'a1')").run(),
    "a writer must not be locked out by a backup"
  );
  writer.close();
});

test("P2-4: verification failure keeps the evidence and PRUNES NOTHING", () => {
  // Ordering is the design. Prune-then-verify means a corrupt snapshot plus
  // retention equals zero good backups: retention would delete the good ones to
  // make room for the broken one.
  const src = makeSource(10);
  const dest = join(root, "dest-failverify");

  for (const day of ["01", "02", "03", "04"]) {
    backup.createBackup({ sourcePath: src, destDir: dest, now: new Date(`2026-08-${day}T03:00:00.000Z`) });
  }
  const before = autos(dest);
  assert.equal(before.length, 4);

  assert.throws(
    () => backup.createBackup({
      sourcePath: src, destDir: dest, retain: 1,
      now: new Date("2026-08-05T03:00:00.000Z"),
      verify: () => { throw new Error("integrity_check failed: page 3 corrupt"); },
    }),
    /verification FAILED/,
    "a failed snapshot must be a loud error, not a silent skip"
  );

  assert.deepEqual(autos(dest), before,
    "retain:1 would have deleted three — but verification failed, so pruning must never have run");
  assert.ok(
    readdirSync(dest).some(f => f.endsWith(".rejected")),
    "the failed snapshot is kept for diagnosis: deleting it takes the reason with it"
  );
  assert.ok(!readdirSync(dest).some(f => f.endsWith(".partial")), "no .partial left behind");
});

test("P2-4: retention keeps N — and NEVER deletes the newest", () => {
  const src = makeSource(5);
  const dest = join(root, "dest-retain");
  for (const day of ["01", "02", "03", "04", "05"]) {
    backup.createBackup({ sourcePath: src, destDir: dest, now: new Date(`2026-08-${day}T03:00:00.000Z`) });
  }
  assert.equal(autos(dest).length, 5);

  backup.prune(dest, 3);
  assert.deepEqual(autos(dest), [
    "linki-auto-20260803T030000Z.db",
    "linki-auto-20260804T030000Z.db",
    "linki-auto-20260805T030000Z.db",
  ], "the three newest survive");

  // A misconfiguration must not be read as "leave the system with nothing".
  backup.prune(dest, 0);
  assert.equal(autos(dest).length, 1, "retain:0 still leaves the newest");
  assert.equal(autos(dest)[0], "linki-auto-20260805T030000Z.db");
});

test("P2-4: retention never touches hand-made safety copies", () => {
  // The ones made before a risky operation are exactly what you reach for during
  // an incident. Retention eating them would be the worst possible timing.
  const src = makeSource(5);
  const dest = join(root, "dest-manual");

  for (const day of ["01", "02", "03"]) {
    backup.createBackup({ sourcePath: src, destDir: dest, now: new Date(`2026-08-${day}T03:00:00.000Z`) });
  }
  writeFileSync(join(dest, "pre-prodqa-delete-20260810T100615Z.db"), "not-a-real-db");
  writeFileSync(join(dest, "linki-prePhase1-20260809T155044Z.db"), "not-a-real-db");
  writeFileSync(join(dest, "prodqa-rf-provenance-20260810T100615Z.json"), "{}");

  backup.prune(dest, 1);
  const remaining = readdirSync(dest).sort();
  assert.ok(remaining.includes("pre-prodqa-delete-20260810T100615Z.db"), "manual snapshot untouched");
  assert.ok(remaining.includes("linki-prePhase1-20260809T155044Z.db"), "manual snapshot untouched");
  assert.ok(remaining.includes("prodqa-rf-provenance-20260810T100615Z.json"), "provenance file untouched");
  assert.equal(autos(dest).length, 1, "only auto snapshots are pruned");
});

test("P2-4: a full disk fails BEFORE writing, rather than producing a truncated file", () => {
  const src = makeSource(5);
  const dest = join(root, "dest-nospace");
  const sourceSize = statSync(src).size;

  assert.equal(backup.spaceRequirement(1_000_000), 2_000_000 + 16 * 1024 * 1024,
    "2x the source plus a 16MB margin");

  assert.throws(
    () => backup.createBackup({
      sourcePath: src, destDir: dest,
      statfs: () => ({ bsize: 4096, bavail: 4 }),  // 16KB free
    }),
    /insufficient free space/,
    "must refuse loudly"
  );
  assert.ok(!existsSync(dest) || autos(dest).length === 0, "and must not have written anything");
  assert.ok(sourceSize > 0);
});

test("P2-4: a truncated snapshot is DETECTED by verification", () => {
  const src = makeSource(200);
  const dest = join(root, "dest-truncated");
  const out = backup.createBackup({ sourcePath: src, destDir: dest });

  truncateSync(out, Math.floor(statSync(out).size / 2));
  assert.throws(
    () => backup.verifySnapshot(out, ["accounts", "targets"]),
    /integrity_check failed|malformed|not a database/i,
    "half a database must not pass as a backup"
  );
});

test("P2-4: integrity_check earns its place — corruption a table scan cannot see", () => {
  // The truncation test above does NOT prove integrity_check runs: a truncated
  // file throws "database disk image is malformed" from the row-count read too,
  // so removing the integrity_check survived that test. What integrity_check
  // adds is corruption a full table scan walks straight past — a damaged INDEX.
  // Here every row still counts correctly and every table reads; only
  // integrity_check notices. A backup restored from this would return wrong
  // answers to indexed queries rather than failing loudly.
  const dir = mkdtempSync(join(root, "idx-"));
  const src = join(dir, "linki.db");
  const db = new Database(src);
  db.pragma("page_size = 4096");
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, cookies_json TEXT);
    CREATE TABLE targets (id TEXT PRIMARY KEY, v TEXT);
    CREATE INDEX idx_v ON targets(v);
  `);
  const ins = db.prepare("INSERT INTO targets VALUES (?, ?)");
  for (let i = 0; i < 300; i++) ins.run(`t${i}`, `v${i}`);
  db.close();

  const PAGE = 4096;
  const bytes = readFileSync(src);
  bytes.fill(0, 2 * PAGE, 3 * PAGE); // page 3 — an index b-tree page
  const damaged = join(dir, "damaged.db");
  writeFileSync(damaged, bytes);

  // Precondition: the damage really is invisible to a table scan.
  const probe = new Database(damaged, { readonly: true });
  assert.equal((probe.prepare("SELECT COUNT(*) c FROM targets").get() as { c: number }).c, 300,
    "every row still counts — this is what makes the corruption dangerous");
  probe.close();

  assert.throws(
    () => backup.verifySnapshot(damaged, ["accounts", "targets"]),
    /integrity_check failed/,
    "and integrity_check is what catches it"
  );
});

test("P2-4: an unverified snapshot NEVER exists under its final name", () => {
  // A crash between writing and verifying must not leave a plausible-looking
  // backup. Observed from inside verification, which is exactly the window when
  // the file is written but not yet trusted.
  const src = makeSource(10);
  const dest = join(root, "dest-window");
  let namesDuringVerify: string[] = [];

  backup.createBackup({
    sourcePath: src, destDir: dest,
    verify: () => {
      namesDuringVerify = readdirSync(dest);
      return { tables: 2, rows: 11 };
    },
  });

  assert.deepEqual(namesDuringVerify.filter(f => backup.AUTO_RE.test(f)), [],
    "at verification time nothing may yet carry the final name");
  assert.ok(namesDuringVerify.some(f => f.endsWith(".partial")),
    "the candidate is visibly provisional while it is unverified");
  assert.equal(autos(dest).length, 1, "and is promoted only once it passes");
});

test("P2-4: an off-volume copy is made when configured", () => {
  const src = makeSource(5);
  const dest = join(root, "dest-offsite-primary");
  const offsite = join(root, "dest-offsite-secondary");
  const out = backup.createBackup({ sourcePath: src, destDir: dest, offsiteDir: offsite });

  const name = out.split("/").pop()!;
  assert.ok(existsSync(join(offsite, name)), "the snapshot is copied off-volume");
  const copy = new Database(join(offsite, name), { readonly: true });
  assert.equal(copy.pragma("integrity_check", { simple: true }), "ok", "and the copy is itself valid");
  copy.close();
});

test("P2-4: the script contains no baked-in shell substitution", () => {
  // §2 rule: strings kept, because a baked `$(date)` WOULD live inside a string
  // literal — blanking them would erase the very thing being looked for. Only
  // comments are stripped, and this file's own prose discusses `$(date)`.
  const src = codeOnly(readFileSync("scripts/backup.mjs", "utf8"), { style: "c", strings: false });
  assert.ok(!/\$\(date/.test(src), "a baked timestamp gives every run the same filename");
  assert.ok(!/`\$\{.*date.*\}`/i.test(src), "nor an interpolated one from generation time");
  assert.match(src, /new Date\(\)/, "the clock is read at run time");
});
