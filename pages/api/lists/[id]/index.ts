import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;

  if (req.method === "GET") {
    const list = db.prepare("SELECT * FROM lists WHERE id = ?").get(id);
    if (!list) return res.status(404).json({ error: "Not found" });
    const targets = db
      .prepare(
        `SELECT t.* FROM targets t
         JOIN list_targets lt ON lt.target_id = t.id
         WHERE lt.list_id = ?
         ORDER BY t.created_at DESC`
      )
      .all(id);
    return res.json({ ...list, targets });
  }

  if (req.method === "PUT") {
    const { name, description } = req.body;
    db.prepare(
      "UPDATE lists SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?"
    ).run(name, description, id);
    return res.json(db.prepare("SELECT * FROM lists WHERE id = ?").get(id));
  }

  if (req.method === "DELETE") {
    // Phase 1c: the two deletes were non-atomic (a crash between them left
    // runs without a list), and deleting an unknown id still returned 204.
    // Cascades (runs → profiles → tracks/side-effects/logs, lists →
    // list_targets) already cover the children — atomicity was the gap.
    const existing = db.prepare("SELECT id FROM lists WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "List not found" });
    db.transaction(() => {
      db.prepare("DELETE FROM runs WHERE list_id = ?").run(id);
      db.prepare("DELETE FROM lists WHERE id = ?").run(id);
    })();
    return res.status(204).end();
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  res.status(405).end();
}
