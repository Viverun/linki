import { chromium } from "playwright-extra";
import type { Browser, BrowserContext, Page } from "playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { getDb } from "@/lib/db";
import { encryptSecret, decryptSecret, isEncrypted } from "@/lib/crypto";

chromium.use(StealthPlugin());

let browser: Browser | null = null;
const contexts: Map<string, BrowserContext> = new Map();

const HEADLESS = process.env.HEADLESS !== "false";
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

/**
 * Shared browser-context fingerprint. Login and runtime MUST use the identical
 * options so the LinkedIn session is BORN under the exact fingerprint it will
 * later be used with — a mismatch (or a drift) triggers a forced re-auth.
 */
function contextOptions(storageState?: object) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageState: storageState as any,
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    permissions: ["clipboard-read", "clipboard-write"] as ("clipboard-read" | "clipboard-write")[],
  };
}

async function getBrowser(headless = HEADLESS): Promise<Browser> {
  // B1: if the cached browser is disconnected, CLOSE it before relaunching.
  // Without this, a dead-but-not-reaped chromium process tree is orphaned on
  // every relaunch (the leak behind the Jun 2026 zombie pile-up).
  if (browser && !browser.isConnected()) {
    try { await browser.close(); } catch { /* already gone */ }
    browser = null;
  }
  if (!browser) {
    browser = await chromium.launch({
      headless,
      executablePath: CHROMIUM_PATH,
      args: LAUNCH_ARGS,
    });
  }
  return browser;
}

/**
 * NF-8: a stored session that was never encrypted must not silently work.
 *
 * `decryptSecret` returns NON-enveloped input unchanged — deliberately, so that
 * rows predating the encryption migration keep working while `lib/db.ts`
 * back-fills them. The consequence is that a plaintext `cookies_json`, arriving
 * from a bug, a half-finished migration, or a hand-edited row, decrypts to
 * itself, parses, and drives the browser perfectly. Encryption at rest would be
 * absent and nothing anywhere would say so.
 *
 * The check lives HERE, at the one place a cookie blob is decrypted for use, not
 * inside `decryptSecret` — that pass-through has legitimate callers for optional
 * fields (`imap_password`, `api_key`) and for the migration itself.
 */
export class UnencryptedSessionError extends Error {
  constructor(accountId: string) {
    // Account id only. Never the blob, never a cookie name or value (I9).
    super(
      `Account ${accountId} has a session stored WITHOUT encryption at rest. ` +
      `Refusing to use it. Re-authenticate the account so the session is written ` +
      `through encryptSecret, or check whether lib/db.ts's encryption migration ran.`
    );
    this.name = "UnencryptedSessionError";
  }
}

/**
 * Decrypts a stored session blob for use.
 *
 * Two failure modes, deliberately treated differently:
 *
 *   not enveloped  -> THROW. A security invariant is violated, and "this account
 *                     needs re-authenticating" is the wrong description of it.
 *   won't decrypt  -> undefined, so the caller falls back to re-auth. A corrupt
 *   or won't parse    blob or a rotated NEXTAUTH_SECRET is a real, recoverable
 *                     situation and was already handled this way.
 */
export function decryptSessionState(accountId: string, cookiesJson: string): object | undefined {
  if (!isEncrypted(cookiesJson)) throw new UnencryptedSessionError(accountId);
  try {
    return JSON.parse(decryptSecret(cookiesJson)!);
  } catch {
    // Invalid storage state — will need re-auth
    return undefined;
  }
}

async function getOrCreateContext(accountId: string): Promise<BrowserContext> {
  const db = getDb();
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as
    | { cookies_json: string | null; email: string }
    | undefined;

  if (!account) throw new Error(`Account ${accountId} not found`);

  if (!contexts.has(accountId)) {
    const b = await getBrowser();

    let storageState: object | undefined;
    if (account.cookies_json) {
      storageState = decryptSessionState(accountId, account.cookies_json);
    }

    const ctx = await b.newContext(contextOptions(storageState));

    // Auto-evict from map when context closes for any reason (crash, session expiry, etc.)
    ctx.on("close", () => { if (contexts.get(accountId) === ctx) contexts.delete(accountId); });

    contexts.set(accountId, ctx);
  }

  return contexts.get(accountId)!;
}

