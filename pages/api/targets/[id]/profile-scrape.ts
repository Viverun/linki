import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { InvalidSalesNavUrlError, ProfileNavigationError, scrapeProfile } from "@/lib/linkedin/profile-scrape";
import { isAllowedSalesNavLeadUrl } from "@/lib/linkedin-url";
import { resolveLinkedInAccount } from "@/lib/linkedin/resolve-account";
import { withBrowserOwner, BrowserBusyError } from "@/lib/linkedin/ownership";

// POST /api/targets/[id]/profile-scrape
// Live-scrapes a lead's LinkedIn profile (Sales Nav career + recent posts) and
// returns clean structured JSON. Read-only on LinkedIn's side; does not persist.
// Account auto-resolved (explicit account_id → contact's last run → sole account).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const db = getDb();
  const id = req.query.id as string;
  const target = db.prepare(
    "SELECT id, full_name, linkedin_url, sales_nav_url FROM targets WHERE id = ?"
  ).get(id) as { id: string; full_name: string | null; linkedin_url: string | null; sales_nav_url: string | null } | undefined;

  if (!target) return res.status(404).json({ error: "Contact not found" });
  if (!target.sales_nav_url) {
    return res.status(400).json({ error: "Contact has no Sales Navigator URL — re-import the list to capture it." });
  }

  if (!isAllowedSalesNavLeadUrl(target.sales_nav_url)) {
    return res.status(400).json({ error: new InvalidSalesNavUrlError().message });
  }

  const account = resolveLinkedInAccount(db, id, req.body?.account_id);
  if (!account) return res.status(400).json({ error: "No authenticated LinkedIn account could be resolved." });

  try {
    const profile = await withBrowserOwner(account.id, "profile-scrape", { maxHoldMs: 600_000, waitMs: 30_000 }, (o) => scrapeProfile(o.context, target));

    // Persist what we scraped so it isn't thrown away: posts + the career fields
    // we already have columns for (headline/summary/positions). Cheap and lets the
    // runner's AI writer reuse it without re-scraping.
    db.prepare(`
      UPDATE targets SET
        posts_json       = CASE WHEN ? IS NOT NULL THEN ? ELSE posts_json END,
        posts_scraped_at = datetime('now'),
        headline         = COALESCE(?, headline),
        summary          = COALESCE(?, summary),
        positions_json   = CASE WHEN ? IS NOT NULL THEN ? ELSE positions_json END
      WHERE id = ?
    `).run(
      profile.recent_posts.length ? "1" : null,
      profile.recent_posts.length ? JSON.stringify(profile.recent_posts) : null,
      profile.headline,
      profile.summary,
      profile.positions.length ? "1" : null,
      profile.positions.length ? JSON.stringify(profile.positions) : null,
      id
    );

    return res.json({ contact_id: id, account_id: account.id, profile });
  } catch (err) {
    if (err instanceof BrowserBusyError) return res.status(409).json({ error: "browser_busy", held_by: err.heldBy });
    if (err instanceof InvalidSalesNavUrlError) return res.status(400).json({ error: err.message });
    if (err instanceof ProfileNavigationError) return res.status(502).json({ error: err.message });
    const message = err instanceof Error ? err.message : String(err);
    // A dead session surfaces as "No data intercepted" / re-auth — flag it so the runner stops.
    if (/re-authentication|No data intercepted|login|checkpoint/i.test(message)) {
      try {
        const { markNeedsReauth } = await import("@/lib/linkedin/session");
        await markNeedsReauth(account.id);
      } catch { /* ignore */ }
      return res.status(502).json({ error: `LinkedIn session needs re-authentication: ${message}` });
    }
    return res.status(500).json({ error: message });
  }
}
