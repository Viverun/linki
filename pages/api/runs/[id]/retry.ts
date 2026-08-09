import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { stepRefOf } from "@/lib/linkedin/runner";

/**
 * Re-arms failed track-runs so the runner picks them up again.
 *
 * This route used to reset state='failed' → 'in_progress' unconditionally, which
 * made it the delivery mechanism for the duplicate-message defect: a message that
 * WAS delivered but whose bookkeeping threw left a failed track, and one click
 * here re-sent it to the same person. Retry now consults the side-effect ledger
 * and refuses to re-arm a step whose external action may already have happened.
 *
 * The connect path is deliberately left as-is: re-entry there hits
 * assertConnectable → PendingInviteError → COALESCE(connection_requested_at),
 * which is the ONLY recovery route for an invitation that was sent but not
 * recorded. Breaking that would turn a recoverable divergence into a dead end.
 */

type Outcome = "rearmed" | "advanced" | "blocked" | "skipped";

interface TrackOutcome {
  track_id: string;
  outcome: Outcome;
  reason?: string;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const runId = req.query.id as string;
  const { target_ids, resolve } = req.body as { target_ids: string[]; resolve?: "skip" | "resend" };

  if (!target_ids?.length) return res.status(400).json({ error: "target_ids required" });
  if (resolve !== undefined && resolve !== "skip" && resolve !== "resend") {
    return res.status(400).json({ error: "resolve must be 'skip' or 'resend'" });
  }
  const resolution: "skip" | "resend" = resolve ?? "skip";

  const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
  if (!run) return res.status(404).json({ error: "Run not found" });
  if (run.status !== "running" && run.status !== "paused") {
    return res.status(409).json({
      error: `Cannot retry a run with status '${run.status}' — only running or paused runs can be retried.`,
      status: run.status,
    });
  }

  const placeholders = target_ids.map(() => "?").join(",");
  const candidates = db.prepare(
    `SELECT rt.id, rt.run_profile_id, rt.track, rt.current_step, rp.target_id, r.workflow_id
     FROM run_profile_tracks rt
     JOIN run_profiles rp ON rp.id = rt.run_profile_id
     JOIN runs r ON r.id = rp.run_id
     WHERE rp.run_id = ? AND rp.target_id IN (${placeholders}) AND rt.state = 'failed'`
  ).all(runId, ...target_ids) as Array<{
    id: string; run_profile_id: string; track: string; current_step: number; target_id: string; workflow_id: string;
  }>;

  const stepsFor = (workflowId: string, track: string) =>
    db.prepare(
      "SELECT id, step_type, message_position FROM workflow_steps WHERE workflow_id = ? AND track = ? ORDER BY step_order"
    ).all(workflowId, track) as Array<{ id: string; step_type: string; message_position: number | null }>;

  const rearm = db.prepare(
    `UPDATE run_profile_tracks SET state = 'in_progress', error_message = NULL, next_step_at = NULL WHERE id = ?`
  );
  const advance = db.prepare(
    `UPDATE run_profile_tracks SET state = 'in_progress', error_message = NULL, next_step_at = NULL, current_step = ? WHERE id = ?`
  );

  const outcomes: TrackOutcome[] = [];

  db.transaction(() => {
    for (const c of candidates) {
      const steps = stepsFor(c.workflow_id, c.track);
      const step = steps[c.current_step];

      // Only message/inmail steps have an irreversible-action ledger. Anything
      // else (connect, visit, delay, email) re-arms exactly as before.
      const action = step?.step_type === "message" ? "message" : step?.step_type === "sales_inmail" ? "inmail" : null;
      if (!step || !action) {
        rearm.run(c.id);
        outcomes.push({ track_id: c.id, outcome: "rearmed" });
        continue;
      }

      const ledger = db.prepare(
        `SELECT status, step_ref FROM step_side_effects
         WHERE run_profile_id = ? AND track = ? AND step_ref = ? AND action = ?`
      ).get(c.run_profile_id, c.track, stepRefOf(step), action) as { status: string; step_ref: string } | undefined;

      if (ledger?.status === "confirmed") {
        // Already delivered. Re-arming in place would re-send, so move past it.
        advance.run(c.current_step + 1, c.id);
        outcomes.push({ track_id: c.id, outcome: "advanced", reason: `${action} already delivered at ${ledger.step_ref} — advanced past it` });
        continue;
      }

      if (ledger?.status === "in_flight") {
        if (resolution === "resend") {
          rearm.run(c.id);
          outcomes.push({ track_id: c.id, outcome: "rearmed", reason: `operator forced resend of a possibly-delivered ${action}` });
          continue;
        }
        outcomes.push({
          track_id: c.id,
          outcome: "blocked",
          reason: `a previous ${action} attempt may already have been delivered — not re-armed. Pass resolve:"resend" to force.`,
        });
        continue;
      }

      rearm.run(c.id);
      outcomes.push({ track_id: c.id, outcome: "rearmed" });
    }
  })();

  if (resolution === "resend") {
    const forced = outcomes.filter(o => o.reason?.includes("forced resend")).length;
    if (forced > 0) console.warn(`[retry] run=${runId} operator FORCED resend of ${forced} possibly-delivered action(s)`);
  }

  const retried = outcomes.filter(o => o.outcome === "rearmed" || o.outcome === "advanced").length;
  // `ok` and `retried` keep their original names and meaning; `outcomes` is additive.
  return res.json({ ok: true, retried, outcomes });
}
