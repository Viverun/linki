import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "linki-pr13-migration-"));
const previousPath = process.env.LINKI_DB_PATH;
process.env.LINKI_DB_PATH = join(dir, "legacy.db");
const seed = new Database(process.env.LINKI_DB_PATH);
seed.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL)");
seed.prepare("INSERT INTO users VALUES (?, ?, ?)").run("legacy-owner", "owner@example.invalid", "synthetic-hash");
seed.close();
const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { namedExports: Record<string, unknown> }) => void;
let scheduled = 0;
mockModule("@/lib/update-check", { namedExports: { scheduleUpdateCheck() { scheduled++; } } });
const { getDb } = await import("@/lib/db");
let connection: Database.Database | undefined;
after(() => {
  connection?.close();
  mock.restoreAll();
  rmSync(dir, { recursive: true, force: true });
  if (previousPath === undefined) delete process.env.LINKI_DB_PATH;
  else process.env.LINKI_DB_PATH = previousPath;
});

test("PR13: legacy version migration fails visibly, publishes no handle, then safely retries", async () => {
  const exec = Database.prototype.exec;
  const injected = mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
    if (sql.includes("ALTER TABLE users ADD COLUMN session_version")) throw new Error("synthetic version migration failure");
    return exec.call(this, sql);
  });
  try {
    assert.throws(() => getDb(), /synthetic version migration failure/);
    assert.equal(scheduled, 0);
  } finally {
    injected.mock.restore();
  }
  connection = getDb();
  assert.equal(scheduled, 1);
  assert.deepEqual(connection.prepare("SELECT * FROM users").get(), {
    id: "legacy-owner", email: "owner@example.invalid", password_hash: "synthetic-hash", session_version: 0,
  });
  connection.prepare("UPDATE users SET session_version = 3 WHERE id = ?").run("legacy-owner");
  assert.equal(getDb(), connection);
  assert.deepEqual(getDb().prepare("SELECT session_version FROM users").get(), { session_version: 3 });
  connection.close();
  connection = undefined;
  const restarted = await import(new URL("../lib/db.ts?pr13-restart", import.meta.url).href);
  connection = restarted.getDb() as Database.Database;
  assert.equal(scheduled, 2);
  assert.deepEqual(connection.prepare("SELECT session_version FROM users").get(), { session_version: 3 });
});
