import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

const STATUSES = ["open", "done"] as const;

/**
 * Phase 1a: PATCH/DELETE half of the contact-page todos contract.
 * Partial update: only keys present in the body are written, so omitting a
 * field preserves it while an explicit null clears it.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "PATCH" && req.method !== "DELETE") {
    res.setHeader("Allow", ["PATCH", "DELETE"]);
    return res.status(405).end();
  }

  const db = getDb();
  const id = req.query.id as string;
  const existing = db.prepare("SELECT id FROM todos WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Todo not found" });

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM todos WHERE id = ?").run(id);
    return res.json({ ok: true });
  }

  const { title, description, due_date, status } = req.body as {
    title?: string; description?: string | null; due_date?: string | null; status?: string;
  };
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (title !== undefined) { sets.push("title = ?"); vals.push(title); }
  if (description !== undefined) { sets.push("description = ?"); vals.push(description); }
  if (due_date !== undefined) { sets.push("due_date = ?"); vals.push(due_date); }
  if (status !== undefined) { sets.push("status = ?"); vals.push(status); }
  if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });

  db.prepare(`UPDATE todos SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return res.json(db.prepare("SELECT * FROM todos WHERE id = ?").get(id));
}
