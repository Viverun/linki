/**
 * Live retest harness for the LinkedIn connection-request flow.
 *
 * Runs the REAL production code from lib/linkedin/connect.ts against a real
 * authenticated session, so a pass here means the shipped selectors work — not
 * a copy of them.
 *
 * Preflight (default) is read-only: it navigates, resolves the top card, runs
 * the already-connected/pending guards and opens the invitation modal, then
 * reports whether the Send button is actually there — and exits WITHOUT
 * clicking it. Nothing is sent.
 *
 * With --send it calls sendConnectionRequest() end to end, which really does
 * send an invitation to a real person.
 *
 *   npm run retest:connect -- <accountId> <profileUrl>
 *   npm run retest:connect -- <accountId> <profileUrl> --send
 */
import { getSessionPage, saveSessionState } from "@/lib/linkedin/session";
import {
  sendConnectionRequest,
  findTopCard,
  assertConnectable,
  openInviteDialog,
  vanityNameOf,
  gotoAuthenticated,
} from "@/lib/linkedin/connect";

const [accountId, profileUrl] = process.argv.slice(2).filter(a => !a.startsWith("--"));
const doSend = process.argv.includes("--send");

if (!accountId || !profileUrl) {
  console.error("usage: npm run retest:connect -- <accountId> <profileUrl> [--send]");
  process.exit(2);
}

(async () => {
  const page = await getSessionPage(accountId);
  try {
    if (doSend) {
      console.log(`[retest] SENDING a real invitation to ${profileUrl}`);
      await sendConnectionRequest(page, profileUrl);
      console.log("[retest] PASS — sendConnectionRequest returned, so LinkedIn confirmed the invite is pending");
      return;
    }

    console.log(`[retest] preflight (read-only, nothing will be sent) for ${profileUrl}`);
    const vanity = vanityNameOf(profileUrl);
    console.log("  vanityName:", vanity);

    await gotoAuthenticated(page, profileUrl);
    await page.waitForTimeout(4000);
    console.log("  landed on:", page.url());

    const topCard = await findTopCard(page);
    console.log("  top card found:", topCard !== null);
    if (topCard) {
      console.log("  top card text:", (await topCard.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160));
    }

    await assertConnectable(page, topCard, vanity);
    console.log("  connectable: yes (not already connected, no pending invite)");

    const sendBtn = await openInviteDialog(page, profileUrl, vanity);
    console.log("  invite page:", page.url());
    console.log("  Send button aria-label:", await sendBtn.getAttribute("aria-label"));
    console.log("[retest] PASS — invitation modal reached and the Send button is present. Not clicking it.");
  } finally {
    await page.close();
    await saveSessionState(accountId).catch(() => {});
  }
})().catch(err => {
  console.error(`[retest] FAIL — ${err?.constructor?.name}: ${err?.message}`);
  process.exit(1);
});
