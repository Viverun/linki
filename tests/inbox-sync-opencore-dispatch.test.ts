import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "linki-inbox-dispatch-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-inbox-dispatch-tests";

const mockModule = mock.module.bind(mock) as unknown as (specifier: string, options: { namedExports: Record<string, unknown> }) => void;

const calls: string[] = [];
const premiumBox: { premium: null | { replies: { classifyAndDispatch: (id: string) => Promise<void>; shouldSyncInbox: () => boolean; syncAccountInbox: () => Promise<number> } } } = { premium: null };
mockModule("@/lib/premium", { namedExports: { get premium() { return premiumBox.premium; }, get hasPremium() { return premiumBox.premium !== null; } } });
const realPolicy = await import("@/lib/email/reply-policy");
mockModule("@/lib/email/reply-policy", {
  namedExports: {
    ...realPolicy,
    decideReplyOpenCore: async (_db: unknown, id: string) => { calls.push(`open-core:${id}`); return "ooo_continue"; },
    retryUndecidedReplies: async () => { calls.push("retry"); return 0; },
  },
});
const { dispatchCapturedReply } = await import("@/lib/email/inbox");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

test("S1 without premium the open-core policy decides the reply", async () => {
  calls.length = 0; premiumBox.premium = null;
  await dispatchCapturedReply(getDb(), "r1");
  assert.deepEqual(calls, ["open-core:r1"]);
});

test("S2 with premium its dispatcher decides and the open-core policy is not called", async () => {
  calls.length = 0;
  premiumBox.premium = { replies: { classifyAndDispatch: async (id) => { calls.push(`premium:${id}`); }, shouldSyncInbox: () => false, syncAccountInbox: async () => 0 } };
  // mock.module's namedExports does not preserve the `premium` getter as a live binding
  // (it snapshots the value at mock setup), so dispatchCapturedReply's default `surface =
  // premium` parameter always sees the original null. Falling back to the brief's
  // documented route: pass the premium surface explicitly as the third argument.
  await dispatchCapturedReply(getDb(), "r2", premiumBox.premium);
  assert.deepEqual(calls, ["premium:r2"]);
  premiumBox.premium = null;
});
