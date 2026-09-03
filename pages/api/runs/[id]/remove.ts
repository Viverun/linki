import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const runId = req.query.id as string;
  const { target_ids } = req.body as { target_ids: string[] };

  // Array.isArray, not a truthy .length check: a string has a length, so
  // `target_ids: "abc"` passed the old guard and then threw in .map().
  if (!Array.isArray(target_ids) || target_ids.length === 0 || !target_ids.every(t => typeof t === "string")) {
    return res.status(400).json({ error: "target_ids must be a non-empty array of strings" });
  }

  const run = db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
  if (!run) return res.status(404).json({ error: "Run not found" });

  const placeholders = target_ids.map(() => "?").join(",");
  // Phase 1c: logs reference (run_id, target_id) with no cascade off
  // run_profiles, so removing profiles orphaned their history. Clear both
  // atomically, mirroring the bulk targets DELETE.
  const result = db.transaction(() => {
    db.prepare(`DELETE FROM logs WHERE run_id = ? AND target_id IN (${placeholders})`).run(runId, ...target_ids);
    return db
      .prepare(
        `DELETE FROM run_profiles
         WHERE run_id = ? AND target_id IN (${placeholders})`
      )
      .run(runId, ...target_ids);
  })();

  return res.json({ ok: true, removed: result.changes });
}
