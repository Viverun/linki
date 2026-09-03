import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

// Excludes cookies_json — the frontend never uses the raw session blob, only
// is_authenticated, so there's no reason to ship it (even encrypted) to the client.
const ACCOUNT_COLUMNS = `id, name, email, is_authenticated, daily_connection_limit, daily_message_limit, daily_inmail_limit,
  active_hours_start, active_hours_end, timezone, working_days, created_at,
  inbox_synced_at, accepted_sync_at, li_connections, li_pending, li_profile_views,
  li_stats_synced_at, connections_synced_through_ms`;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;

  if (req.method === "GET") {
    const account = db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(id);
    if (!account) return res.status(404).json({ error: "Not found" });
    return res.json(account);
  }

  if (req.method === "PUT") {
    const { name, email, daily_connection_limit, daily_message_limit, daily_inmail_limit, active_hours_start, active_hours_end, timezone, working_days } = req.body;
    const { changes } = db.prepare(
      `UPDATE accounts SET
        name = COALESCE(?, name),
        email = COALESCE(?, email),
        daily_connection_limit = COALESCE(?, daily_connection_limit),
        daily_message_limit = COALESCE(?, daily_message_limit),
        daily_inmail_limit = COALESCE(?, daily_inmail_limit),
        active_hours_start = COALESCE(?, active_hours_start),
        active_hours_end = COALESCE(?, active_hours_end),
        timezone = COALESCE(?, timezone),
        working_days = COALESCE(?, working_days)
       WHERE id = ?`
    ).run(name ?? null, email ?? null, daily_connection_limit ?? null, daily_message_limit ?? null, daily_inmail_limit ?? null, active_hours_start ?? null, active_hours_end ?? null, timezone ?? null, working_days ?? null, id);
    if (changes === 0) return res.status(404).json({ error: "Not found" });
    return res.json(db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(id));
  }

  if (req.method === "DELETE") {
    try {
      const { changes } = db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
      if (changes === 0) return res.status(404).json({ error: "Not found" });
      return res.status(204).end();
    } catch (err) {
      // runs.account_id references accounts(id) with no ON DELETE clause, so
      // SQLite refuses to orphan an account's runs. Report that as a conflict
      // the caller can act on instead of a 500 the UI can't explain.
      if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        return res.status(409).json({
          error:
            "This account still has runs attached. Stop and delete those runs first, then delete the account.",
        });
      }
      throw err;
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  res.status(405).end();
}
