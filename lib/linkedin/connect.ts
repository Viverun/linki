import type { Locator, Page } from "playwright";
import { scrapePendingInvitationVanityNames } from "./pending-invitations";

export class WeeklyLimitError extends Error {}
export class AlreadyConnectedError extends Error {}
export class PendingInviteError extends Error {}
/** The invitation UI could not be reached/completed — nothing was sent. */
export class InviteUiError extends Error {}
/** Send was clicked but LinkedIn never showed the invitation as sent. */
export class InviteNotSentError extends Error {}
/** The stored session is no longer signed in — LinkedIn served login/authwall. */
export class SessionExpiredError extends Error {}

// LinkedIn bounces un/half-authenticated navigations through these. Landing
// here is NOT a transient render delay — it means the page we're looking at is
// not the app, so no selector on it means anything.
//
// The two kinds behave differently and must not be conflated:
//  - the login interstitial self-clears (see settleAuthRedirect), so it's polled;
//  - an authwall/checkpoint never self-clears, so polling it just burns 45s per
//    target. It fails fast instead.
const LOGIN_INTERSTITIAL_RE = /\/(uas\/)?login\b/;
const HARD_WALL_RE = /\/authwall\b|\/checkpoint\//;
const AUTH_WALL_URL_RE = new RegExp(`${LOGIN_INTERSTITIAL_RE.source}|${HARD_WALL_RE.source}`);

// The person's own primary CTA. Semantic on both counts: the accessible name
// ("Invite <Name> to connect") and the href's vanityName both identify WHO the
// button acts on, so neither depends on LinkedIn's hashed CSS classes.
const CONNECT_CTA = 'a[aria-label*="to connect"], button[aria-label*="to connect"], a[href*="custom-invite"]';

// Invite modal. Confirmed live (Aug 2026): <div role="dialog" class="… send-invite"
// aria-labelledby="send-invite-modal"> with an actionbar holding
// <button aria-label="Add a note"> and <button aria-label="Send without a note">.
const INVITE_DIALOG = '[role="dialog"]:visible, dialog[open]';

// The profile card's overflow button. Scoped to the top card by the caller, so
// it can never resolve to the nav bar's, a post's, or a recommendation's.
const MORE_BUTTON = 'button[aria-label="More"], button[aria-label^="More actions"]';
const OPEN_MENU = '[role="menu"]:visible';

// The 1st-degree badge, as it actually exists (verified live Aug 2026).
//
// A connected card renders the degree as its OWN element — <p>· 1st</p> — while
// a non-connected card has no degree element at all. LinkedIn also ships hidden
// variants: the connected specimen carried <p>· 2nd</p> hidden beside the
// visible <p>· 1st</p>, so visibility is part of the contract.
//
// Matching must be element-level and anchored. The previous /\b1st\b/ over the
// whole card's innerText also matched ordinary profile prose — "Partner at 1st
// Round Capital", "1st Lieutenant", "Ranked 1st in EMEA" — any of which would
// have marked a stranger connected, skipped their invitation, and (via the
// runner's degree=1 stamp) authorised a message to them.
//
// There is no semantic hook to use instead: the badge carries no role, no
// aria-label, no data-* and no componentkey, and its classes are hashed.
const DEGREE_BADGE = "p:visible";
const RE_FIRST_DEGREE = /^·?\s*1st$/;

/** True only when the person's own card shows a visible 1st-degree badge. */
export async function hasFirstDegreeBadge(topCard: Locator | null): Promise<boolean> {
  if (!topCard) return false;
  return (await topCard.locator(DEGREE_BADGE).filter({ hasText: RE_FIRST_DEGREE }).count()) > 0;
}

// Pending affordance on the person's own card. Scoped by the caller — page-wide
// it also matches sidebar modules belonging to other people.
const PENDING_IN_CARD = '[aria-label*="Pending"], button[aria-label*="Pending"]';

// More-menu items, matched SEMANTICALLY. Observed live Aug 2026: every item has
// aria-label=null and its label nested in a child <div>, so `:text-is("Connect")`
// and getByRole(name) both match nothing, while `:has-text("Connect")` is a
// substring and also matches "Remove connection" / "Connections".
//
// The Connect item is an anchor carrying the invitation href, which names the
// target: /preload/custom-invite/?vanityName=<vanity>. That is target-specific
// and language-independent, so it is the primary selector.
const menuConnectFor = (vanity: string) =>
  `a[role="menuitem"][href*="custom-invite"][href*="vanityName=${vanity}"]`;