/** Returns the BrowserContext for an account (for API calls via ctx.request) */
export async function getSessionContext(accountId: string): Promise<BrowserContext> {
  try {
    return await getOrCreateContext(accountId);
  } catch {
    // First attempt failed — evict and retry once with a fresh context
    contexts.delete(accountId);
    return getOrCreateContext(accountId);
  }
}

// B6 (Jul 2026 CPU-spike incident): closing a Playwright page doesn't mean the
// underlying Chromium renderer OS process has actually exited — under CPU
// contention on the 2-vCPU prod box, teardown was observed lagging 60-90s
// behind page.close(). If the runner loop (or a concurrent MCP/API call)
// opens its next page immediately after, two renderer processes end up alive
// at once, which is enough to peg both cores and starve sibling containers'
// healthchecks (NocoDB/Chatwoot flapping). Fix: serialize ALL page opens
// app-wide through one queue, and hold the queue for a teardown buffer after
// each page.close() before letting the next one through. PAGE_MAX_HOLD_MS is
// a safety valve so a caller that forgets to close its page can't wedge the
// whole app's browser access forever.
const PAGE_TEARDOWN_GAP_MS = 3000;
const PAGE_MAX_HOLD_MS = 120_000;
let pageQueueTail: Promise<void> = Promise.resolve();

/** Returns a new Page from the account's browser context */
export async function getSessionPage(accountId: string): Promise<Page> {
  let releaseTurn!: () => void;
  const myTurn = new Promise<void>(r => { releaseTurn = r; });
  const previousTail = pageQueueTail;
  pageQueueTail = myTurn;
  await previousTail;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseTurn();
  };
  const safetyTimer = setTimeout(release, PAGE_MAX_HOLD_MS);

  let page: Page;
  try {
    const ctx = await getOrCreateContext(accountId);
    try {
      page = await ctx.newPage();
    } catch {
      // B2: context was dead — CLOSE it before recreating so its underlying
      // browser process isn't left orphaned, then retry once with a fresh one.
      try { await ctx.close(); } catch { /* already gone */ }
      contexts.delete(accountId);
      const freshCtx = await getOrCreateContext(accountId);
      page = await freshCtx.newPage();
    }
  } catch (err) {
    clearTimeout(safetyTimer);
    release();
    throw err;
  }

  const originalClose = page.close.bind(page);
  page.close = (async (options?: Parameters<Page["close"]>[0]) => {
    try {
      return await originalClose(options);
    } finally {
      clearTimeout(safetyTimer);
      setTimeout(release, PAGE_TEARDOWN_GAP_MS);
    }
  }) as Page["close"];

  return page;
}

// ─── Authentication guard ─────────────────────────────────────────────────────
// B7 (Aug 2026 phantom-auth incident): an account was found with
// is_authenticated = 1 while its persisted storage state contained NO li_at —
// LinkedIn served /authwall for every navigation, yet the runner kept picking
// the account up because it only ever consulted the DB flag. The saved state
// held li_rm, trkCode and trkInfo: the cookies LinkedIn hands a LOGGED-OUT
// visitor sitting on an authwall. Any one of them can be present on a session
// that has never authenticated, so none of them is evidence of anything.
//
// li_at is the only cookie that constitutes a LinkedIn session. The rule is
// therefore: is_authenticated = 1 is written ONLY together with a storage
// state that carries a non-empty li_at. Every write path goes through the
// helpers below so the flag cannot drift from the browser state again.

/** Shape of the subset of Playwright's storageState() this module reasons about. */
export type SessionStorageState = {
  cookies?: { name: string; value: string; domain?: string }[];
  origins?: unknown[];
};

/** Raised when a login flow finishes without LinkedIn having issued a session. */
export class AuthenticationNotEstablishedError extends Error {
  readonly cookieNames: string[];
  constructor(accountId: string, cookieNames: string[]) {
    super(
      `LinkedIn authentication was not established for account ${accountId}: ` +
        `the session cookie (li_at) is absent from the browser state. ` +
        `Cookies present: ${cookieNames.length ? cookieNames.join(", ") : "(none)"}. ` +
        `This is a logged-out/authwall session — the account has NOT been marked authenticated.`
    );
    this.name = "AuthenticationNotEstablishedError";
    this.cookieNames = cookieNames;
  }
}

/**
 * The single source of truth for "is this browser state actually logged in?".
 * Returns the li_at cookie, or null. Deliberately narrow: only li_at counts,
 * it must carry a non-empty value, and (when the state records a domain) it
 * must belong to LinkedIn.
 */
