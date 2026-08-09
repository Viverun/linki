import type { Page } from "playwright";
import { visitProfile } from "./visit";

export class NotConnectedError extends Error {}
/** Connected, but no messaging URN resolved — never guess the recipient by name. */
export class MessagingUrnUnresolvedError extends Error {}

export interface SendMessageResult {
  messagingUrn: string | null;
  isFirstDegree: boolean;
}

/**
 * Sends a message to a LinkedIn 1st-degree connection.
 *
 * Self-contained URN resolution — does NOT depend on a prior 'visit' workflow
 * step. If messagingUrn is already cached, it's used directly (no extra page
 * load). Otherwise this does its own live profile check (the same top-card-
 * scoped logic as the 'visit' step, see visit.ts) to fetch a fresh URN and
 * verify the target is still actually connected, immediately before sending.
 * Only if that live check finds no URN despite confirming 1st-degree does it
 * fall back to the connections-only name-search typeahead — a rare last
 * resort now, not the default path for every contact that lacks a cached URN.
 *
 * Throws NotConnectedError if the live check finds the target is NOT 1st-
 * degree, instead of guessing via typeahead search (which can silently hit
 * an unrelated connection with a similar/truncated name — see CLAUDE.md /
 * memory for the Jul 2026 incident this replaced).
 *
 * Returns the resolved { messagingUrn, isFirstDegree } so the caller can
 * persist it to the target record, same as the 'visit' step does.
 */
export async function sendMessage(
  page: Page,
  fullName: string,
  text: string,
  linkedinUrl: string,
  messagingUrn?: string | null
): Promise<SendMessageResult> {
  // The live visit is the ONLY authorization. A cached URN used to short-circuit
  // this entirely — openComposeByUrn() ran first and the profile was never
  // checked — so a DB degree=1 that had gone stale (or was written from a UI
  // misread) sent a message to a non-connection with no verification at all.
  // A URN is an address, never permission.
  const resolved = await visitProfile(page, linkedinUrl);

  if (!resolved.isFirstDegree) {
    // Runner self-healing depends on this: it resets degree/connected_at to NULL.
    throw new NotConnectedError(`${fullName} is not a 1st-degree connection — refusing to message`);
  }

  // Connected. Prefer the URN just read from the live profile; fall back to the
  // cached one only as an address for a confirmed connection.
  const urn = resolved.messagingUrn ?? messagingUrn ?? null;
  if (urn && (await openComposeByUrn(page, urn))) {
    await sendFromComposeBox(page, text);
    return { messagingUrn: urn, isFirstDegree: true };
  }

  // Connected, but no messaging URN could be resolved. The old code fell back to
  // searching LinkedIn's connections typeahead by display name, which is how an
  // unrelated person with a similar/truncated name got messaged (Jul 2026), and
  // which in Aug 2026 searched the literal vanity slug "raise-faster". A name is
  // not an identity: fail with a dedicated error instead of guessing a recipient.
  throw new MessagingUrnUnresolvedError(
    `${fullName} appears connected but no messaging URN could be resolved from ${linkedinUrl} — refusing to pick a recipient by name`
  );
}

async function openComposeByUrn(page: Page, messagingUrn: string): Promise<boolean> {
  try {
    const recipientId = messagingUrn.split(":").pop();
    const composeUrl = `https://www.linkedin.com/messaging/compose/?profileUrn=${encodeURIComponent(messagingUrn)}&recipient=${recipientId}`;
    await page.goto(composeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500 + Math.random() * 1000);
    const msgInput = page.locator("div.msg-form__contenteditable").first();
    await msgInput.waitFor({ timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

// The name-search typeahead that used to live here has been REMOVED, not just
// bypassed. It selected a recipient by display name, which messaged an
// unrelated person in Jul 2026 and, in Aug 2026, searched the literal vanity
// slug "raise-faster". Messaging now requires a resolved URN; there is no
// name-based path to fall back into, by construction.

async function sendFromComposeBox(page: Page, text: string): Promise<void> {
  // Paste message into compose area
  const msgInput = page.locator("div.msg-form__contenteditable").first();
  await msgInput.waitFor({ timeout: 8000 });
  await msgInput.click();
  try {
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await page.waitForTimeout(300);
    await msgInput.press("Control+V");
  } catch {
    // Clipboard blocked in headless — fall back to keyboard typing
    await msgInput.pressSequentially(text, { delay: 20 });
  }
  await page.waitForTimeout(500);

  // Send
  const sendBtn = page.locator("button.msg-form__send-button:visible").first();
  await sendBtn.waitFor({ timeout: 5000 });
  await sendBtn.click({ delay: 100 });
  await page.waitForTimeout(2000);
}
