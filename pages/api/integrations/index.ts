import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();

  if (req.method === "GET") {
    const rows = db.prepare("SELECT key, api_key, updated_at FROM integrations").all() as {
      key: string;
      api_key: string | null;
      updated_at: string;
    }[];
    const masked = rows.map((r) => {
      const plain = decryptSecret(r.api_key);
      return {
        key: r.key,
        updated_at: r.updated_at,
        api_key_masked: plain ? "••••••••" + plain.slice(-4) : null,
        configured: !!plain,
      };
    });
    return res.json(masked);
  }

  if (req.method === "POST") {
    const { key, api_key } = req.body;
    if (!key) return res.status(400).json({ error: "key required" });
    if (!api_key) return res.status(400).json({ error: "api_key required" });
    // Phase 5: keys become column values and masked labels — keep them short
    // slugs rather than arbitrary strings. (A closed allowlist would freeze
    // out future ee/ keys; the readers only ever look up 'apollo'/'openrouter'.)
    if (typeof key !== "string" || !/^[a-z0-9_-]{1,32}$/.test(key)) {
      return res.status(400).json({ error: "key must be a short slug: [a-z0-9_-], max 32 chars" });
    }
    db.prepare(`
      INSERT INTO integrations (key, api_key, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at
    `).run(key, encryptSecret(api_key));
    return res.json({ ok: true });
  }

  if (req.method === "DELETE") {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: "key required" });
    db.prepare("DELETE FROM integrations WHERE key = ?").run(key);
    return res.json({ ok: true });
  }

  res.setHeader("Allow", ["GET", "POST", "DELETE"]);
  res.status(405).end();
}
