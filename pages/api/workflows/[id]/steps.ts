import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { z } from "zod";
import { methodNotAllowed } from "@/lib/api-validate";


// ─── P2-3 / X3.1 — the non-destructive save ──────────────────────────────────
//
// NF-1: the UI saved a workflow by DELETING every step and re-POSTing it, so each
// save minted fresh uuids and destroyed step identity. Everything downstream was
// then forced to refer to steps by POSITION, which is how an already-connected
// target gets a message sent to it after a reorder (N3).
//
// This route takes the full ordered list and DIFFS it against what is stored:
// update by id, insert what is new, delete what is gone, renumber step_order from
// array position. Ids that were sent back survive, so `run_profile_tracks.
// current_step_id` keeps pointing at the same step across a save.
//
// zod is used here because this is a NEW route — the no-retrofit rule covers
// existing ones. The validation is not decoration: a bad body previously reached
// SQL, and `!x?.length` accepts a STRING, which is the exact bug class that let
// `target_ids: "abc"` through the retry route.

const STEP_TYPES = ["visit", "connect", "message", "delay", "email"] as const;

const StepInput = z.object({
  id: z.string().min(1).optional(),
  step_type: z.enum(STEP_TYPES),
  track: z.enum(["linkedin", "email"]).optional(),
  template_id: z.string().nullable().optional(),
  template_ids: z.array(z.string()).optional(),
  delay_seconds: z.number().int().min(0).optional(),
  connect_note: z.string().nullable().optional(),
  message_body: z.string().nullable().optional(),
  email_subject: z.string().nullable().optional(),
  email_body: z.string().nullable().optional(),
  email_signature: z.string().nullable().optional(),
  email_position: z.number().int().optional(),
  message_position: z.number().int().optional(),
  ai_enabled: z.union([z.boolean(), z.number()]).optional(),
  ai_model: z.string().nullable().optional(),
  ai_prompt: z.string().nullable().optional(),
  ai_max_words: z.number().int().nullable().optional(),
  ai_language: z.string().nullable().optional(),
}).strict();

/** The body is the ordered list itself, or `{ steps: [...] }`. */
const Body = z.union([z.array(StepInput), z.object({ steps: z.array(StepInput) })]);