export function findAuthCookie(
  state: SessionStorageState | null | undefined
): { name: string; value: string } | null {
  const cookies = state?.cookies;
  if (!Array.isArray(cookies)) return null;
  for (const c of cookies) {
    if (!c || c.name !== "li_at") continue;
    if (typeof c.value !== "string" || c.value.trim() === "") continue;
    if (typeof c.domain === "string" && c.domain !== "" && !c.domain.includes("linkedin.com")) continue;
    return { name: c.name, value: c.value };
  }
  return null;
}

/** True only when `state` proves an established LinkedIn session. */
export function isAuthenticatedStorageState(state: SessionStorageState | null | undefined): boolean {
  return findAuthCookie(state) !== null;
}

function cookieNamesOf(state: SessionStorageState | null | undefined): string[] {
  return Array.isArray(state?.cookies) ? state!.cookies!.map(c => c?.name).filter(Boolean) : [];
}

/**
 * Persist a storage state as an authenticated session. Writes
 * is_authenticated = 1 if and only if li_at is present; otherwise writes
 * nothing and throws, so no caller can report a login as successful.
 */
export function persistAuthenticatedState(
  accountId: string,
  state: SessionStorageState,
  source: string
): void {
  if (!isAuthenticatedStorageState(state)) {
    const names = cookieNamesOf(state);
    console.error(
      `[auth] ${source}: REFUSING to mark account ${accountId} authenticated — no li_at in the ` +
        `browser state (LinkedIn session was never established). Cookies present: ` +
        `${names.length ? names.join(", ") : "(none)"}. Cookies such as li_rm/trkCode/trkInfo are ` +
        `served to logged-out visitors and are not proof of authentication.`
    );
    throw new AuthenticationNotEstablishedError(accountId, names);
  }
  getDb()
    .prepare("UPDATE accounts SET cookies_json = ?, is_authenticated = 1 WHERE id = ?")
    .run(encryptSecret(JSON.stringify(state)), accountId);
}

/**
 * Refresh the stored cookies for a live session (called by the runner after
 * each action to keep rotating cookies fresh).
 *
 * Non-throwing by contract: the runner calls this immediately BEFORE recording
 * a sent invite/message, so raising here would lose the record of an action
 * LinkedIn has already performed. When the session has died mid-run we
 * therefore clear is_authenticated rather than throw — the account stops being
 * picked up, and the existing SessionExpiredError path handles the in-flight
 * work. The one thing that never happens is writing is_authenticated = 1 for a
 * state with no li_at.
 */
export function refreshStoredSessionState(
  accountId: string,
  state: SessionStorageState
): "saved" | "cleared" {
  if (!isAuthenticatedStorageState(state)) {
    const names = cookieNamesOf(state);
    console.error(
      `[auth] saveSessionState: account ${accountId} lost its LinkedIn session — li_at is gone ` +
        `from the live browser context (cookies present: ${names.length ? names.join(", ") : "(none)"}). ` +
        `Clearing is_authenticated and keeping the previous stored state; re-authentication is required.`
    );
    getDb().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(accountId);
    return "cleared";
  }
  persistAuthenticatedState(accountId, state, "saveSessionState");
  return "saved";
}

export async function saveSessionState(accountId: string): Promise<void> {
  const ctx = contexts.get(accountId);
  if (!ctx) return;
  refreshStoredSessionState(accountId, (await ctx.storageState()) as SessionStorageState);
}

export async function closeSession(accountId: string): Promise<void> {
  const ctx = contexts.get(accountId);
  if (ctx) {
    await ctx.close();
    contexts.delete(accountId);
  }
}

/**
 * B4: flag an account as logged out / needing re-auth. Clears is_authenticated
 * so the runner stops working a dead session (no more 30s-timeout fail-loop),
 * and drops the live context. The user re-authenticates from Settings.
 */
export async function markNeedsReauth(accountId: string): Promise<void> {
  const db = getDb();
  db.prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(accountId);
  try { await closeSession(accountId); } catch { /* ignore */ }
  console.warn(`[session] account ${accountId} flagged needs-reauth (session logged out)`);
}

/**
 * Opens a visible browser, navigates to LinkedIn login, and waits for the user
 * to complete login manually. Returns when the user reaches /feed.
 * Saves the full storage state to DB and marks account as authenticated.
 */
