import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { methodNotAllowed } from "@/lib/api-validate";

/**
 * The only statuses the run state machine recognises.
 *
 * This route previously wrote whatever it was given. A garbage value orphaned
 * the run — tick() selects only 'running' and the auto-complete pass only
 * finalises runs it selected, so neither could ever see it again — and
 * 'completed' → 'running' restarted LinkedIn automation on a finished campaign
 * whose tracks tick() then genuinely picks up (verified against tick()'s own
 * query, not inferred).
 */
const RUN_STATUSES = ["running", "paused", "completed"] as const;
type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * 'completed' is terminal. The auto-complete pass sets it only once every track
 * is terminal, so re-entering 'running' would re-run finished work. The UI only
 * ever sends 'paused' and 'completed' here (resume goes through
 * POST /api/runs/[id]/start), so this table is a superset of real usage and
 * cannot break pause or stop.
 */
const ALLOWED_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  running: ["paused", "completed"],
  paused: ["running", "completed"],
  completed: [],
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const id = req.query.id as string;

  if (req.method === "GET") {
    const run = db
      .prepare(
        `SELECT r.*,
                w.name as workflow_name,
                l.name as list_name,
                a.name as account_name
         FROM runs r
         LEFT JOIN workflows w ON w.id = r.workflow_id
         LEFT JOIN lists l ON l.id = r.list_id
         LEFT JOIN accounts a ON a.id = r.account_id
         WHERE r.id = ?`
      )
      .get(id);
    if (!run) return res.status(404).json({ error: "not found" });

    // Paging + optional target_id filter — a run can hold hundreds of profiles, so callers
    // (incl. the MCP) can page or pull a single contact instead of the whole set.
    const targetId = req.query.target_id as string | undefined;
    const hasPaging = req.query.limit !== undefined || req.query.page !== undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = (Number(req.query.page) || 0) * limit;

    const profileWhere = targetId ? "rp.run_id = ? AND rp.target_id = ?" : "rp.run_id = ?";
    const profileArgs: unknown[] = targetId ? [id, targetId] : [id];
    const profilesTotal = (db.prepare(
      `SELECT COUNT(*) as c FROM run_profiles rp WHERE ${profileWhere}`
    ).get(...profileArgs) as { c: number }).c;

    const pageClause = (targetId || hasPaging) ? " LIMIT ? OFFSET ?" : "";
    const pageArgs = (targetId || hasPaging) ? [limit, offset] : [];

    const profiles = db
      .prepare(
        `SELECT rp.id, rp.run_id, rp.target_id, rp.email_account_id, rp.created_at,
                COALESCE(rt_li.state, 'pending') as state,
                COALESCE(rt_li.current_step, 0) as current_step,
                rt_li.next_step_at, rt_li.error_message,
                rt_email.state as email_state,
                rt_email.current_step as email_current_step,
                t.full_name, t.linkedin_url, t.title, t.company
         FROM run_profiles rp
         LEFT JOIN targets t ON t.id = rp.target_id
         LEFT JOIN run_profile_tracks rt_li ON rt_li.run_profile_id = rp.id AND rt_li.track = 'linkedin'
         LEFT JOIN run_profile_tracks rt_email ON rt_email.run_profile_id = rp.id AND rt_email.track = 'email'
         WHERE ${profileWhere}
         ORDER BY rp.id${pageClause}`
      )
      .all(...profileArgs, ...pageArgs);

    const logs = db
      .prepare(
        `SELECT lg.*, t.full_name as target_name
         FROM logs lg
         LEFT JOIN targets t ON t.id = lg.target_id
         WHERE lg.run_id = ?
         ORDER BY lg.created_at DESC
         LIMIT 100`
      )
      .all(id);

    return res.json({ ...run as object, profiles, profiles_total: profilesTotal, logs });
  }

  if (req.method === "PATCH") {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: "status required" });

    if (!RUN_STATUSES.includes(status as RunStatus)) {
      // An unrecognised value orphans the run: tick() selects only 'running',
      // and the auto-complete pass only finalises runs it selected, so the run
      // becomes invisible to both and its tracks never terminate.
      return res.status(400).json({
        error: `Invalid status '${status}'. Allowed: ${RUN_STATUSES.map(s => `'${s}'`).join(", ")}.`,
        allowed: RUN_STATUSES,
      });
    }

    // Read-then-write in one transaction so a concurrent PATCH cannot slip
    // between the transition check and the update.
    const result = db.transaction(() => {
      const current = db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string } | undefined;
      if (!current) return { code: 404 as const };
      if (current.status === status) return { code: 200 as const };   // idempotent no-op
      if (!ALLOWED_TRANSITIONS[current.status as RunStatus]?.includes(status as RunStatus)) {
        return { code: 409 as const, from: current.status };
      }
      db.prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, id);
      return { code: 200 as const };
    })();

    if (result.code === 404) return res.status(404).json({ error: "Run not found" });
    if (result.code === 409) {
      // Actionable, not a bare refusal. 'completed' is terminal by design: the
      // auto-complete pass has already finalised every track, so resurrecting
      // the run would re-run finished work. The supported route forward is a
      // fresh enrolment, which also re-derives connection state from LinkedIn
      // (a pending invitation is re-detected via PendingInviteError rather than
      // re-sent). See docs/audit-corrections.md, F2.
      const hint = result.from === "completed"
        ? "A completed campaign is final. To contact these people again, enrol them in a new run — their LinkedIn state is re-checked on the way, so an already-pending invitation is detected rather than re-sent."
        : `Allowed transitions from '${result.from}': ${(ALLOWED_TRANSITIONS[result.from as RunStatus] ?? []).map(s => `'${s}'`).join(", ") || "none"}.`;
      return res.status(409).json({
        error: `Cannot change a run from '${result.from}' to '${status}'. ${hint}`,
        from: result.from,
        to: status,
      });
    }
    return res.json({ ok: true });
  }

  if (req.method === "DELETE") {
    // Phase 1c: deleting a live run orphans in-flight browser work and
    // mirrors the workflow-delete guard — pause/stop it first.
    const existing = db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string } | undefined;
    if (!existing) return res.status(404).json({ error: "Run not found" });
    if (existing.status === "running" || existing.status === "paused") {
      return res.status(409).json({
        error: `Cannot delete a ${existing.status} run — pause/stop it first.`,
        status: existing.status,
      });
    }
    db.prepare("DELETE FROM runs WHERE id = ?").run(id);
    return res.json({ ok: true });
  }

  methodNotAllowed(res, ["DELETE", "GET", "PATCH"]);
}
