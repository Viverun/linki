import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// session.ts opens the SQLite DB and encrypts with NEXTAUTH_SECRET at call
// time, so point both at throwaway values BEFORE the module is loaded.
const dbDir = mkdtempSync(join(tmpdir(), "linki-session-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-session-guard-tests";

const {
  findAuthCookie,
  isAuthenticatedStorageState,
  isLoggedInAppUrl,
  persistAuthenticatedState,
  refreshStoredSessionState,
  AuthenticationNotEstablishedError,
} = await import("./session");
const { getDb } = await import("@/lib/db");

// lib/db.ts caches one connection for the process and never closes it (correct
// for a long-lived server, but it leaves the WAL/SHM files and this temp dir
// behind after every test run). Close it here — test-side only — so SQLite
// checkpoints and releases the files before we delete the directory.
after(() => {
  try { getDb().close(); } catch { /* never opened, or already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────
// Cookie sets taken from real observed states. The "authwall" set is the exact
// cookie list found on the account that was stored as is_authenticated = 1 with
// no session at all (Aug 2026 phantom-auth incident).

const cookie = (name: string, value = "v", domain = ".linkedin.com") => ({
  name,
  value,
  domain,
  path: "/",
});

const state = (...names: string[]) => ({ cookies: names.map(n => cookie(n)), origins: [] });

/** A genuine post-login state. */
const AUTHENTICATED = {
  cookies: [
    cookie("li_at", "AQEDATEsomeRealLookingSessionToken"),
    cookie("JSESSIONID", '"ajax:1234"'),
    cookie("bcookie"),
    cookie("lidc"),
  ],
  origins: [],
};

/** The observed authwall state: tracking + remember-me, but no session. */
const AUTHWALL = state(
  "JSESSIONID", "PLAY_LANG", "__cf_bm", "bcookie", "bscookie", "fid", "lang",
  "li_rm", "li_theme", "li_theme_set", "lidc", "rtc", "sdui_ver", "timezone",
  "trkCode", "trkInfo"
);

let accountSeq = 0;
function makeAccount(): string {
  const id = `acct-${++accountSeq}`;
  getDb()
    .prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES (?, ?, ?, 0)")
    .run(id, `Test ${id}`, `${id}@example.com`);
  return id;
}

const flagOf = (id: string) =>
  (getDb().prepare("SELECT is_authenticated FROM accounts WHERE id = ?").get(id) as
    { is_authenticated: number }).is_authenticated;

const storedCookiesOf = (id: string) =>
  (getDb().prepare("SELECT cookies_json FROM accounts WHERE id = ?").get(id) as
    { cookies_json: string | null }).cookies_json;

// ─── (a) li_at present → authenticated ───────────────────────────────────────

test("storage state containing li_at is authenticated", () => {
  assert.equal(isAuthenticatedStorageState(AUTHENTICATED), true);
  assert.equal(findAuthCookie(AUTHENTICATED)?.value, "AQEDATEsomeRealLookingSessionToken");
});

test("persistAuthenticatedState marks the account authenticated when li_at is present", () => {
  const id = makeAccount();
  persistAuthenticatedState(id, AUTHENTICATED, "test");
  assert.equal(flagOf(id), 1);
  assert.notEqual(storedCookiesOf(id), null, "the state should be persisted");
});

// ─── (b) no li_at → not authenticated ────────────────────────────────────────

test("storage state without li_at is not authenticated", () => {
  assert.equal(isAuthenticatedStorageState(state("JSESSIONID", "bcookie", "lidc")), false);
  assert.equal(isAuthenticatedStorageState({ cookies: [], origins: [] }), false);
  assert.equal(isAuthenticatedStorageState(undefined), false);
});

test("persistAuthenticatedState refuses to write the flag when li_at is missing", () => {
  const id = makeAccount();
  assert.throws(
    () => persistAuthenticatedState(id, state("JSESSIONID", "bcookie"), "test"),
    AuthenticationNotEstablishedError
  );
  assert.equal(flagOf(id), 0, "must not be marked authenticated");
  assert.equal(storedCookiesOf(id), null, "must not persist the state as a successful login");
});

test("an empty or whitespace-only li_at is not a session", () => {
  assert.equal(isAuthenticatedStorageState({ cookies: [cookie("li_at", "")] }), false);
  assert.equal(isAuthenticatedStorageState({ cookies: [cookie("li_at", "   ")] }), false);
});

test("an li_at scoped to a non-LinkedIn domain is not a session", () => {
  assert.equal(
    isAuthenticatedStorageState({
      cookies: [cookie("li_at", "tok", ".evil.example")],
    }),
    false
  );
});

// ─── (c) li_rm without li_at → not authenticated ─────────────────────────────

test("li_rm without li_at is not authentication", () => {
  // li_rm is the remember-me cookie: LinkedIn sets it on a browser that has
  // NOT completed sign-in, so on its own it proves nothing.
  const s = state("li_rm", "bcookie", "lidc");
  assert.equal(isAuthenticatedStorageState(s), false);
  assert.equal(findAuthCookie(s), null);
});

// ─── (d) authwall / tracking cookies without li_at → not authenticated ───────

test("the observed authwall cookie set is not authentication", () => {
  assert.equal(isAuthenticatedStorageState(AUTHWALL), false);
});

test("trkCode/trkInfo authwall tracking cookies are not authentication", () => {
  assert.equal(isAuthenticatedStorageState(state("trkCode", "trkInfo")), false);
});

test("the exact phantom-auth state can never be stored as authenticated", () => {
  // End-to-end regression guard for the incident: this is the state that was
  // found in the DB alongside is_authenticated = 1.
  const id = makeAccount();
  assert.throws(
    () => persistAuthenticatedState(id, AUTHWALL, "test"),
    (e: unknown) =>
      e instanceof AuthenticationNotEstablishedError &&
      /li_at/.test(e.message) &&
      e.cookieNames.includes("trkInfo")
  );
  assert.equal(flagOf(id), 0);
});

// ─── saveSessionState's mid-run branch ───────────────────────────────────────

test("a mid-run session refresh clears the flag instead of throwing when li_at is gone", () => {
  // The runner calls this immediately before recording a sent invite/message,
  // so it must not throw — but it also must not leave is_authenticated = 1.
  const id = makeAccount();
  persistAuthenticatedState(id, AUTHENTICATED, "test");
  assert.equal(flagOf(id), 1);

  const before = storedCookiesOf(id);
  assert.equal(refreshStoredSessionState(id, AUTHWALL), "cleared");
  assert.equal(flagOf(id), 0, "a dead session must clear the flag");
  assert.equal(storedCookiesOf(id), before, "the authwall state must not overwrite the stored one");
});

test("a mid-run session refresh saves a still-valid session", () => {
  const id = makeAccount();
  assert.equal(refreshStoredSessionState(id, AUTHENTICATED), "saved");
  assert.equal(flagOf(id), 1);
});

// ─── URL classification ──────────────────────────────────────────────────────

test("an authwall URL is not a logged-in URL even when it embeds /sales/ or /feed/", () => {
  // The regression that let an authwall classify as authenticated: the
  // destination is echoed back inside the authwall's own query string.
  assert.equal(
    isLoggedInAppUrl(
      "https://www.linkedin.com/authwall?trk=bf&original_referer=https://www.linkedin.com/sales/&sessionRedirect=https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F"
    ),
    false
  );
  assert.equal(isLoggedInAppUrl("https://www.linkedin.com/login?session_redirect=/feed/"), false);
  assert.equal(isLoggedInAppUrl("https://www.linkedin.com/checkpoint/challenge/"), false);
});

test("real logged-in URLs still classify as logged in", () => {
  assert.equal(isLoggedInAppUrl("https://www.linkedin.com/feed/"), true);
  assert.equal(isLoggedInAppUrl("https://www.linkedin.com/sales/home"), true);
  assert.equal(isLoggedInAppUrl("https://www.linkedin.com/sales/"), true);
});

test("non-LinkedIn hosts never classify as logged in", () => {
  assert.equal(isLoggedInAppUrl("https://linkedin.com.evil.example/feed/"), false);
  assert.equal(isLoggedInAppUrl("not a url"), false);
});