export async function authenticateAccount(accountId: string): Promise<void> {
  const db = getDb();
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as
    | { email: string }
    | undefined;
  if (!account) throw new Error(`Account ${accountId} not found`);

  // Close any existing context for this account — start fresh
  await closeSession(accountId);

  // Always launch a VISIBLE browser for manual login
  const visibleBrowser = await chromium.launch({
    headless: false,
    executablePath: CHROMIUM_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const ctx = await visibleBrowser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    const page = await ctx.newPage();
    await page.goto("https://www.linkedin.com/login");

    // Pre-fill email to save the user a step
    try {
      await page.waitForSelector("input#username", { timeout: 5000 });
      await page.fill("input#username", account.email);
    } catch {
      // Input not found — page may have redirected already
    }

    // Wait up to 3 minutes for the user to complete login and reach /feed
    await page.waitForURL("**/feed/**", { timeout: 180_000 });

    // Save full storage state (cookies + localStorage) to DB. Guarded: reaching
    // /feed is not by itself proof of a session — only li_at is.
    const state = (await ctx.storageState()) as SessionStorageState;
    try {
      persistAuthenticatedState(accountId, state, "authenticateAccount");
    } finally {
      await ctx.close();
    }
  } finally {
    await visibleBrowser.close();
  }
}

// ─── Server-side headless login ───────────────────────────────────────────────
// Logs in directly on the server (no screen) so the session is born under the
// SAME pinned Chromium fingerprint the runner uses, and so ALL cookies — incl.
// httpOnly ones like li_ep_auth_context (the Sales Nav seat cookie that
// document.cookie cannot read) — are captured. A login from a datacenter IP
// almost always triggers an email/SMS PIN, so it's a two-step flow: start
// (email+password) → maybe a challenge → verify (code).

export type LoginResult =
  | { status: "authenticated" }
  | { status: "challenge"; kind: "otp" | "app" | "captcha" | "unknown"; message: string }
  | { status: "error"; message: string };

type PendingLogin = { ctx: BrowserContext; page: Page; createdAt: number };
const pendingLogins: Map<string, PendingLogin> = new Map();
const PENDING_TTL_MS = 10 * 60_000;

// PIN/verification-code input. Named ids first, then type-based fallbacks for
// LinkedIn's React checkpoint pages (which use dynamic ids). Safe: the login
// page itself has no tel/one-time-code input to misfire on.
const PIN_SELECTOR =
  "input[name='pin'], #input__email_verification_pin, input[autocomplete='one-time-code']:visible, input[type='tel']:visible";

async function clearPendingLogin(accountId: string): Promise<void> {
  const p = pendingLogins.get(accountId);
  if (p) {
    pendingLogins.delete(accountId);
    try { await p.ctx.close(); } catch { /* already gone */ }
  }
}

function sweepPendingLogins(): void {
  const now = Date.now();
  for (const [id, p] of pendingLogins) {
    if (now - p.createdAt > PENDING_TTL_MS) void clearPendingLogin(id);
  }
}

/**
 * Warm the freshly-authenticated session by loading Sales Navigator once, THEN
 * persist. The bare login POST lands on /feed and only mints the ~11 core
 * LinkedIn cookies — it does NOT yet include the Sales Nav SEAT cookie
 * (li_ep_auth_context) nor the secondary auth tokens (li_a, liap) and
 * localStorage. Those are only issued once the browser actually enters Sales
 * Navigator. Without the seat cookie every Sales Nav API call returns nothing
 * ("no intercept after 15s" → import fails → account wrongly flagged
 * needs-reauth). So we navigate to /sales/ and wait for it to settle before
 * calling storageState(), capturing the FULL session the runner needs.
 * Best-effort: if the account has no Sales Nav seat the nav simply doesn't add
 * the seat cookie — the rest of the (regular-LinkedIn) session is still saved.
 *
 * The Sales Nav navigation stays best-effort, but its failure is now LOGGED
 * rather than silently dropped, and — critically — it can no longer produce a
 * false "authenticated": if that navigation lands on an authwall (i.e. the
 * login never really took), the li_at check below refuses the write and throws.
 * Callers surface that as a login error.
 */
async function persistLogin(accountId: string, ctx: BrowserContext, page?: Page): Promise<void> {
  if (page) {
    try {
      await page.goto("https://www.linkedin.com/sales/home", { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Let Sales Nav's bootstrap requests fire so li_ep_auth_context is set.
      await page.waitForTimeout(4_000);
    } catch (e) {
      // Non-fatal for the seat cookie — a missing seat / slow load must not fail
      // the login on its own. Authentication itself is decided by li_at below.
      console.warn(`[login] account ${accountId}: Sales Nav warm-up failed (${(e as Error).message}) — continuing`);
    }
  }
  const state = (await ctx.storageState()) as SessionStorageState;
  // Throws AuthenticationNotEstablishedError (and writes nothing) when li_at is
  // absent — the guard that stops an authwall session being stored as valid.
  persistAuthenticatedState(accountId, state, "persistLogin");
  // Drop any stale runtime context so the runner reloads the fresh cookies.
  await closeSession(accountId);
}

/**
 * Inspect the page after a login/verify submit and classify the outcome.
 * LinkedIn varies its challenge per attempt — email/SMS code OR device (app)
 * approval — so we detect both: a visible code input = otp; a checkpoint page
 * with no code input and no captcha = device approval.
 */
/**
 * Does this URL look like a landed-on-the-logged-in-app URL?
 *
 * Matched against the PATHNAME only. An authwall URL carries the original
 * destination in its query string
 * (`/authwall?...&sessionRedirect=https://www.linkedin.com/sales/`), so the
 * older whole-URL regexes could see "/sales/" inside a logged-OUT page's query
 * and classify an authwall as authenticated. /authwall, /login and /checkpoint
 * are rejected outright.
 *
 * This is only a cheap first gate: authentication is decided by li_at in
 * persistAuthenticatedState(), never by the URL alone.
 */
export function isLoggedInAppUrl(rawUrl: string): boolean {
  let path: string;
  try {
    const u = new URL(rawUrl);
    if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return false;
    path = u.pathname;
  } catch {
    return false;
  }
  if (/^\/(authwall|login|uas\/login|checkpoint)(\/|$)/.test(path)) return false;
  return /^\/feed(\/|$)/.test(path) || /^\/sales(\/|$)/.test(path);
}

async function classifyLoginState(page: Page): Promise<LoginResult> {
  const start = Date.now();
  const deadline = start + 20_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (isLoggedInAppUrl(url)) {
      return { status: "authenticated" };
    }

    // Email/SMS PIN entry
    const pin = page.locator(PIN_SELECTOR).first();
    if ((await pin.count()) > 0 && (await pin.isVisible().catch(() => false))) {
      return {
        status: "challenge",
        kind: "otp",
        message: "LinkedIn sent you a verification code (email or SMS). Enter it below.",
      };
    }

    if (/checkpoint\/challenge/.test(url)) {
      // CAPTCHA (Arkose / FunCaptcha) — cannot be solved headlessly
      const cap = page.locator("iframe[src*='arkoselabs'], iframe[title*='captcha'], #captcha-internal");
      if ((await cap.count().catch(() => 0)) > 0) {
        return {
          status: "challenge",
          kind: "captcha",
          message: "LinkedIn requires a CAPTCHA, which can't be solved on the server. Use cookie paste instead.",
        };
      }
      // Device/app approval: a settled checkpoint with no code input and no captcha
      if (Date.now() - start > 4_000) {
        return {
          status: "challenge",
          kind: "app",
          message: "LinkedIn sent a sign-in request to your LinkedIn mobile app. Approve it there, then click Continue.",
        };
      }
    }

    // Wrong credentials
    const wrongPw = await page
      .getByText(/that.?s not the right password|please enter a valid|couldn.?t find a linkedin account/i)
      .count()
      .catch(() => 0);
    if (wrongPw > 0) return { status: "error", message: "Wrong email or password." };

    await page.waitForTimeout(800);
  }

  if (/checkpoint/.test(page.url())) {
    return {
      status: "challenge",
      kind: "unknown",
      message: "LinkedIn presented a security checkpoint. If you got a code enter it; if it's an app request, approve it and click Continue.",
    };
  }
  return { status: "error", message: `Login did not complete. Current page: ${page.url()}` };
}

export async function startHeadlessLogin(
  accountId: string,
  email: string,
  password: string
): Promise<LoginResult> {
  sweepPendingLogins();
  await clearPendingLogin(accountId);

  const b = await getBrowser(true);
  const ctx = await b.newContext(contextOptions());
  const page = await ctx.newPage();
  try {
    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 30_000 });
    // LinkedIn's React login page uses dynamic ids — target by type+visibility
    // (old #username/#password kept as a fallback for the legacy layout).
    const emailInput = page.locator("input#username, input[type='email']:visible").first();
    await emailInput.waitFor({ state: "visible", timeout: 20_000 });
    await emailInput.fill(email);
    const passwordInput = page.locator("input#password, input[type='password']:visible").first();
    await passwordInput.fill(password);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      passwordInput.press("Enter"),
    ]);

    const result = await classifyLoginState(page);
    console.log(`[login] start account=${accountId} -> ${result.status}${"kind" in result ? "/" + result.kind : ""} url=${page.url()}`);
    if (result.status === "authenticated") {
      await persistLogin(accountId, ctx, page);
      await ctx.close();
      return result;
    }
    if (result.status === "challenge" && result.kind !== "captcha") {
      pendingLogins.set(accountId, { ctx, page, createdAt: Date.now() });
      return result;
    }
    await ctx.close();
    return result;
  } catch (e) {
    console.log(`[login] start account=${accountId} ERROR ${(e as Error).message} url=${page.url()}`);
    try { await ctx.close(); } catch { /* ignore */ }
    return { status: "error", message: (e as Error).message };
  }
}

