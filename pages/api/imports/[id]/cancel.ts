import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { cancelImport } from "@/lib/import-jobs";

/** POST — cancel an import batch. A running batch stops at its next page boundary. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }
  const db = getDb();
  const id = req.query.id as string;

  const job = db.prepare("SELECT id, status FROM list_imports WHERE id = ?").get(id) as
    | { id: string; status: string }
    | undefined;
  if (!job) return res.status(404).json({ error: "Import not found" });
  // Phase 5: only scheduled/running imports can be cancelled — anything else
  // is terminal and the old unconditional ok:true lied about doing something.
  if (job.status !== "scheduled" && job.status !== "running") {
    return res.status(409).json({ error: `Import is already ${job.status} — nothing to cancel.`, status: job.status });
  }

  cancelImport(db, id);
  return res.json({ ok: true });
}
