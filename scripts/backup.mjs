#!/usr/bin/env node
/**
 * Snapshot the Linki database, verify the snapshot, then prune old ones.
 *
 * Run from cron on the host:
 *   0 3 * * *  cd /path/to/linki && node scripts/backup.mjs >> data/backups/backup.log 2>&1
 *
 * Environment:
 *   LINKI_DB_PATH        source database        (default ./data/linki.db)
 *   BACKUP_DIR           where snapshots go     (default <db dir>/backups)
 *   BACKUP_OFFSITE_DIR   second copy, optional  (see "off-volume" in docs/backup-restore.md)
 *   BACKUP_RETAIN        how many to keep       (default 7)
 *
 * ── ORDER IS THE DESIGN ──────────────────────────────────────────────────────
 *
 *   check space -> VACUUM INTO a .partial -> OPEN AND VERIFY it -> rename -> prune
 *
 * Every arrow is load-bearing:
 *
 *   - Space is checked BEFORE writing, because the failure mode of a full disk
 *     is a truncated file that looks like a backup in a directory listing.
 *   - The snapshot is written to `.partial` and renamed only after it verifies,
 *     so an interrupted run leaves something obviously-not-a-backup rather than
 *     a plausible-looking corpse.
 *   - Pruning happens LAST. Prune-then-verify means a failed verification plus
 *     retention equals zero good backups — retention would delete the good ones
 *     to make room for a broken one.
 *   - The newest snapshot is never deleted, whatever the retention arithmetic
 *     says. `BACKUP_RETAIN=0` is a configuration mistake, not an instruction to
 *     leave the system with nothing.
 *
 * ── VACUUM INTO, and why not `cp` ────────────────────────────────────────────
 *
 * The database runs in WAL mode with a multi-megabyte WAL. `cp linki.db` copies
 * the main file WITHOUT the WAL, which loses every committed transaction still
 * sitting in it — the copy is silently stale, and looks fine.
 *
 * `VACUUM INTO` runs inside a read transaction: it captures a consistent
 * point-in-time image including WAL content, does not block writers, and
 * produces a defragmented single file with no sidecars to keep together.
 *
 * ── I9 ───────────────────────────────────────────────────────────────────────
 *
 * This script logs paths, byte counts and row counts. Never a column value.
 * `accounts.cookies_json` passes through VACUUM INTO without ever being read
 * into this process, and it must stay that way.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

/** Snapshots this script manages. Anything else in the directory is left alone:
 *  the hand-made `pre-<something>-<stamp>.db` safety copies made before risky
 *  operations are exactly what you want during an incident, and retention must
 *  never eat them. */
const AUTO_PREFIX = "linki-auto-";
const AUTO_RE = /^linki-auto-\d{8}T\d{6}Z\.db$/;

/**
 * Timestamp computed AT RUN TIME.
 *
 * Writing this as a shell `$(date …)` baked into a generated file is the H0
 * hazard, and here it degrades in a particularly nasty way: every run would
 * write the same filename, so the backup system would have exactly one slot
 * that silently overwrites itself, while the directory listing — full of
 * earlier, differently-named files — looks like a healthy history.
 */
function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function log(...args) {
  console.log(`[backup ${new Date().toISOString()}]`, ...args);
}

/**
 * Refuses to start unless there is comfortably more free space than the source
 * database occupies.
 *
 * 2x plus 16MB: VACUUM INTO writes a full copy, and the margin covers the WAL
 * plus the filesystem's own overhead. Erring high is cheap; erring low produces
 * the truncated file this exists to prevent.
 */
function spaceRequirement(sourceSize) {
  return sourceSize * 2 + 16 * 1024 * 1024;
}

/**
 * `statfs` is injectable ONLY so the exhausted-disk path can be exercised. The
 * production call passes nothing and uses the real syscall. A seam is warranted
 * here because the alternative is filling a 908GB volume to test the check, i.e.
 * not testing it — and an untested guard against a rare failure is indistinguishable
 * from no guard on the night it matters.
 */
function assertFreeSpace(sourcePath, destDir, statfs = fs.statfsSync) {
  const needed = spaceRequirement(fs.statSync(sourcePath).size);
  const stats = statfs(destDir);
  const free = stats.bavail * stats.bsize;
  if (free < needed) {
    throw new Error(
      `insufficient free space at ${destDir}: need ~${Math.ceil(needed / 1e6)}MB, have ${Math.floor(free / 1e6)}MB`
    );
  }
  return { needed, free };
}

/**
 * Opens a finished snapshot and proves it is usable.
 *
 * `integrity_check` alone is not enough — it validates b-tree structure, not
 * that the file contains the database you meant. The table-name comparison
 * catches a snapshot taken against the wrong source or an incomplete schema.
 *
 * Row counts are deliberately NOT compared for equality with the source. Under
 * concurrent writes the source moves on while the snapshot holds a consistent
 * earlier instant, so equality would fail for a perfectly good backup. What is
 * asserted is that the snapshot is internally consistent and complete; the
 * point-in-time property is verified by test, where the writer's behaviour is
 * known.
 */
