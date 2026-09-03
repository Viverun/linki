import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { methodNotAllowed } from "@/lib/api-validate";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;

  if (req.method === "GET") {
    const workflow = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
    if (!workflow) return res.status(404).json({ error: "not found" });
    const steps = db
      .prepare(
        `SELECT ws.*, t.name as template_name
         FROM workflow_steps ws
         LEFT JOIN templates t ON t.id = ws.template_id
         WHERE ws.workflow_id = ?
         ORDER BY ws.step_order`
      )
      .all(id);
    return res.json({ ...workflow as object, steps });
  }

  if (req.method === "PUT") {
    const { name, description, prompt } = req.body;
    // name/description: COALESCE so a rename-only request doesn't null them out
    // prompt: always update when present in body (even "" to clear it)
    if (prompt !== undefined) {
      db.prepare(
        "UPDATE workflows SET name = COALESCE(?, name), description = COALESCE(?, description), prompt = ? WHERE id = ?"
      ).run(name ?? null, description ?? null, prompt || null, id);
    } else {
      db.prepare(
        "UPDATE workflows SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?"
      ).run(name ?? null, description ?? null, id);
    }
    return res.json(db.prepare("SELECT * FROM workflows WHERE id = ?").get(id));
  }

  if (req.method === "PATCH") {
    const { is_archived } = req.body;
    const existing = db.prepare("SELECT id FROM workflows WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Workflow not found" });
    if (is_archived !== undefined) {
      db.prepare("UPDATE workflows SET is_archived = ? WHERE id = ?").run(is_archived ? 1 : 0, id);
    }
    return res.json(db.prepare("SELECT * FROM workflows WHERE id = ?").get(id));
  }

  if (req.method === "DELETE") {
    // Refuse while a run is live. Deleting the run row out from under an
    // executing step leaves the runner writing to rows that no longer exist:
    // its next log() insert violates logs.run_id → runs(id) and throws, AFTER
    // whatever LinkedIn action that step had already performed. Mirrors the 409
    // already used by DELETE /api/accounts/[id].
    const live = db.prepare(
      "SELECT COUNT(*) c FROM runs WHERE workflow_id = ? AND status IN ('running', 'paused')"
    ).get(id) as { c: number };
    if (live.c > 0) {
      return res.status(409).json({
        error: `This campaign has ${live.c} active run${live.c === 1 ? "" : "s"}. Stop ${live.c === 1 ? "it" : "them"} first, then delete the campaign.`,
        active_runs: live.c,
      });
    }

    // One transaction: the two statements are not independent. If the second
    // failed after the first succeeded, the runs would be gone and the workflow
    // would remain — a state no retry can reconcile.
    //
    // Only these two statements are needed; the rest is done by cascades, and
    // adding explicit deletes for them would fight the FK graph:
    //   runs            → run_profiles (CASCADE) → run_profile_tracks (CASCADE)
    //                                            → step_side_effects (CASCADE)
    //                   → logs (CASCADE)
    //   workflows       → workflow_steps (CASCADE)
    db.transaction(() => {
      db.prepare("DELETE FROM runs WHERE workflow_id = ?").run(id);
      db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
    })();
    return res.json({ ok: true });
  }

  methodNotAllowed(res, ["DELETE", "GET", "PATCH", "PUT"]);
}
