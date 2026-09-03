import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";
import { methodNotAllowed } from "@/lib/api-validate";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const db = getDb();
  const id = req.query.id as string;

  const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string } | undefined;
  if (!run) return res.status(404).json({ error: "Run not found" });
  if (run.status === "running") return res.status(400).json({ error: "Run already running" });
  // Phase 1c: 'completed' is terminal (see PATCH transition table in
  // ./index.ts). Restarting it here silently re-ran a finished campaign —
  // the same resurrection the PATCH guard exists to prevent.
  if (run.status === "completed") {
    return res.status(409).json({
      error: "Cannot start a completed run — it is terminal. To contact these people again, enrol them in a new run.",
      status: run.status,
    });
  }

  db.prepare(
    "UPDATE runs SET status = 'running', started_at = COALESCE(started_at, datetime('now')) WHERE id = ?"
  ).run(id);

  ensureGlobalRunnerStarted();

  return res.json({ ok: true });
}
