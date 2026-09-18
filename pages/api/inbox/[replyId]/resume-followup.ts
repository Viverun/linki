import type { NextApiRequest, NextApiResponse } from "next";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { methodNotAllowed } from "@/lib/api-validate";

/**
 * Resumes automated follow-ups for a contact after a reply stopped them
 * (mirror of cancel-followup). Records an operator decision on the reply, clears
 * targets.email_replied_at, and re-arms this run's tracks that were skipped with
 * 'Lead replied'. Operator decisions win over model decisions (C2-B2 / PR-03).
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const db = getDb();
  const replyId = req.query.replyId as string;
  if (!replyId) return res.status(400).json({ error: "replyId required" });

  const reply = db.prepare("SELECT target_id, run_id, dispatched_at, dispatch_result_json FROM email_replies WHERE id = ?").get(replyId) as
    { target_id: string; run_id: string | null; dispatched_at: string | null; dispatch_result_json: string | null } | undefined;
  if (!reply) return res.status(404).json({ error: "reply_not_found" });

  const result = db.transaction(() => {
    const now = new Date().toISOString();
    const prior = reply.dispatch_result_json ? (JSON.parse(reply.dispatch_result_json) as { decision?: string }).decision : undefined;
    if (!reply.dispatched_at || prior === "human_reply") {
      db.prepare("UPDATE email_replies SET dispatched_at = ?, dispatch_result_json = ?, classification_error = NULL WHERE id = ?")
        .run(now, JSON.stringify({ source: "open-core", decision: "operator_continue" }), replyId);
    }
    db.prepare("UPDATE targets SET email_replied_at = NULL WHERE id = ?").run(reply.target_id);
    let rearmed = 0;
    if (reply.run_id) {
      rearmed = db.prepare(
        `UPDATE run_profile_tracks SET state = 'in_progress', error_message = NULL, next_step_at = NULL
         WHERE state = 'skipped' AND error_message = 'Lead replied'
           AND run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ? AND target_id = ?)`
      ).run(reply.run_id, reply.target_id).changes;
    }
    db.prepare("INSERT INTO activity_logs (id, target_id, type, body) VALUES (?, ?, 'email', 'Follow-ups resumed from inbox')").run(randomUUID(), reply.target_id);
    return { ok: true, rearmed };
  }).immediate();
  return res.json(result);
}
