import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-local-day-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-local-day-tests";

const { localDayWindow, localDayKey, safeTimeZone, zonedDateTimeToUtc } = await import("@/lib/local-day");
const { countLinkedInActionsSentToday, countEmailsSentToday } = await import("@/lib/linkedin/runner");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

const at = (iso: string) => new Date(iso);
const hours = (w: { start: Date; end: Date }) => (w.end.getTime() - w.start.getTime()) / 3_600_000;

// ─── the window itself ───────────────────────────────────────────────────────

test("UTC day is a plain midnight-to-midnight 24-hour window", () => {
  const w = localDayWindow("UTC", at("2026-10-30T03:00:00Z"));
  assert.equal(w.key, "2026-10-30");
  assert.equal(w.start.toISOString(), "2026-10-30T00:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-10-31T00:00:00.000Z");
  assert.equal(hours(w), 24);
});

test("a positive-offset zone starts the day before UTC midnight", () => {
  // Berlin is UTC+2 in summer, so local midnight is 22:00Z the previous day.
  const w = localDayWindow("Europe/Berlin", at("2026-10-25T12:00:00Z"));
  assert.equal(w.key, "2026-10-25");
  assert.equal(w.start.toISOString(), "2026-10-24T22:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-10-25T23:00:00.000Z");
});

test("a negative-offset zone ends the day after UTC midnight", () => {
  // 03:00Z on 30 Oct is still 23:00 on 29 Oct in New York (EDT, UTC-4).
  const w = localDayWindow("America/New_York", at("2026-10-30T03:00:00Z"));
  assert.equal(w.key, "2026-10-29");
  assert.equal(w.start.toISOString(), "2026-10-29T04:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-10-30T04:00:00.000Z");
  assert.equal(hours(w), 24);
});

test("the spring DST day is 23 hours long, not 24", () => {
  // Europe/Berlin forwards 02:00 -> 03:00 on 2026-03-29.
  const w = localDayWindow("Europe/Berlin", at("2026-03-29T12:00:00Z"));
  assert.equal(w.key, "2026-03-29");
  assert.equal(hours(w), 23);
  assert.equal(w.start.toISOString(), "2026-03-28T23:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-03-29T22:00:00.000Z");
});

test("the autumn DST day is 25 hours long, not 24", () => {
  // Europe/Berlin falls back 03:00 -> 02:00 on 2026-10-25.
  const w = localDayWindow("Europe/Berlin", at("2026-10-25T12:00:00Z"));
  assert.equal(w.key, "2026-10-25");
  assert.equal(hours(w), 25);
  assert.equal(w.start.toISOString(), "2026-10-24T22:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-10-25T23:00:00.000Z");
});

test("the key is zero-padded and rolls over month and year boundaries", () => {
  assert.equal(localDayKey("UTC", at("2026-01-05T12:00:00Z")), "2026-01-05");
  const ny = localDayWindow("America/New_York", at("2027-01-01T02:00:00Z"));
  assert.equal(ny.key, "2026-12-31");
  assert.equal(ny.end.toISOString(), "2027-01-01T05:00:00.000Z");
});

test("an invalid or missing timezone falls back to UTC instead of throwing", () => {
  assert.equal(safeTimeZone("Nonsense/Zone"), "UTC");
  assert.equal(safeTimeZone(""), "UTC");
  assert.equal(safeTimeZone(null), "UTC");
  assert.equal(safeTimeZone(undefined), "UTC");
  assert.equal(safeTimeZone("Europe/Berlin"), "Europe/Berlin");
  const w = localDayWindow("Nonsense/Zone", at("2026-10-30T03:00:00Z"));
  assert.equal(w.key, "2026-10-30");
  assert.equal(w.start.toISOString(), "2026-10-30T00:00:00.000Z");
});

test("zonedDateTimeToUtc resolves non-hour offsets", () => {
  // Kathmandu is UTC+05:45 year-round.
  const d = zonedDateTimeToUtc(2026, 10, 30, 9, 0, "Asia/Kathmandu");
  assert.equal(d.toISOString(), "2026-10-30T03:15:00.000Z");
});

// ─── the counters actually use that window ───────────────────────────────────

const db = getDb();
db.prepare("INSERT INTO accounts (id, name, email, timezone) VALUES (?, ?, ?, ?)")
  .run("acc-ny", "NY account", "ny@example.com", "America/New_York");
db.prepare("INSERT INTO runs (id, account_id, status) VALUES (?, ?, 'running')")
  .run("run-ny", "acc-ny");
db.prepare("INSERT INTO targets (id, linkedin_url) VALUES (?, ?)")
  .run("tgt-ny", "https://www.linkedin.com/in/local-day-fixture");
db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)")
  .run("rp-ny", "run-ny", "tgt-ny", "ea-ny");

let logSeq = 0;
function logAt(createdAt: string, message: string, runId = "run-ny", targetId: string | null = "tgt-ny") {
  db.prepare("INSERT INTO logs (id, run_id, target_id, level, message, created_at) VALUES (?, ?, ?, 'info', ?, ?)")
    .run(`log-${++logSeq}`, runId, targetId, message, createdAt);
}

// The account's local day is 2026-10-29 (04:00Z 29th .. 04:00Z 30th in New York).
logAt("2026-10-29T03:59:59", "Message sent — just before the local day");   // local 28th 23:59:59
logAt("2026-10-29T04:00:00", "Connection request sent — first second");     // local 29th 00:00:00
logAt("2026-10-29T12:00:00", "Connection request sent — midday");           // local 29th 08:00:00
logAt("2026-10-30T02:00:00", "InMail sent — evening of the local day");     // local 29th 22:00:00
logAt("2026-10-30T03:59:59", "Message sent — last second");                 // local 29th 23:59:59
logAt("2026-10-30T04:00:00", "Connection request sent — next local day");   // local 30th 00:00:00
logAt("2026-10-30T04:30:00", "Message sent — next local day");              // local 30th 00:30:00

test("LinkedIn counters use the account's local day, not the UTC day", () => {
  const now = at("2026-10-30T03:00:00Z"); // 23:00 on 29 Oct in New York
  const done = countLinkedInActionsSentToday(db, "acc-ny", "America/New_York", now);
  assert.deepEqual(done, { connects: 2, messages: 1, inmails: 1 });
});

test("the same logs counted on the UTC day would give the wrong answer", () => {
  // Guards the defect itself: the UTC window straddles two local days, so it
  // counts the tail of the 29th together with the start of the 30th. Each local
  // day is then undercounted, and the account can send past its limit twice.
  const done = countLinkedInActionsSentToday(db, "acc-ny", "UTC", at("2026-10-30T03:00:00Z"));
  assert.deepEqual(done, { connects: 1, messages: 2, inmails: 1 });
});

test("an account with no actions that day counts zero, not null", () => {
  const done = countLinkedInActionsSentToday(db, "acc-ny", "America/New_York", at("2026-10-27T12:00:00Z"));
  assert.deepEqual(done, { connects: 0, messages: 0, inmails: 0 });
});

test("email counter uses the sending profile's account and local day", () => {
  logAt("2026-10-30T02:00:00", "Email sent to lead@example.com");
  logAt("2026-10-30T04:30:00", "Email sent to lead@example.com");
  assert.equal(countEmailsSentToday(db, "ea-ny", "America/New_York", at("2026-10-30T03:00:00Z")), 1);
  assert.equal(countEmailsSentToday(db, "ea-ny", "UTC", at("2026-10-30T03:00:00Z")), 2);
  assert.equal(countEmailsSentToday(db, "ea-other", "America/New_York", at("2026-10-30T03:00:00Z")), 0);
});