export async function submitLoginChallenge(accountId: string, code: string): Promise<LoginResult> {
  const p = pendingLogins.get(accountId);
  if (!p) return { status: "error", message: "No login in progress (it may have timed out — start again)." };

  const { ctx, page } = p;
  try {
    const pin = page.locator(PIN_SELECTOR).first();
    await pin.waitFor({ state: "visible", timeout: 15_000 });
    await pin.fill(code);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      pin.press("Enter"),
    ]);

    const result = await classifyLoginState(page);
    console.log(`[login] verify account=${accountId} -> ${result.status}${"kind" in result ? "/" + result.kind : ""} url=${page.url()}`);
    if (result.status === "authenticated") {
      await persistLogin(accountId, ctx, page);
      await clearPendingLogin(accountId);
      return result;
    }
    if (result.status === "challenge" && result.kind !== "captcha") {
      p.createdAt = Date.now(); // keep the session alive for another step
      return result;
    }
    await clearPendingLogin(accountId);
    return result.status === "error"
      ? result
      : { status: "error", message: "Code rejected or login failed." };
  } catch (e) {
    await clearPendingLogin(accountId);
    return { status: "error", message: (e as Error).message };
  }
}

/**
 * Wait for a device/app-approval challenge to clear. Called after the user
 * approves the sign-in in their LinkedIn mobile app — the checkpoint page then
 * auto-advances to the feed. Also dismisses a possible "remember this browser?"
 * interstitial. If still pending, returns the challenge so the user can retry.
 */
