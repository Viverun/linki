import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { idListError } from "@/lib/api-validate";

// DELETE /api/lists/[id]/targets  body: { target_ids: number[] }
// Removes targets from the list (list_targets rows only, does not delete the target itself)
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "DELETE") {
    res.setHeader("Allow", ["DELETE"]);
    return res.status(405).end();
  }

  const db = getDb();
  const listId = req.query.id as string;
  const { target_ids } = req.body as { target_ids?: string[] };

  // Phase 4: shared shape + size check, plus a 404 for unknown lists
  // (was `removed: 0`, indistinguishable from "nothing matched").
  const listErr = idListError(target_ids, "target_ids");
  if (listErr) return res.status(400).json({ error: listErr });
  const ids = target_ids ?? []; // validated above; ?? [] is for the type checker
  const list = db.prepare("SELECT id FROM lists WHERE id = ?").get(listId);
  if (!list) return res.status(404).json({ error: "List not found" });

  const placeholders = ids.map(() => "?").join(",");
  const result = db
    .prepare(`DELETE FROM list_targets WHERE list_id = ? AND target_id IN (${placeholders})`)
    .run(listId, ...ids);

  return res.json({ removed: result.changes });
}
