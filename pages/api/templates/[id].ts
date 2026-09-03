import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;

  if (req.method === "GET") {
    const t = db.prepare("SELECT * FROM templates WHERE id = ?").get(id);
    if (!t) return res.status(404).json({ error: "Not found" });
    return res.json(t);
  }

  if (req.method === "PUT") {
    const { name, body } = req.body;
    const { changes } = db.prepare(
      "UPDATE templates SET name = COALESCE(?, name), body = COALESCE(?, body) WHERE id = ?"
    ).run(name ?? null, body ?? null, id);
    if (changes === 0) return res.status(404).json({ error: "Template not found" });
    return res.json(db.prepare("SELECT * FROM templates WHERE id = ?").get(id));
  }

  if (req.method === "DELETE") {
    const { changes } = db.prepare("DELETE FROM templates WHERE id = ?").run(id);
    if (changes === 0) return res.status(404).json({ error: "Template not found" });
    return res.status(204).end();
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  res.status(405).end();
}