export async function awaitLoginApproval(accountId: string): Promise<LoginResult> {
  const p = pendingLogins.get(accountId);
  if (!p) return { status: "error", message: "No login in progress (it may have timed out — start again)." };

  const { ctx, page } = p;
  p.createdAt = Date.now();
  try {
    const reachedFeed = await page
      .waitForURL(/\/feed\/|linkedin\.com\/sales\//, { timeout: 50_000 })
      .then(() => true)
      .catch(() => false);

    if (!reachedFeed) {
      // Possible post-approval interstitial (e.g. "remember this browser?")
      const btn = page
        .locator("button[type=submit]:visible, button:has-text('Yes'):visible, button:has-text('Ja'):visible")
        .first();
      if ((await btn.count().catch(() => 0)) > 0) {
        await btn.click().catch(() => {});
        await page.waitForURL(/\/feed\/|linkedin\.com\/sales\//, { timeout: 20_000 }).catch(() => {});
      }
    }

    const result = await classifyLoginState(page);
    console.log(`[login] await account=${accountId} -> ${result.status}${"kind" in result ? "/" + result.kind : ""} url=${page.url()}`);
    if (result.status === "authenticated") {
      await persistLogin(accountId, ctx, page);
      await clearPendingLogin(accountId);
      return result;
    }
    if (result.status === "challenge" && result.kind !== "captcha") {
      p.createdAt = Date.now();
      return result;
    }
    await clearPendingLogin(accountId);
    return result;
  } catch (e) {
    await clearPendingLogin(accountId);
    return { status: "error", message: (e as Error).message };
  }
}
