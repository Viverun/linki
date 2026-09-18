#!/usr/bin/env node
// Manual live check of the open-core reply judgment. Not part of any gate.
//   TYPESAFE_API_KEY=... node --experimental-strip-types --import ./scripts/test-setup.mjs scripts/typesafe-smoke.mjs
import { jevJudge, extractDateCandidates } from "../lib/email/reply-policy.ts";

const key = process.env.TYPESAFE_API_KEY;
if (!key) { console.error("TYPESAFE_API_KEY is not set"); process.exit(2); }
const judge = jevJudge(key);
const ours = { subject: "Quick question about your hiring plans", body: "Hi Ada — are you looking to expand the team this quarter?" };
// Fixed sample strings only — this script never sends repository or database
// content (real reply bodies, subjects, or contact data) to TypeSafe.
const samples = [
  ["clear OOO with date", "Thank you for your email. I am out of the office until 2 October 2026 with limited access to email and will respond on my return."],
  ["curt human reply", "Not interested, please remove me from your list."],
  ["bounce-like notice", "Delivery has failed to these recipients or groups: ada@example.com. The recipient's mailbox is full."],
];
for (const [label, body] of samples) {
  const state = { reply: { from: "ada@example.com", subject: "Re: Quick question", body, received_at: new Date().toISOString() }, our_last_email: ours, today: new Date().toISOString().slice(0, 10) };
  const j = await judge(state, extractDateCandidates(body));
  console.log(`${label.padEnd(24)} p_ooo=${j.pOoo.toFixed(3)} model=${j.model} return=${j.returnDate ? `${j.returnDate.chosen} (${j.returnDate.confidence.toFixed(2)})` : "n/a"}`);
}
