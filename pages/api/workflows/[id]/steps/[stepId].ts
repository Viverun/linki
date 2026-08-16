import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const stepId = req.query.stepId as string;
  const workflowId = req.query.id as string;

  // D-1. These routes predate PUT /steps and are kept, because removing them is a
  // contract change. They get the same two guards, for the same reasons:
  //  - a live run must not have its steps edited underneath it (409);
  //  - a step id must belong to THIS workflow, or the route edits or deletes
  //    somebody else's step given only its id.
  if (req.method === "PUT" || req.method === "DELETE") {
    const owner = db.prepare("SELECT workflow_id FROM workflow_steps WHERE id = ?").get(stepId) as { workflow_id: string } | undefined;
    if (!owner) return res.status(404).json({ error: "Step not found" });
    if (owner.workflow_id !== workflowId) {
      return res.status(400).json({ error: `step ${stepId} belongs to a different workflow` });
    }
    const live = db.prepare("SELECT COUNT(*) n FROM runs WHERE workflow_id = ? AND status = 'running'").get(workflowId) as { n: number };
    if (live.n > 0) return res.status(409).json({ error: "This workflow has a running run. Pause it before editing steps.", running_runs: live.n });
  }

  if (req.method === "PUT") {
    const { step_type, template_id, delay_seconds, step_order, connect_note, message_body, email_subject, email_body } = req.body;
    db.prepare(
      `UPDATE workflow_steps SET
        step_type = COALESCE(?, step_type),
        template_id = COALESCE(?, template_id),
        delay_seconds = COALESCE(?, delay_seconds),
        step_order = COALESCE(?, step_order),
        connect_note = ?,
        message_body = ?,
        email_subject = ?,
        email_body = ?
       WHERE id = ?`
    ).run(step_type ?? null, template_id ?? null, delay_seconds ?? null, step_order ?? null, connect_note ?? null, message_body ?? null, email_subject ?? null, email_body ?? null, stepId);
    return res.json({ ok: true });
  }

  if (req.method === "DELETE") {
    db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
    return res.json({ ok: true });
  }

  res.status(405).end();
}