function verifySnapshot(snapshotPath, expectedTables) {
  const db = new Database(snapshotPath, { readonly: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`integrity_check failed: ${integrity}`);

    const fk = db.pragma("foreign_key_check");
    if (fk.length > 0) throw new Error(`foreign_key_check reported ${fk.length} violations`);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map(r => r.name);

    const missing = expectedTables.filter(t => !tables.includes(t));
    if (missing.length > 0) throw new Error(`snapshot is missing tables: ${missing.join(", ")}`);

    // Prove every table is actually readable, not merely present. A structurally
    // valid file can still fail here if a page is unreadable.
    let rows = 0;
    for (const t of tables) {
      rows += db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    }
    return { tables: tables.length, rows };
  } finally {
    db.close();
  }
}

/** Existing auto-snapshots, newest first. The timestamp format sorts lexicographically. */
function listSnapshots(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => AUTO_RE.test(f)).sort().reverse();
}

/**
 * Deletes the oldest auto-snapshots beyond `retain`.
 *
 * Only ever called after a successful verification, and never deletes index 0.
 */
function prune(dir, retain) {
  const snapshots = listSnapshots(dir);
  const keep = Math.max(1, retain); // never zero — see the header
  const doomed = snapshots.slice(keep);
  for (const f of doomed) {
    fs.unlinkSync(path.join(dir, f));
    log(`pruned ${f}`);
  }
  return doomed;
}

/**
 * The whole operation. Returns the finished snapshot's path.
 *
 * Exported so tests drive the real thing rather than a re-implementation — a
 * backup script tested by proxy is a backup script that has never run.
 */
function createBackup(opts = {}) {
  const sourcePath = opts.sourcePath ?? process.env.LINKI_DB_PATH ?? path.join("data", "linki.db");
  const destDir = opts.destDir ?? process.env.BACKUP_DIR ?? path.join(path.dirname(sourcePath), "backups");
  const retain = Number(opts.retain ?? process.env.BACKUP_RETAIN ?? 7);
  const offsiteDir = opts.offsiteDir ?? process.env.BACKUP_OFFSITE_DIR ?? null;
  const now = opts.now ?? new Date();

  if (!fs.existsSync(sourcePath)) throw new Error(`source database not found: ${sourcePath}`);
  fs.mkdirSync(destDir, { recursive: true });

  const space = assertFreeSpace(sourcePath, destDir, opts.statfs);
  log(`source ${sourcePath} (${fs.statSync(sourcePath).size} B), free ${Math.floor(space.free / 1e6)}MB`);

  const finalName = `${AUTO_PREFIX}${stamp(now)}.db`;
  const finalPath = path.join(destDir, finalName);
  const partialPath = `${finalPath}.partial`;
  if (fs.existsSync(finalPath)) throw new Error(`snapshot already exists: ${finalPath}`);
  fs.rmSync(partialPath, { force: true });

  // Read the source's table list before snapshotting, to verify against.
  const source = new Database(sourcePath, { readonly: true });
  let expectedTables;
  try {
    expectedTables = source
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map(r => r.name);
    // Bound parameters are not allowed in VACUUM INTO, so the path is escaped by
    // doubling single quotes. destDir comes from config, not from user input.
    source.exec(`VACUUM INTO '${partialPath.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }

  // Injectable ONLY to exercise the rejection path: a snapshot that fails
  // verification cannot be produced on demand by a working VACUUM INTO, and the
  // ordering guarantee (verify BEFORE prune) is the whole point of this script.
  const verify = opts.verify ?? verifySnapshot;
  let verified;
  try {
    verified = verify(partialPath, expectedTables);
  } catch (err) {
    // Keep the evidence. A failed snapshot that is deleted takes the reason for
    // its failure with it, and the next run will most likely fail the same way.
    const rejected = `${finalPath}.rejected`;
    fs.renameSync(partialPath, rejected);
    throw new Error(`snapshot verification FAILED (kept at ${rejected}): ${err.message}`);
  }

  fs.renameSync(partialPath, finalPath);
  log(`created ${finalName} (${fs.statSync(finalPath).size} B, ${verified.tables} tables, ${verified.rows} rows)`);

  // Only now. See the header.
  prune(destDir, retain);

  if (offsiteDir) {
    fs.mkdirSync(offsiteDir, { recursive: true });
    const offsitePath = path.join(offsiteDir, finalName);
    fs.copyFileSync(finalPath, offsitePath);
    log(`copied to ${offsitePath}`);
  }

  return finalPath;
}

export {
  createBackup, verifySnapshot, prune, listSnapshots, stamp,
  assertFreeSpace, spaceRequirement, AUTO_PREFIX, AUTO_RE,
};

// ESM rather than CommonJS purely because the repo's lint config forbids
// `require()`. `.mjs` because package.json declares no "type", so a `.js` file
// is CommonJS and `import` there is a syntax error.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    createBackup();
    log("OK");
  } catch (err) {
    // Loud and non-zero: cron mail and the exit code are the only channels a
    // 3am backup failure has.
    console.error(`[backup] FAILED: ${err.message}`);
    process.exit(1);
  }
}
