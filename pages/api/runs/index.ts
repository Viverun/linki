import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { idListError } from "@/lib/api-validate";
import { randomUUID } from "crypto";
import { methodNotAllowed } from "@/lib/api-validate";

class WorkflowAlreadyActiveError extends Error {}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();

  if (req.method === "GET") {
    const runs = db
      .prepare(
        `SELECT r.*,
                w.name as workflow_name,
                l.name as list_name,
                a.name as account_name,
                COUNT(DISTINCT rp.id) as total_profiles,
                COUNT(DISTINCT CASE WHEN NOT EXISTS (
                  SELECT 1 FROM run_profile_tracks rt2
                  WHERE rt2.run_profile_id = rp.id AND rt2.state NOT IN ('completed', 'failed', 'skipped')
                ) AND EXISTS (
                  SELECT 1 FROM run_profile_tracks rt3
                  WHERE rt3.run_profile_id = rp.id AND rt3.state = 'completed'
                ) THEN rp.id END) as completed_profiles
         FROM runs r
         LEFT JOIN workflows w ON w.id = r.workflow_id
         LEFT JOIN lists l ON l.id = r.list_id
         LEFT JOIN accounts a ON a.id = r.account_id
         LEFT JOIN run_profiles rp ON rp.run_id = r.id
         GROUP BY r.id
         ORDER BY r.created_at DESC`
      )
      .all();
    return res.json(runs);
  }

  if (req.method === "POST") {
    const { workflow_id, list_id, account_id, email_account_id, email_account_ids, target_ids } = req.body;
    if (!workflow_id || !list_id || !account_id)
      return res.status(400).json({ error: "workflow_id, list_id, account_id required" });

    // Phase 2: unknown ids used to die later as FK throws → 500. Fail 404 here.
    const workflow = db.prepare("SELECT id FROM workflows WHERE id = ?").get(workflow_id);
    if (!workflow) return res.status(404).json({ error: "Workflow not found" });
    const list = db.prepare("SELECT id FROM lists WHERE id = ?").get(list_id);
    if (!list) return res.status(404).json({ error: "List not found" });
    const account = db.prepare("SELECT id FROM accounts WHERE id = ?").get(account_id);
    if (!account) return res.status(404).json({ error: "Account not found" });

    // Normalise email account list — prefer the new array, fall back to legacy single-id
    const emailAccountPool: string[] = Array.isArray(email_account_ids) && email_account_ids.length > 0
      ? email_account_ids
      : (email_account_id ? [email_account_id] : []);

    const isActive = db.prepare("SELECT id FROM runs WHERE workflow_id = ? AND status IN ('running', 'paused') LIMIT 1");
    const activeConflict = () => res.status(409).json({
      error: "workflow_already_active",
      message: "This workflow is already running. Stop or pause it before enrolling a new list.",
    });
    // Check 1 (pre-flight): only one active run per workflow. Re-checked inside
    // the write transaction below, which is the one that counts.
    if (isActive.get(workflow_id)) return activeConflict();

    // ── validate (no writes) ────────────────────────────────────────────────
    const candidates: { target_id: string }[] = Array.isArray(target_ids) && target_ids.length > 0
      ? (target_ids as string[]).map((id) => ({ target_id: id }))
      : db.prepare("SELECT target_id FROM list_targets WHERE list_id = ?").all(list_id) as { target_id: string }[];

    if (Array.isArray(target_ids) && target_ids.length > 0) {
      const listErr = idListError(target_ids, "target_ids");
      if (listErr) return res.status(400).json({ error: listErr });
      const ids = target_ids as string[];
      const known = new Set(
        (db.prepare(`SELECT id FROM targets WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { id: string }[]).map(r => r.id)
      );
      const unknown = ids.filter(t => !known.has(t));
      if (unknown.length > 0) return res.status(400).json({ error: `unknown target_ids: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ` (+${unknown.length - 5} more)` : ""}` });
    }

    // ── compute (reads only) ────────────────────────────────────────────────
    const alreadyEnrolled = new Set(
      (db.prepare(`SELECT DISTINCT rp.target_id FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE r.workflow_id = ?`).all(workflow_id) as { target_id: string }[]).map((r) => r.target_id)
    );
    const activeElsewhere = new Set(
      (db.prepare(
        `SELECT DISTINCT rp.target_id FROM run_profiles rp
         JOIN runs r ON r.id = rp.run_id
         WHERE r.status IN ('running', 'paused')
         AND EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed', 'failed', 'skipped'))`
      ).all() as { target_id: string }[]).map((r) => r.target_id)
    );
    const targets = candidates.filter((t) => !alreadyEnrolled.has(t.target_id) && !activeElsewhere.has(t.target_id));
    if (targets.length === 0) {
      return res.status(400).json({ error: "all_already_enrolled", message: "All selected contacts are already enrolled in this workflow." });
    }

    // Assign email accounts: company-grouped round-robin (unchanged logic)
    const emailAssignment: Map<string, string | null> = new Map();
    if (emailAccountPool.length > 0) {
      const targetIds = targets.map(t => t.target_id);
      const companyRows = db.prepare(`SELECT id, company_id FROM targets WHERE id IN (${targetIds.map(() => "?").join(",")})`).all(...targetIds) as { id: string; company_id: string | null }[];
      const companyAccountMap = new Map<string, string>();
      let poolCursor = 0;
      for (const row of companyRows) {
        if (row.company_id) {
          if (!companyAccountMap.has(row.company_id)) { companyAccountMap.set(row.company_id, emailAccountPool[poolCursor % emailAccountPool.length]); poolCursor++; }
          emailAssignment.set(row.id, companyAccountMap.get(row.company_id)!);
        } else {
          emailAssignment.set(row.id, emailAccountPool[poolCursor % emailAccountPool.length]); poolCursor++;
        }
      }
    }
    const workflowTracks = [...new Set((db.prepare("SELECT DISTINCT track FROM workflow_steps WHERE workflow_id = ?").all(workflow_id) as { track: string }[]).map(r => r.track))];
    if (workflowTracks.length === 0) workflowTracks.push("linkedin");
    // P2-3: pin each new track to the id of its FIRST step, so identity is
    // established at enrolment rather than inferred from index 0 later.
    const firstStepIdFor = (track: string): string | null =>
      (db.prepare("SELECT id FROM workflow_steps WHERE workflow_id = ? AND track = ? ORDER BY step_order LIMIT 1").get(workflow_id, track) as { id: string } | undefined)?.id ?? null;
    const firstStepId = new Map<string, string | null>(workflowTracks.map(track => [track, firstStepIdFor(track)]));

    // ── write (one IMMEDIATE transaction) ───────────────────────────────────
    // PR-11: the parent row used to be inserted before validation and cleaned
    // up by hand on one failure path only. Now nothing is written until every
    // check has passed, and the run, its profiles and its tracks land together
    // or not at all. IMMEDIATE takes the write lock up front so two concurrent
    // creates serialise and the loser sees the winner's active run.
    const insertRun = db.prepare("INSERT INTO runs (id, workflow_id, list_id, account_id, email_account_id) VALUES (?, ?, ?, ?, ?)");
    const insertProfile = db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?, ?, ?, ?)");
    const insertTrack = db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step, current_step_id) VALUES (?, ?, ?, 'pending', 0, ?)");
    const runId = randomUUID();
    const createRun = db.transaction(() => {
      if (isActive.get(workflow_id)) throw new WorkflowAlreadyActiveError();
      insertRun.run(runId, workflow_id, list_id, account_id, emailAccountPool[0] ?? null);
      for (const t of targets) {
        const assignedEmailAccountId = emailAssignment.get(t.target_id) ?? null;
        const rpId = randomUUID();
        insertProfile.run(rpId, runId, t.target_id, assignedEmailAccountId);
        for (const track of workflowTracks) {
          if (track === "email" && !assignedEmailAccountId) continue;
          insertTrack.run(randomUUID(), rpId, track, firstStepId.get(track) ?? null);
        }
      }
    });
    try {
      createRun.immediate();
    } catch (err) {
      if (err instanceof WorkflowAlreadyActiveError) return activeConflict();
      throw err;
    }
    return res.status(201).json({ id: runId });
  }

  methodNotAllowed(res, ["GET", "POST"]);
}
