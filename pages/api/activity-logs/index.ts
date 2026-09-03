import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";

const TYPES = ["call", "email", "meeting", "note", "other"] as const;

/**
 * Phase 1a: the contact page (pages/contacts/[id].tsx) logs, edits and
 * deletes activity entries via POST /api/activity-logs and
 * PATCH|DELETE /api/activity-logs?id=..., but no route existed.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "PATCH" && req.method !== "DELETE") {
    res.setHeader("Allow", ["POST", "PATCH", "DELETE"]);
    return res.status(405).end();
  }

  const db = getDb();

  if (req.method === "POST") {
    const { target_id, type, body } = req.body as {
      target_id?: string; type?: string; body?: string;
    };
    if (!target_id || !type || !body?.trim()) {
      return res.status(400).json({ error: "target_id, type and body are required" });
    }
    if (!(TYPES as readonly string[]).includes(type)) {
      return res.status(400).json({ error: `type must be one of ${TYPES.join(", ")}` });
    }
    const target = db.prepare("SELECT id FROM targets WHERE id = ?").get(target_id);
    if (!target) return res.status(404).json({ error: "Target not found" });

    const id = randomUUID();
    db.prepare("INSERT INTO activity_logs (id, target_id, type, body) VALUES (?, ?, ?, ?)").run(
      id, target_id, type, body.trim()
    );
    return res.status(201).json(db.prepare("SELECT * FROM activity_logs WHERE id = ?").get(id));
  }

  const id = req.query.id as string;
  if (!id) return res.status(400).json({ error: "id query parameter is required" });
  const existing = db.prepare("SELECT id FROM activity_logs WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Activity log not found" });

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM activity_logs WHERE id = ?").run(id);
    return res.json({ ok: true });
  }

  const { type, body } = req.body as { type?: string; body?: string };
  if (type !== undefined && !(TYPES as readonly string[]).includes(type)) {
    return res.status(400).json({ error: `type must be one of ${TYPES.join(", ")}` });
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (type !== undefined) { sets.push("type = ?"); vals.push(type); }
  if (body !== undefined) { sets.push("body = ?"); vals.push(body); }
  if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });

  db.prepare(`UPDATE activity_logs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return res.json(db.prepare("SELECT * FROM activity_logs WHERE id = ?").get(id));
}
