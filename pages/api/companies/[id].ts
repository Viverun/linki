import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { methodNotAllowed } from "@/lib/api-validate";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;

  if (req.method === "GET") {
    const company = db.prepare("SELECT * FROM companies WHERE id = ?").get(id);
    if (!company) return res.status(404).json({ error: "not found" });
    const contacts = db
      .prepare("SELECT id, full_name, title, email, linkedin_url FROM targets WHERE company_id = ? ORDER BY full_name")
      .all(id);
    return res.json({ ...company as object, contacts });
  }

  if (req.method === "PUT") {
    const existing = db.prepare("SELECT id FROM companies WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "not found" });
    // Partial update: only keys present in the body are written, so omitting
    // a field preserves it while an explicit null clears it. The old code
    // wrote `field ?? null` for every column, nulling anything the caller
    // did not send.
    const allowed = ["name", "domain", "industry", "location", "linkedin_url", "website", "notes"] as const;
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const key of allowed) {
      if ((req.body as Record<string, unknown>)[key] !== undefined) {
        sets.push(`${key} = ?`);
        vals.push((req.body as Record<string, unknown>)[key]);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });
    db.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return res.json(db.prepare("SELECT * FROM companies WHERE id = ?").get(id));
  }

  if (req.method === "DELETE") {
    // Unlink contacts first, then delete company
    db.prepare("UPDATE targets SET company_id = NULL WHERE company_id = ?").run(id);
    db.prepare("DELETE FROM companies WHERE id = ?").run(id);
    return res.json({ ok: true });
  }

  methodNotAllowed(res, ["DELETE", "GET", "PUT"]);
}
