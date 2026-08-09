import type { Page } from "playwright";
import { findTopCard, hasFirstDegreeBadge } from "./connect";

/**
 * Visits a LinkedIn profile page. This registers as a profile view on LinkedIn.
 * Navigates and waits, then reports whether the page shows a 1st-degree badge —
 * lets the runner backfill degree=1 for contacts that were already connected
 * before Linki ever sent them a connection request (e.g. manually added leads).
 *
 * Degree signal: the visible 1st-degree badge on the person's own card, via
 * connect.ts's hasFirstDegreeBadge(). The Message link is NOT a degree signal —
 * a confirmed non-connection and a confirmed 1st-degree connection both render
 * /messaging/compose links carrying profileUrn (verified live Aug 2026).
 *
 * MUST be scoped to the visited person's own intro/top card — a page-wide
 * search also matches "Message" links belonging to OTHER people rendered
 * elsewhere on the page (sidebar modules like "People also viewed" / suggested
 * connections). For a non-connected target, THEIR page has no such link, but
 * the sidebar still does — a page-wide `.first()` silently grabbed a random
 * unrelated 1st-degree connection's link, wrongly marked the target degree=1,
 * and stored that stranger's messaging URN, causing messages to go to the
 * wrong person entirely (incident: Jul 2026, see CLAUDE.md/memory). The top
 * card is resolved by connect.ts's findTopCard(), which identifies it
 * structurally on both the current SDUI and legacy layouts and is robust to
 * LinkedIn's class-name hashing.
 *
 * The Message link's href carries the messaging URN (urn:li:fsd_profile:ACoAA...)
 * used to address a message. It answers "who do we send to?", never "are we
 * connected?" — so it is returned only once the badge has established the
 * connection. See lib/linkedin/message.ts.
 */
/**
 * What the visit actually established about the connection.
 *
 * The two negative states are NOT interchangeable, which is the whole reason
 * this type exists. A plain `isFirstDegree: false` conflated "we looked and
 * they are not connected" with "we could not look at all" — so the visit step
 * could neither trust nor clear a stored degree=1 without risking erasing a
 * correct one on a transient render failure or an auth wall.
 *
 *  - "first_degree"     — the person's own card shows the visible 1st badge.
 *  - "not_first_degree" — the card WAS inspected and shows no such badge.
 *  - "inconclusive"     — the card could not be found, so nothing was observed.
 *                         Absence of evidence, never evidence of absence: only
 *                         "not_first_degree" may clear a stored degree.
 */
export type DegreeObservation = "first_degree" | "not_first_degree" | "inconclusive";

export interface VisitResult {
  degree: DegreeObservation;
  /**
   * Kept so every existing caller — message.ts above all — keeps working
   * unchanged, and keeps failing CLOSED: it is true ONLY for "first_degree",
   * so both negative states still refuse to authorize a message.
   */
  isFirstDegree: boolean;
  messagingUrn: string | null;
}

export async function visitProfile(page: Page, linkedinUrl: string): Promise<VisitResult> {
  await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000 + Math.random() * 2000);

  // Shared with connect.ts rather than re-declared: the <h1>-anchored locator
  // this used to inline matches NOTHING on LinkedIn's current SDUI layout,
  // where the name is an <h2> and the card is keyed by componentkey. That made
  // every check below degrade silently to "not connected" — a connected target
  // was reported as 1st-degree=false, which surfaced as a false NotConnectedError
  // in sendMessage() (verified live Aug 2026). findTopCard() handles both
  // layouts, so the two modules can no longer drift apart.
  const topCard = await findTopCard(page);
  // No card = nothing was inspected. Report it as such rather than as a
  // negative: the card can be missing because the page is still rendering,
  // because LinkedIn shipped a third layout, because the profile 404'd, or
  // because we were served a login/authwall page (see the note at the bottom
  // of this file). None of those are "not connected".
  if (!topCard) return { degree: "inconclusive", isFirstDegree: false, messagingUrn: null };

  const messageLink = topCard.locator('a[href*="/messaging/compose"]').first();
  const messageHref = (await messageLink.count()) > 0 ? await messageLink.getAttribute("href").catch(() => null) : null;
  const urnMatch = messageHref?.match(/profileUrn=([^&]+)/);
  const composeUrn = urnMatch ? decodeURIComponent(urnMatch[1]) : null;

  // Connection status comes from the explicit degree badge on the person's own
  // card — NEVER from the Message button or its href.
  //
  // Verified live Aug 2026: /in/raise-faster/ (NOT connected) and
  // /in/demo-investor-4aa78a428/ (confirmed 1st degree) both render
  // `/messaging/compose/?profileUrn=…&screenContext=NON_SELF_PROFILE_VIEW`.
  // The links are structurally identical, so neither the link nor profileUrn
  // can distinguish them. Reading the link as proof marked a stranger
  // 1st-degree, which stamped degree=1 and skipped a real invitation.
  // Same contract as connect.ts: a visible, element-level degree badge — never
  // the card's prose, which routinely contains "1st" for unrelated reasons.
  //
  // A rejection here (detached DOM, closed page) propagates deliberately. The
  // card was found but could not be read, so the observation is unknown — and
  // an exception reaches the runner's catch-all, which fails the track without
  // ever writing a degree. Swallowing it into "not_first_degree" would let a
  // torn-down page erase a correct connection.
  const isFirstDegree = await hasFirstDegreeBadge(topCard);

  // The URN is only meaningful once the connection itself is established; it is
  // the addressing handle for messaging, not evidence of the relationship.
  return {
    degree: isFirstDegree ? "first_degree" : "not_first_degree",
    isFirstDegree,
    messagingUrn: isFirstDegree ? composeUrn : null,
  };
}

// KNOWN GAP, deliberately not fixed here (reported separately): the goto above
// is a raw page.goto, while every LinkedIn navigation in connect.ts goes through
// gotoAuthenticated(), which polls the login interstitial and raises
// SessionExpiredError on an authwall. So an expired session renders a wall, no
// top card is found, and this returns "inconclusive" — safe by construction
// now, where the old boolean reported a confident "not first degree". Routing
// this through gotoAuthenticated() would turn that case into an explicit error
// instead, which is strictly better but is a navigation change, not part of the
// three-state result.
