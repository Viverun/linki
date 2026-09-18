import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { withBrowserOwner, BrowserBusyError } from "@/lib/linkedin/ownership";

// POST /api/lists/[id]/sync-status  body: { account_id: number }
// Re-fetches the Sales Nav list and updates degree for non-connected targets.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const db = getDb();
  const listId = req.query.id as string;

  const list = db.prepare("SELECT * FROM lists WHERE id = ?").get(listId) as
    | { sales_nav_url?: string }
    | undefined;
  if (!list) return res.status(404).json({ error: "List not found" });
  if (!list.sales_nav_url) return res.status(400).json({ error: "No Sales Navigator URL saved for this list — run an import first" });

  const { account_id } = req.body as { account_id: string };
  if (!account_id) return res.status(400).json({ error: "account_id required" });

  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(account_id) as
    | { cookies_json: string | null; is_authenticated: number }
    | undefined;
  // Phase 2: missing account is a 404; a present-but-unauthenticated
  // account stays a 400 (same split as enrich.ts/import.ts).
  if (!account) return res.status(404).json({ error: "Account not found" });
  if (!account.is_authenticated) return res.status(400).json({ error: "Account not authenticated" });

  const { scrapeNavigatorList } = await import("@/lib/linkedin/scraper");

  try {
    const { profiles } = await withBrowserOwner(account_id, "sync-status", { maxHoldMs: 600_000, waitMs: 30_000 }, (o) =>
      scrapeNavigatorList(o, list.sales_nav_url!, { maxPages: 300 })
    );

    const updateDegree = db.prepare("UPDATE targets SET degree = ? WHERE linkedin_url = ?");
    const markConnected = db.prepare(
      `UPDATE targets SET degree = ?, connected_at = CASE
         WHEN (degree IS NULL OR degree != 1) AND connected_at IS NULL THEN datetime('now')
         ELSE connected_at
       END
       WHERE linkedin_url = ?`
    );

    let updated = 0;
    db.transaction(() => {
      for (const p of profiles) {
        if (p.degree === 1) {
          markConnected.run(p.degree, p.salesNavUrl);
        } else {
          updateDegree.run(p.degree, p.salesNavUrl);
        }
        updated++;
      }
    })();

    return res.json({ updated, total: profiles.length });
  } catch (err: unknown) {
    if (err instanceof BrowserBusyError) return res.status(409).json({ error: "browser_busy", held_by: err.heldBy });
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: message });
  }
}

export const config = {
  api: { responseLimit: false },
};
