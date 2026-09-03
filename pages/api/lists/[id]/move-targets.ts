import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { idListError } from "@/lib/api-validate";

// POST /api/lists/[id]/move-targets
// body: { target_ids: string[], destination_list_id: string }
// Moves targets from source list to destination list (removes from source, adds to destination)
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const db = getDb();
  const sourceListId = req.query.id as string;
  const { target_ids, destination_list_id } = req.body as {
    target_ids: string[];
    destination_list_id: string;
  };

  // Phase 3.2: shared shape + size check (was truthy-only, unbounded).
  const listErr = idListError(target_ids, "target_ids");
  if (listErr) return res.status(400).json({ error: listErr });
  if (!destination_list_id)
    return res.status(400).json({ error: "destination_list_id required" });
  if (destination_list_id === sourceListId)
    return res.status(400).json({ error: "Source and destination list are the same" });

  const source = db.prepare("SELECT id FROM lists WHERE id = ?").get(sourceListId);
  if (!source) return res.status(404).json({ error: "Source list not found" });
  const dest = db.prepare("SELECT id FROM lists WHERE id = ?").get(destination_list_id);
  if (!dest) return res.status(404).json({ error: "Destination list not found" });

  // Phase 3.2: a dangling target_id used to die as an FK throw → 500.
  // Filter to existing targets and report the rest (add-members precedent).
  const knownIds = new Set(
    (db.prepare(`SELECT id FROM targets WHERE id IN (${target_ids.map(() => "?").join(",")})`).all(...target_ids) as { id: string }[])
      .map(r => r.id)
  );
  const known = target_ids.filter((tid: string) => knownIds.has(tid));
  const placeholders = known.map(() => "?").join(",");

  db.transaction(() => {
    if (known.length > 0) {
      db.prepare(
        `DELETE FROM list_targets WHERE list_id = ? AND target_id IN (${placeholders})`
      ).run(sourceListId, ...known);

      for (const tid of known) {
        db.prepare(
          `INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)`
        ).run(destination_list_id, tid);
      }
    }
  })();

  return res.json({ moved: known.length, skipped_unknown: target_ids.length - known.length });
}
