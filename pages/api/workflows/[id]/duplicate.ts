import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import { methodNotAllowed } from "@/lib/api-validate";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const db = getDb();
  const sourceId = req.query.id as string;

  const source = db.prepare("SELECT * FROM workflows WHERE id = ?").get(sourceId) as
    | { id: string; name: string; description: string | null; prompt: string | null }
    | undefined;
  if (!source) return res.status(404).json({ error: "Workflow not found" });

  const newId = randomUUID();
  // Phase 1b: the copy used to drop the campaign prompt (and the step track,
  // signature and enabled flag below) — a duplicate must duplicate.
  const copy = db.transaction(() => {
    db.prepare("INSERT INTO workflows (id, name, description, prompt) VALUES (?, ?, ?, ?)").run(
      newId,
      `${source.name} (copy)`,
      source.description ?? null,
      source.prompt ?? null
    );

  const steps = db
    .prepare("SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step_order")
    .all(sourceId) as Array<Record<string, unknown>>;

  const getTemplateIds = db.prepare(
    "SELECT template_id FROM workflow_step_templates WHERE step_id = ?"
  );
  const insertStep = db.prepare(
    `INSERT INTO workflow_steps
       (id, workflow_id, step_order, step_type, track, template_id, delay_seconds,
        connect_note, message_body, email_subject, email_body, email_signature,
        email_position, message_position, enabled,
        ai_enabled, ai_model, ai_prompt, ai_max_words, ai_language)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertLink = db.prepare(
    "INSERT OR IGNORE INTO workflow_step_templates (step_id, template_id) VALUES (?, ?)"
  );

  for (const s of steps) {
    const newStepId = randomUUID();
    insertStep.run(
      newStepId, newId, s.step_order, s.step_type,
      s.track ?? "linkedin",
      s.template_id ?? null, s.delay_seconds ?? 0,
      s.connect_note ?? null, s.message_body ?? null,
      s.email_subject ?? null, s.email_body ?? null, s.email_signature ?? null,
      s.email_position ?? 1, s.message_position ?? 1, s.enabled ?? 1,
      s.ai_enabled ?? 0, s.ai_model ?? null,
      s.ai_prompt ?? null, s.ai_max_words ?? null,
      s.ai_language ?? null
    );
    const links = getTemplateIds.all(s.id) as Array<{ template_id: string }>;
    for (const { template_id } of links) {
      insertLink.run(newStepId, template_id);
    }
  }
  });

  copy();

  return res.status(201).json({ id: newId });
}
