import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { stepRefOf, legacyStepRefOf } from "@/lib/linkedin/runner";
import { methodNotAllowed } from "@/lib/api-validate";

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

type Outcome = "rearmed" | "advanced" | "blocked" | "skipped" | "marked_delivered";

interface TrackOutcome {
  track_id: string;
  /** The UI lists prospects, not tracks — without this it cannot say WHO was blocked. */
  target_id: string;
  outcome: Outcome;
  reason?: string;
}

/** Marker kept in the stored record so an operator assertion is never mistaken
 *  for a system confirmation. LinkedIn gives messaging no delivery receipt, so
 *  the provenance of a 'confirmed' row is the only thing that distinguishes
 *  "we saw it work" from "a human said it worked". */
const OPERATOR_ASSERTION = "operator-asserted delivery (not system-confirmed)";

/**
 * Records who overrode the fail-closed default, so a duplicate delivered by
 * explicit operator choice is never mistaken for a system decision.
 *
 * The row is moved to 'abandoned' because that is the one state
 * sideEffectBegin's upsert will re-arm, and it increments attempt_count so the
 * override is counted rather than erased. 'abandoned' here is a statement about
 * what the SYSTEM may now do — not a claim that nothing was delivered — which is
 * exactly why the operator's override is written into error_message beside it.
 */
const OPERATOR_FORCED_RESEND = "operator forced a resend of a possibly-delivered message";

/**
 * - "skip"           default. A possibly-delivered message is left alone and the
 *                    track stays failed.
 * - "resend"         operator accepts the duplicate risk and re-arms.
 * - "mark_delivered" operator has checked LinkedIn themselves and confirms the
 *                    message arrived. Records that assertion and advances past
 *                    the step. Sends nothing and opens no browser.
 *
 * Without the third option, refusing to auto-resolve an in_flight row leaves the
 * operator with only "stay broken forever" or "risk a duplicate" — structurally
 * the same dead end as F2, introduced by the fix for F1.
 */
