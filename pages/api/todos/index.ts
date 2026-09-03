import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";

/**
 * Phase 1a: the contact page (pages/contacts/[id].tsx) does full CRUD on
 * todos, but no route existed — every save 404'd. Tables have existed since
 * the CRM migration; only the HTTP surface was missing.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const { target_id, title, description, due_date } = req.body as {
    target_id?: string; title?: string; description?: string | null; due_date?: string | null;
  };
  if (!target_id || !title?.trim()) {
    return res.status(400).json({ error: "target_id and title are required" });
  }

  const db = getDb();
  const target = db.prepare("SELECT id FROM targets WHERE id = ?").get(target_id);
  if (!target) return res.status(404).json({ error: "Target not found" });

  const id = randomUUID();
  db.prepare(
    "INSERT INTO todos (id, target_id, title, description, due_date) VALUES (?, ?, ?, ?, ?)"
  ).run(id, target_id, title.trim(), description ?? null, due_date ?? null);
  return res.status(201).json(db.prepare("SELECT * FROM todos WHERE id = ?").get(id));
}