// Fallback discriminators. componentkey is semantic; the anchored text regexes
// are a documented last resort for items with neither href nor componentkey,
// and are anchored so "Remove connection"/"Connections" can never match.
const MENU_PENDING_KEY = '[role="menuitem"][componentkey$="_pending"]';
const MENU_ITEM = '[role="menuitem"]';
const RE_PENDING = /^Pending$/i;
const RE_REMOVE_CONNECTION = /^Remove connection$/i;
const SEND_BUTTON =
  'button[aria-label*="Send without"], button[aria-label*="Send invitation"]:not([aria-label*="note"]), button:has-text("Send now"), button:has-text("Send without a note")';

/** `jamil-khan-55a621346` from any form of profile URL. */
export function vanityNameOf(linkedinUrl: string): string | null {
  return linkedinUrl.match(/\/in\/([^/?#]+)/)?.[1]?.toLowerCase() ?? null;
}

/**
 * LinkedIn re-mints an expired `li_at` from the `li_rm` remember-me cookie via
 * an interstitial ("We're signing you in") that self-redirects back to the
 * requested page after a few seconds. Wait that out rather than reading the
 * login page's DOM. Returns false if we're still stuck on login/authwall.
 */
const AUTH_POLL_MS = 1500;
async function settleAuthRedirect(page: Page, timeoutMs = 45000): Promise<boolean> {
  // Paced by page.waitForTimeout rather than wall-clock so the loop is driven
  // by the page, not by Date.now().
  for (let i = 0; i < Math.ceil(timeoutMs / AUTH_POLL_MS); i++) {
    const url = page.url();
    if (HARD_WALL_RE.test(url)) return false; // never self-clears — don't wait it out
    if (!LOGIN_INTERSTITIAL_RE.test(url)) return true;
    await page.waitForTimeout(AUTH_POLL_MS);
  }
  return !AUTH_WALL_URL_RE.test(page.url());
}

export async function gotoAuthenticated(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // The bounce to /authwall is issued client-side, AFTER domcontentloaded — so
  // checking the URL only once, right after goto(), still sees the requested
  // page and waves the redirect through. Settle, give the redirect a moment to
  // fire, then confirm we really are on the app.
  let onApp = await settleAuthRedirect(page);
  if (onApp) {
    await page.waitForTimeout(2500);
    onApp = await settleAuthRedirect(page);
  }

  if (!onApp) {
    throw new SessionExpiredError(
      `LinkedIn served a login/authwall page instead of ${url} (stuck at ${page.url()}) — the account session needs re-authentication`
    );
  }
}

/**
 * The visited person's OWN intro/top card.
 *
 * Everything read for already-connected / pending detection MUST be scoped
 * here: a page-wide search also matches "Message" links and "1st" badges
 * belonging to OTHER people rendered elsewhere on the page (sidebar modules
 * like "People also viewed"). For a non-connected target that false-positived
 * AlreadyConnected, which skipped the real invite AND (via the message step
 * that follows) sent a message to a random unrelated 1st-degree connection
 * instead of the target — see CLAUDE.md / memory for the Jul 2026 incident.
 *
 * Two layouts are live in the wild, tried in order:
 *  - Current SDUI layout: the card carries componentkey="…<profileId>Topcard".
 *    This layout has NO <h1> at all (the name is an <h2>), which is why the
 *    old <h1>-anchored locator silently matched nothing on it.
 *  - Legacy layout: the section containing the page's own <h1> name heading.
 * Both are structural/attribute-based, so they survive class-name hashing.
 */
export async function findTopCard(page: Page): Promise<Locator | null> {
  const candidates = [
    page.locator('[componentkey$="Topcard"]').first(),
    page.locator("main section").filter({ has: page.locator("h1") }).first(),
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0) return candidate;
  }
  return null;
}

/**
 * The target's own Connect link, identified by the vanityName in its href
 * rather than by position in the DOM. Sidebar recommendation cards render the
 * same markup for OTHER people, but always with THEIR vanityName, so this
 * cannot pick up a stranger's CTA the way a positional `.first()` can.
 */
function ownConnectLink(page: Page, vanity: string): Locator {
  return page.locator(`a[href*="custom-invite"][href*="vanityName=${vanity}"]`).first();
}

/**
 * Throws if LinkedIn already considers this person connected or invited.
 *
 * A Connect CTA on the person's own card is positive proof from LinkedIn that
 * they are neither — so it short-circuits the weaker heuristics below. That
 * ordering matters: on the current layout the top card renders a
 * `/messaging/compose` link even for a NON-connection (verified live Aug 2026
 * against a 3rd-degree target that simultaneously offered "Connect"), so
 * treating that link alone as "already connected" would false-positive exactly
 * the way the Jul 2026 incident did.
 */
export async function assertConnectable(page: Page, topCard: Locator | null, vanity: string | null): Promise<void> {
  const cardText = topCard ? await topCard.innerText().catch(() => "") : "";

  // 1. Pending first — it must win over weaker signals. Scoped to the target's
  //    own card: a page-wide [aria-label*="Pending"] also matches sidebar
  //    modules for other people.
  if (/\bPending\b/.test(cardText)) throw new PendingInviteError("Invitation already pending");
  if (topCard && (await topCard.locator(PENDING_IN_CARD).count()) > 0) {
    throw new PendingInviteError("Invitation already pending");
  }

  // 2. A Connect affordance on the person's own card is positive proof from
  //    LinkedIn that they are neither connected nor invited.
  if (vanity && (await ownConnectLink(page, vanity).count()) > 0) return;
  if (topCard && (await topCard.locator(CONNECT_CTA).count()) > 0) return;

  // 3. The explicit degree badge is the only card-level connection signal.
  //
  //    A Message button / /messaging/compose link — with or without profileUrn —
  //    is NOT evidence of a connection. Verified live Aug 2026: /in/raise-faster/
  //    (NOT connected) and /in/demo-investor-4aa78a428/ (confirmed 1st degree)
  //    both expose `profileUrn=…&screenContext=NON_SELF_PROFILE_VIEW` compose
  //    links that are structurally identical. Treating that as proof stamped
  //    degree=1 on a stranger and skipped a real invitation.
  if (await hasFirstDegreeBadge(topCard)) throw new AlreadyConnectedError("Already connected");

  // 4. Otherwise the card is inconclusive (Follow-primary layouts hide Connect
  //    in the More menu). Return and let openInviteDialog() decide from the
  //    menu, which carries explicit Connect / Pending / Remove connection items.
}

/** Weekly-limit popup and LinkedIn error toasts — checked before claiming success. */
async function assertNoLinkedInError(page: Page): Promise<void> {
  const limitPopup = page.locator('div[class*="ip-fuse-limit-alert__warning"]');
  if ((await limitPopup.count()) > 0) throw new WeeklyLimitError("Weekly connection limit reached");

  const errorToast = page.locator('div[data-test-artdeco-toast-item-type="error"]:visible');
  if ((await errorToast.count()) > 0) {
    const msg = await errorToast.innerText();
    throw new Error(`Connection error: ${msg.trim()}`);
  }
}

/**
 * Opens the invitation modal and returns its Send button, waiting for it to
 * actually appear. Throws — never returns a not-found — so a missing button
 * can't be mistaken for a completed send.
 */
export async function openInviteDialog(page: Page, linkedinUrl: string, vanity: string | null): Promise<Locator> {
  // Case 1: direct Connect link (primary CTA) — navigate to its href.
  // Clicking it does NOT open the modal: the Sales Nav overlay SVG intercepts
  // pointer events, and even a forced click is a no-op on this layout
  // (verified Aug 2026 — force-click succeeded, no dialog appeared). The href
  // navigation is the working path and is deliberately kept.
  const directConnect = vanity
    ? ownConnectLink(page, vanity)
    : page.locator('a[aria-label*="Invite"][aria-label*="to connect"]:visible, a[href*="custom-invite"]:visible').first();

  if ((await directConnect.count()) > 0) {
    // Click the real CTA so LinkedIn's own SPA opens the invite modal.
    //
    // The click is intercepted unless the CTA is scrolled clear of the sticky
    // global nav first: Playwright scrolls the element into view, which can
    // leave it underneath the header, and the hit test then resolves to the
    // nav's "For Business" button instead (verified live Aug 2026 — the click
    // times out after 10s of retries, never dispatching). Centring the element
    // in the viewport moves it out from under the header.
    await directConnect.evaluate(el => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);

    // force: true is what makes the centring stick. Playwright's normal click
    // re-runs its own scroll-into-view before every retry, which puts the CTA
    // back under the header and re-fails the hit test — verified Aug 2026: 20
    // retries, the same "For Business" interception each time. force skips that
    // retry/hit-test loop and dispatches at the element's own coordinates,
    // which the centring above has already moved clear of the sticky nav.
    let modalOpened = false;
    console.log("[invite-debug] attempting in-page Connect click");
    try {
      await directConnect.click({ force: true, timeout: 10000 });
      await page.locator(INVITE_DIALOG).first().waitFor({ state: "visible", timeout: 10000 });
      modalOpened = true;
      console.log("[invite-debug] SPA invite modal opened");
    } catch (err) {
      console.log("[invite-debug] in-page Connect click failed");
      console.log(`[invite-debug] error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!modalOpened) {
      // The in-page Connect click is attempted first. If it does not open the
      // SPA invite dialog, fall back to the target's own
      // /preload/custom-invite/ URL, taken from the CTA's href.
      //
      // Retained as a working compatibility fallback: an invitation sent via
      // this path was confirmed to become pending by verifyInvitationSent(),
      // which remains the arbiter either way. (An earlier comment here claimed
      // this route's Send button was inert and created nothing — that is
      // contradicted by the verified send and has been removed.)
      console.log("[invite-debug] falling back to preload invite URL");
      const href = await directConnect.getAttribute("href");
      if (!href) throw new InviteUiError("Connect link has no href");
      await gotoAuthenticated(page, href.startsWith("http") ? href : `https://www.linkedin.com${href}`);
    }
  } else {
    // Case 2: Connect is inside the profile's "…More" menu — the Follow-primary
    // (creator) layout, where the card offers Follow + Message and no Connect.
    //
    // The More button is resolved from the person's OWN top card. The previous
    // `button[aria-label="More"]:visible'.nth(1)` assumed exactly two on the
    // page (nav = 0, profile = 1); posts and recommendation cards each add one,
    // so that index silently opened somebody else's menu.
    const topCard = await findTopCard(page);
    const moreBtn = topCard ? topCard.locator(MORE_BUTTON).first() : null;
    if (!moreBtn || (await moreBtn.count()) === 0) {
      throw new InviteUiError(
        `No Connect link and no More button on the profile card at ${page.url()} — cannot open the invitation UI for ${linkedinUrl}`
      );
    }

    // Read aria-controls BEFORE clicking: it names the menu this button owns,
    // which is what lets us scope the item lookup instead of guessing among
    // whatever menus happen to be open elsewhere on the page.
    const menuId = await moreBtn.getAttribute("aria-controls").catch(() => null);
    await moreBtn.click({ timeout: 10000 });
    await page.waitForTimeout(800);

    const menu = menuId ? page.locator(`#${menuId}`) : page.locator(OPEN_MENU);
    const menuCount = await menu.count();
    if (menuCount === 0) {
      throw new InviteUiError(`The profile More menu did not open at ${page.url()} — invitation not sent`);
    }
    if (!menuId && menuCount > 1) {
      // Several menus are open and the button names none of them; picking one
      // would be a coin flip, and the wrong pick acts on another person.
      throw new InviteUiError(
        `Ambiguous More menu at ${page.url()} (${menuCount} open, no aria-controls) — refusing to guess`
      );
    }
    const openMenu = menu.first();

    const items = openMenu.locator(MENU_ITEM);

    // Pending first.
    if ((await openMenu.locator(MENU_PENDING_KEY).count()) > 0 ||
        (await items.filter({ hasText: RE_PENDING }).count()) > 0) {
      throw new PendingInviteError("Invitation already pending (found in More menu)");
    }

    // "Remove connection" is offered ONLY for an existing 1st-degree connection,
    // so its presence is independent evidence of one. It is also the item a
    // substring match on "Connect" would hit — clicking it would destroy the
    // relationship. Detect it explicitly, throw, and click nothing.
    if ((await items.filter({ hasText: RE_REMOVE_CONNECTION }).count()) > 0) {
      throw new AlreadyConnectedError("Already connected (Remove connection offered in More menu)");
    }

    // Connect is matched by the invitation href, which names THIS target — a
    // stranger's Connect item in the same menu carries their vanityName and so
    // cannot match. Without a vanity there is nothing to bind to, and guessing
    // is exactly how the wrong person gets invited.
    if (!vanity) {
      throw new InviteUiError(`Cannot resolve a target vanity for ${linkedinUrl} — refusing to pick a Connect item`);
    }
    const connectOption = openMenu.locator(menuConnectFor(vanity));
    if ((await connectOption.count()) === 0) {
      throw new InviteUiError(
        `The profile More menu offers no Connect action for ${vanity} at ${page.url()} — invitation not sent`
      );
    }
    await connectOption.first().click();
  }

  // Wait for the Send button instead of sleeping a fixed 1s and hoping. The
  // fixed wait is what made this fail silently: any slower-than-1s render (or
  // an auth bounce) left count()===0 and the old code just returned "success".
  const sendBtn = page.locator(SEND_BUTTON).first();
  try {
    await sendBtn.waitFor({ state: "visible", timeout: 20000 });
  } catch {
    await assertNoLinkedInError(page);

    // Some invitations require proving you know the person before they can be
    // sent at all. Report that specifically rather than as a generic timeout.
    const dialogText = await page.locator(INVITE_DIALOG).first().innerText().catch(() => "");
    if (/enter their email|to verify this member/i.test(dialogText)) {
      throw new InviteUiError(
        `LinkedIn requires an email address to verify you know this person — invitation not sent (${linkedinUrl})`
      );
    }

    throw new InviteUiError(
      `Invitation Send button never appeared at ${page.url()} — invitation NOT sent. ` +
        `Dialog text: ${dialogText.replace(/\s+/g, " ").trim().slice(0, 200) || "(no dialog)"}`
    );
  }
  return sendBtn;
}

/**
 * Confirms LinkedIn actually recorded the invitation. A completed click proves
 * nothing on its own — this is the only thing that lets the function return
 * normally.
 *
 * Two independent LinkedIn-side signals, cheapest first:
 *  1. the profile now shows Pending (and no longer offers Connect);
 *  2. the target appears in the sent-invitations manager.
 */
async function verifyInvitationSent(page: Page, linkedinUrl: string, vanity: string | null): Promise<void> {
  await gotoAuthenticated(page, linkedinUrl);
  await page.waitForTimeout(2500);

  const topCard = await findTopCard(page);
  const cardText = topCard ? await topCard.innerText().catch(() => "") : "";
  const pendingBadge = await page
    .locator('button[aria-label*="Pending"]:visible, [aria-label*="Pending"]:visible')
    .count();
  const connectStillOffered = vanity ? await ownConnectLink(page, vanity).count() : 0;

  if ((pendingBadge > 0 || /\bPending\b/.test(cardText)) && connectStillOffered === 0) return;

  // Authoritative second opinion — the same scrape the daily accepted-sync uses.
  if (vanity) {
    const pending = await scrapePendingInvitationVanityNames(page).catch(() => null);
    if (pending?.has(vanity)) return;
    if (pending) {
      throw new InviteNotSentError(
        `Invitation to ${linkedinUrl} is not pending on LinkedIn after clicking Send ` +
          `(profile shows no Pending state and ${vanity} is absent from the sent-invitations list) — treating as NOT sent`
      );
    }
  }

  throw new InviteNotSentError(
    `Could not confirm the invitation to ${linkedinUrl} was sent ` +
      `(no Pending state on the profile${connectStillOffered > 0 ? ", Connect is still offered" : ""}) — treating as NOT sent`
  );
}

/**
 * Sends a LinkedIn connection request without a note, and returns only once
 * LinkedIn confirms the invitation is pending.
 *
 * Throws WeeklyLimitError if the weekly limit popup appears, AlreadyConnected/
 * PendingInviteError if already in that state, SessionExpiredError if the
 * session is dead, InviteUiError if the invitation UI can't be completed, and
 * InviteNotSentError if the send can't be confirmed afterwards. It never
 * returns normally without positive confirmation — the runner records
 * connection_requested_at on return, so a silent no-op here is recorded as a
 * real invitation and the contact is never retried.
 */
export async function sendConnectionRequest(page: Page, linkedinUrl: string): Promise<void> {
  const vanity = vanityNameOf(linkedinUrl);

  await gotoAuthenticated(page, linkedinUrl);
  await page.waitForTimeout(2000 + Math.random() * 1000);

  const topCard = await findTopCard(page);
  await assertConnectable(page, topCard, vanity);

  const sendBtn = await openInviteDialog(page, linkedinUrl, vanity);
  await sendBtn.click();
  await page.waitForTimeout(2500);

  await assertNoLinkedInError(page);
  await verifyInvitationSent(page, linkedinUrl, vanity);
}