const RESOLUTIONS = ["skip", "resend", "mark_delivered"] as const;
type Resolution = (typeof RESOLUTIONS)[number];

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const db = getDb();
  const runId = req.query.id as string;
  const { target_ids, resolve } = req.body as { target_ids: string[]; resolve?: Resolution };

  // Array.isArray, not a truthy .length check: a string has a length, so
  // `target_ids: "abc"` passed the old guard and then reached .map().
  if (!Array.isArray(target_ids) || target_ids.length === 0 || !target_ids.every(t => typeof t === "string")) {
    return res.status(400).json({ error: "target_ids must be a non-empty array of strings" });
  }
  if (resolve !== undefined && !RESOLUTIONS.includes(resolve)) {
    return res.status(400).json({ error: `resolve must be one of ${RESOLUTIONS.map(r => `'${r}'`).join(", ")}` });
  }
  const resolution: Resolution = resolve ?? "skip";

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
    `SELECT rt.id, rt.run_profile_id, rt.track, rt.current_step, rt.current_step_id, rp.target_id, r.workflow_id
     FROM run_profile_tracks rt
     JOIN run_profiles rp ON rp.id = rt.run_profile_id
     JOIN runs r ON r.id = rp.run_id
     WHERE rp.run_id = ? AND rp.target_id IN (${placeholders}) AND rt.state = 'failed'`
  ).all(runId, ...target_ids) as Array<{
    id: string; run_profile_id: string; track: string; current_step: number; current_step_id: string | null; target_id: string; workflow_id: string;
  }>;

  const stepsFor = (workflowId: string, track: string) =>
    db.prepare(
      "SELECT id, step_type, message_position FROM workflow_steps WHERE workflow_id = ? AND track = ? ORDER BY step_order"
    ).all(workflowId, track) as Array<{ id: string; step_type: string; message_position: number | null }>;

  const rearm = db.prepare(
    `UPDATE run_profile_tracks SET state = 'in_progress', error_message = NULL, next_step_at = NULL WHERE id = ?`
  );
  // P2-3 census. Both callers of `advance` (the confirmed branch and
  // mark_delivered) move a track PAST a step, so both must move the pinned id
  // with the index — an advance that updates only the index re-creates exactly
  // the drift current_step_id exists to remove.
  const advance = db.prepare(
    `UPDATE run_profile_tracks SET state = 'in_progress', error_message = NULL, next_step_at = NULL, current_step = ?, current_step_id = ? WHERE id = ?`
  );
  /** The id of the step at `index`, or NULL when the track has run off the end. */
  const stepIdAt = (workflowId: string, track: string, index: number): string | null =>
    stepsFor(workflowId, track)[index]?.id ?? null;

  const outcomes: TrackOutcome[] = [];

  db.transaction(() => {
    for (const c of candidates) {
      const steps = stepsFor(c.workflow_id, c.track);
      // P2-3: by id where the track has one. Retry decides whether a step already
      // ran; resolving that against a reordered list is how a delivered message
      // gets re-sent.
      const step = (c.current_step_id && steps.find(x => x.id === c.current_step_id)) || steps[c.current_step];

      // Only message/inmail steps have an irreversible-action ledger. Anything
      // else (connect, visit, delay, email) re-arms exactly as before.
      const action = step?.step_type === "message" ? "message" : step?.step_type === "sales_inmail" ? "inmail" : null;
      if (!step || !action) {
        // mark_delivered means "record that it happened, do not act". Falling
        // through to a plain re-arm here would turn that into a real retry — on
        // a connect step, an actual invitation attempt. Refuse instead.
        if (resolution === "mark_delivered") {
          outcomes.push({
            track_id: c.id, target_id: c.target_id, outcome: "blocked",
            reason: `mark_delivered applies to message steps only, not ${step?.step_type ?? "an unknown step"}`,
          });
          continue;
        }
        rearm.run(c.id);
        outcomes.push({ track_id: c.id, target_id: c.target_id, outcome: "rearmed" });
        continue;
      }

      const ledger = db.prepare(
        `SELECT status, step_ref FROM step_side_effects
         WHERE run_profile_id = ? AND track = ? AND step_ref = ? AND action = ?`
      ).get(c.run_profile_id, c.track, stepRefOf(step), action) as { status: string; step_ref: string } | undefined
        // X3.3: read the legacy `pos:` key too, so a row written before the
        // scheme switch still blocks a re-send instead of being invisible.
        ?? db.prepare(
          `SELECT status, step_ref FROM step_side_effects
           WHERE run_profile_id = ? AND track = ? AND step_ref = ? AND action = ?`
        ).get(c.run_profile_id, c.track, legacyStepRefOf(step), action) as { status: string; step_ref: string } | undefined;

      // The operator override comes FIRST, because it means "send again
      // regardless of what the ledger says". Handled below the confirmed/
      // in_flight branches it would be swallowed by them: a confirmed row would
      // advance past the step instead of resending, so a second forced resend
      // silently did nothing.
      if (ledger && resolution === "resend") {
        db.prepare(
          `UPDATE step_side_effects SET status = 'abandoned', error_message = ?
           WHERE run_profile_id = ? AND track = ? AND step_ref = ? AND action = ?`
        ).run(OPERATOR_FORCED_RESEND, c.run_profile_id, c.track, ledger.step_ref, action);
        rearm.run(c.id);
        console.warn(`[retry] run=${runId} track=${c.id} operator FORCED resend of a ${ledger.status} ${action}`);
        outcomes.push({
          track_id: c.id, target_id: c.target_id, outcome: "rearmed",
          reason: `operator forced resend of a possibly-delivered ${action}`,
        });
        continue;
      }

      if (ledger?.status === "confirmed") {
        // Already delivered. Re-arming in place would re-send, so move past it.
        advance.run(c.current_step + 1, stepIdAt(c.workflow_id, c.track, c.current_step + 1), c.id);
        outcomes.push({ track_id: c.id, target_id: c.target_id, outcome: "advanced", reason: `${action} already delivered at ${ledger.step_ref} — advanced past it` });
        continue;
      }

      if (ledger?.status === "in_flight") {
        if (resolution === "mark_delivered") {
          if (action !== "message") {
            outcomes.push({
              track_id: c.id, target_id: c.target_id, outcome: "blocked",
              reason: `mark_delivered applies to message steps only, not ${action}`,
            });
            continue;
          }
          // Operator asserts they checked LinkedIn and the message arrived.
          // Records the assertion, advances past the step. No send, no browser.
          db.prepare(
            `UPDATE step_side_effects SET status = 'confirmed', confirmed_at = ?, error_message = ?
             WHERE run_profile_id = ? AND track = ? AND step_ref = ? AND action = 'message'`
          ).run(new Date().toISOString(), OPERATOR_ASSERTION, c.run_profile_id, c.track, ledger.step_ref);
          db.prepare("UPDATE targets SET message_sent_at = COALESCE(message_sent_at, ?) WHERE id = ?")
            .run(new Date().toISOString(), c.target_id);
          advance.run(c.current_step + 1, stepIdAt(c.workflow_id, c.track, c.current_step + 1), c.id);
          console.warn(`[retry] run=${runId} track=${c.id} operator MARKED a possibly-delivered message as delivered (no send performed)`);
          outcomes.push({
            track_id: c.id, target_id: c.target_id, outcome: "marked_delivered",
            reason: OPERATOR_ASSERTION,
          });
          continue;
        }
        outcomes.push({
          track_id: c.id,
          target_id: c.target_id,
          outcome: "blocked",
          reason: `a previous ${action} attempt may already have been delivered — not re-armed. Pass resolve:"resend" to force.`,
        });
        continue;
      }

      if (resolution === "mark_delivered") {
        outcomes.push({
          track_id: c.id, target_id: c.target_id, outcome: "blocked",
          reason: "mark_delivered requires an in-flight message ledger row; this track has none",
        });
        continue;
      }
      rearm.run(c.id);
      outcomes.push({ track_id: c.id, target_id: c.target_id, outcome: "rearmed" });
    }
  })();

  const retried = outcomes.filter(o => o.outcome === "rearmed" || o.outcome === "advanced" || o.outcome === "marked_delivered").length;
  // `ok` and `retried` keep their original names and meaning; `outcomes` is additive.
  return res.json({ ok: true, retried, outcomes });
}