function handlePut(db: ReturnType<typeof getDb>, workflowId: string, req: NextApiRequest, res: NextApiResponse) {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return res.status(400).json({
      error: `invalid steps payload: ${issue.message}`,
      field: issue.path.join(".") || "(root)",
    });
  }
  const incoming = Array.isArray(parsed.data) ? parsed.data : parsed.data.steps;

  const wf = db.prepare("SELECT id FROM workflows WHERE id = ?").get(workflowId);
  if (!wf) return res.status(404).json({ error: "Workflow not found" });

  // Editing steps under a LIVE run would move the ground beneath tracks that are
  // mid-flight. Paused is permitted (Appendix A, D-4): id-based resolution makes
  // drift detectable rather than forbidden, so blocking paused edits would be a
  // usability cost with no safety return.
  const live = db.prepare("SELECT COUNT(*) n FROM runs WHERE workflow_id = ? AND status = 'running'").get(workflowId) as { n: number };
  if (live.n > 0) {
    return res.status(409).json({
      error: "This workflow has a running run. Pause it before editing steps.",
      running_runs: live.n,
    });
  }

  const existing = db.prepare("SELECT id FROM workflow_steps WHERE workflow_id = ?").all(workflowId) as { id: string }[];
  const existingIds = new Set(existing.map(r => r.id));

  // An id that belongs to a DIFFERENT workflow must not be adopted into this one:
  // it would silently move somebody else's step.
  for (const st of incoming) {
    if (st.id && !existingIds.has(st.id)) {
      const owner = db.prepare("SELECT workflow_id FROM workflow_steps WHERE id = ?").get(st.id) as { workflow_id: string } | undefined;
      if (owner) {
        return res.status(400).json({ error: `step ${st.id} belongs to a different workflow`, field: "id" });
      }
      return res.status(400).json({ error: `step ${st.id} does not exist`, field: "id" });
    }
  }

  const trackOf = (st: z.infer<typeof StepInput>): "linkedin" | "email" =>
    st.track === "email" || st.step_type === "email" ? "email" : "linkedin";

  const orderIn: Record<string, number> = { linkedin: 0, email: 0 };
  const keptIds = new Set<string>();
  const result: { id: string; created: boolean }[] = [];

  db.transaction(() => {
    for (const st of incoming) {
      const track = trackOf(st);
      const step_order = ++orderIn[track];
      // D-5: message_position semantics unchanged from POST — client-provided, or 1.
      const vals = [
        st.step_type, track, st.template_id ?? null, st.delay_seconds ?? 0,
        st.connect_note ?? null, st.message_body ?? null, st.email_subject ?? null,
        st.email_body ?? null, st.email_signature !== undefined ? st.email_signature : null,
        st.email_position ?? 1, st.message_position ?? 1,
        st.ai_enabled ? 1 : 0, st.ai_model ?? null, st.ai_prompt ?? null,
        st.ai_max_words ?? null, st.ai_language ?? null,
      ];
      let id = st.id;
      if (id && existingIds.has(id)) {
        db.prepare(
          `UPDATE workflow_steps SET step_type = ?, track = ?, template_id = ?, delay_seconds = ?,
             connect_note = ?, message_body = ?, email_subject = ?, email_body = ?, email_signature = ?,
             email_position = ?, message_position = ?, ai_enabled = ?, ai_model = ?, ai_prompt = ?,
             ai_max_words = ?, ai_language = ?, step_order = ?
           WHERE id = ? AND workflow_id = ?`
        ).run(...vals, step_order, id, workflowId);
        result.push({ id, created: false });
      } else {
        id = randomUUID();
        db.prepare(
          `INSERT INTO workflow_steps (id, workflow_id, step_type, track, template_id, delay_seconds,
             connect_note, message_body, email_subject, email_body, email_signature, email_position,
             message_position, ai_enabled, ai_model, ai_prompt, ai_max_words, ai_language, step_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, workflowId, ...vals, step_order);
        result.push({ id, created: true });
      }
      keptIds.add(id);

      db.prepare("DELETE FROM workflow_step_templates WHERE step_id = ?").run(id);
      if (Array.isArray(st.template_ids)) {
        const link = db.prepare("INSERT OR IGNORE INTO workflow_step_templates (step_id, template_id) VALUES (?, ?)");
        for (const tid of st.template_ids) link.run(id, tid);
      }
    }

    for (const row of existing) {
      if (!keptIds.has(row.id)) db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(row.id);
    }
  })();

  return res.json({ ok: true, steps: result, kept: result.filter(r => !r.created).length, created: result.filter(r => r.created).length });
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();
  const workflowId = req.query.id as string;

  if (req.method === "GET") {
    const steps = db
      .prepare(
        `SELECT ws.*, t.name as template_name
         FROM workflow_steps ws
         LEFT JOIN templates t ON t.id = ws.template_id
         WHERE ws.workflow_id = ?
         ORDER BY ws.track, ws.step_order`
      )
      .all(workflowId);

    // Attach multi-template ids to each step
    const getTemplateIds = db.prepare(
      `SELECT wst.template_id, t.name
       FROM workflow_step_templates wst
       JOIN templates t ON t.id = wst.template_id
       WHERE wst.step_id = ?`
    );
    const stepsWithTemplates = (steps as Array<Record<string, unknown>>).map((s) => ({
      ...s,
      template_ids: (getTemplateIds.all(s.id) as Array<{ template_id: string; name: string }>).map((r) => r.template_id),
      template_names: (getTemplateIds.all(s.id) as Array<{ template_id: string; name: string }>).map((r) => r.name),
    }));

    return res.json(stepsWithTemplates);
  }

  if (req.method === "PUT") {
    return handlePut(db, workflowId, req, res);
  }

  if (req.method === "POST") {
    // D-1: the old per-step routes stay (removing them is a contract change), but
    // they get the same live-run guard as PUT. Without it, the safe path is
    // guarded and the legacy path next to it is not.
    const live = db.prepare("SELECT COUNT(*) n FROM runs WHERE workflow_id = ? AND status = 'running'").get(workflowId) as { n: number };
    if (live.n > 0) return res.status(409).json({ error: "This workflow has a running run. Pause it before editing steps.", running_runs: live.n });

    const { step_type, track: trackIn, template_id, template_ids, delay_seconds, connect_note, message_body, email_subject, email_body, email_signature, email_position, message_position, ai_enabled, ai_model, ai_prompt, ai_max_words, ai_language } = req.body;
    if (!step_type) return res.status(400).json({ error: "step_type required" });

    // Auto-assign track: email step_type always goes on the email track; everything else linkedin
    const track: "linkedin" | "email" = trackIn === "email" || step_type === "email" ? "email" : "linkedin";

    const maxRow = db
      .prepare("SELECT MAX(step_order) as max_order FROM workflow_steps WHERE workflow_id = ? AND track = ?")
      .get(workflowId, track) as { max_order: number | null };
    const nextOrder = (maxRow.max_order ?? 0) + 1;

    const id = randomUUID();
    db.prepare(
      "INSERT INTO workflow_steps (id, workflow_id, step_order, track, step_type, template_id, delay_seconds, connect_note, message_body, email_subject, email_body, email_signature, email_position, message_position, ai_enabled, ai_model, ai_prompt, ai_max_words, ai_language) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, workflowId, nextOrder, track, step_type, template_id ?? null, delay_seconds ?? 0, connect_note ?? null, message_body ?? null, email_subject ?? null, email_body ?? null, email_signature !== undefined ? email_signature : null, email_position ?? 1, message_position ?? 1, ai_enabled ?? 0, ai_model ?? null, ai_prompt ?? null, ai_max_words ?? null, ai_language ?? null);

    // Insert multi-template associations
    if (Array.isArray(template_ids) && template_ids.length > 0) {
      const insertLink = db.prepare(
        "INSERT OR IGNORE INTO workflow_step_templates (step_id, template_id) VALUES (?, ?)"
      );
      for (const tid of template_ids) {
        insertLink.run(id, tid);
      }
    }

    return res.status(201).json({ id });
  }

  methodNotAllowed(res, ["GET", "POST", "PUT"]);
}
