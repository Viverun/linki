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
let retryBehaviour: () => Promise<number> = async () => { calls.push("retry"); return 0; };
mockModule("@/lib/email/reply-policy", {
  namedExports: {
    ...realPolicy,
    decideReplyOpenCore: async (_db: unknown, id: string) => { calls.push(`open-core:${id}`); return "ooo_continue"; },
    retryUndecidedReplies: async () => retryBehaviour(),
  },
});
const { dispatchCapturedReply, runOpenCoreSweep } = await import("@/lib/email/inbox");
const { getDb } = await import("@/lib/db");
after(() => { try { getDb().close(); } catch { /* never opened */ } rmSync(dbDir, { recursive: true, force: true }); });

// syncEmailInbox itself needs a real (or a fully faked) IMAP account to exercise end
// to end, which would require mocking the `imap` package's connection lifecycle in
// detail — not feasible without a large mock here. Per the brief, we instead exercise
// the shared helper syncEmailInbox calls unconditionally: runOpenCoreSweep(db). Both
// the sync's own code path and these tests call the exact same function.

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

test("S3 runOpenCoreSweep calls retryUndecidedReplies exactly once (open-core)", async () => {
  calls.length = 0; premiumBox.premium = null;
  retryBehaviour = async () => { calls.push("retry"); return 0; };
  await runOpenCoreSweep(getDb());
  assert.deepEqual(calls, ["retry"]);
});

test("S4 runOpenCoreSweep swallows a throw from retryUndecidedReplies instead of propagating it", async () => {
  calls.length = 0; premiumBox.premium = null;
  retryBehaviour = async () => { calls.push("retry"); throw new Error("synthetic transient failure"); };
  await assert.doesNotReject(() => runOpenCoreSweep(getDb()));
  assert.deepEqual(calls, ["retry"]);
});

// Not tested here: runOpenCoreSweep as a no-op under premium. mock.module's
// namedExports snapshots `@/lib/premium`'s `premium` getter once at mock setup
// (see the note on S2 above) rather than preserving a live binding, so — unlike
// dispatchCapturedReply, which takes the premium surface as an explicit third
// argument specifically to work around this — runOpenCoreSweep(db) always
// observes the module's snapshot-time value here, not premiumBox.premium as
// set by an individual test. The premium/no-premium branch itself is exercised
// directly in dispatchCapturedReply's S1/S2 above.

// R7 (C2-B2 final review): the two early returns in syncEmailInbox — no IMAP
// config, and no pending targets — must still run the open-core sweep, or a
// single-account install could leave undecided replies without an automatic
// path to a decision. Neither path touches IMAP, so they are drivable here.
const { syncEmailInbox } = await import("@/lib/email/inbox");

test("S5 an account without IMAP config still runs the sweep once", async () => {
  calls.length = 0; premiumBox.premium = null;
  retryBehaviour = async () => { calls.push("retry"); return 0; };
  getDb().prepare("INSERT INTO email_accounts (id, name, from_email, smtp_host, username, password) VALUES ('ea-noimap', 'No IMAP', 'a@b.test', 'smtp.test', 'u', 'p')").run();
  const r = await syncEmailInbox("ea-noimap");
  assert.deepEqual(r, { replies: 0, bounces: 0 });
  assert.deepEqual(calls, ["retry"]);
});

test("S6 an account with IMAP config but no pending targets still runs the sweep once", async () => {
  calls.length = 0; premiumBox.premium = null;
  retryBehaviour = async () => { calls.push("retry"); return 0; };
  getDb().prepare("INSERT INTO email_accounts (id, name, from_email, smtp_host, imap_host, username, password) VALUES ('ea-idle', 'Idle', 'a@b.test', 'smtp.test', 'imap.test', 'u', 'p')").run();
  const r = await syncEmailInbox("ea-idle");
  assert.deepEqual(r, { replies: 0, bounces: 0 });
  assert.deepEqual(calls, ["retry"]);
});
