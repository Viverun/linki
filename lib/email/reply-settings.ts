import type Database from "better-sqlite3";

export const DEFAULT_REPLY_OOO_THRESHOLD = 0.9;
const MIN = 0.5, MAX = 0.99;
const KEY = "reply_ooo_threshold";

/** Probability of "automatic out-of-office" at or above which the open-core policy keeps the enrolment. */
export function getReplyOooThreshold(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  const n = row ? Number(row.value) : DEFAULT_REPLY_OOO_THRESHOLD;
  if (!Number.isFinite(n)) return DEFAULT_REPLY_OOO_THRESHOLD;
  return Math.min(MAX, Math.max(MIN, n));
}

export function setReplyOooThreshold(db: Database.Database, value: number): void {
  if (!Number.isFinite(value) || value < MIN || value > MAX) throw new RangeError(`reply_ooo_threshold must be between ${MIN} and ${MAX}`);
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(KEY, String(value));
}
