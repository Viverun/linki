import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * NF-9 — the gate validated a substring, not a host.
 *
 * N7b closed the null-vanity case. It left open the case where a URL yields a
 * perfectly good vanity on somebody else's domain: `https://example.com/in/bob`
 * parses `bob`, so it cleared the `includes("/in/")` gate AND the null guard.
 *
 * The consequence is a worse class than N7's. A null vanity wastes a step or
 * invites a bystander on LinkedIn; a foreign host points the AUTHENTICATED
 * BROWSER at attacker-chosen content. So the tests below assert not merely that
 * a refusal happens, but that NOTHING WAS NAVIGATED — the throw is worthless if
 * the page has already loaded.
 */

const dbDir = mkdtempSync(join(tmpdir(), "linki-host-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-host-tests";

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { exports: Record<string, unknown> }) => void;

/** Every browser acquisition the runner attempts. Must stay empty on refusal. */
const pageRequests: string[] = [];
/** Set by the exit-2 tests; null means "a browser request is itself the bug". */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let salesNavPageFactory: (() => any) | null = null;
const realSession = await import("@/lib/linkedin/session");

mockModule("@/lib/linkedin/session", {
  exports: {
    ...realSession,
    getSessionPage: async (accountId: string) => {
      pageRequests.push(accountId);
      // Exit-1 tests assert pageRequests stays EMPTY, so any call there is
      // already a failure. Exit-2 tests install a factory to be served instead.
      if (salesNavPageFactory) return salesNavPageFactory();
      throw new Error("no browser in tests — reaching here at all is the failure");
    },
  },
});

const runner = await import("@/lib/linkedin/runner");
const { isAllowedLinkedinUrl } = await import("@/lib/linkedin-url");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const target = (url: string) => ({ id: "t1", full_name: "Someone", linkedin_url: url }) as any;

const REFUSED = [
  ["https://example.com/in/bob", "a plainly foreign host with a valid-looking vanity"],
  ["https://linkedin.com.evil.tld/in/bob", "the look-alike: ends with .evil.tld, not linkedin.com"],
  ["https://evil.tld/?x=https://www.linkedin.com/in/bob", "the real host hidden in a query parameter"],
  ["https://notlinkedin.com/in/bob", "a suffix that is not a subdomain boundary"],
  ["http://linkedin.com.attacker.io/in/bob", "look-alike over plain http"],
  ["linkedin.com/in/bob", "scheme-less: page.goto would be left to guess"],
  ["javascript:alert(1)//in/bob", "not an http(s) URL at all"],
  ["ftp://linkedin.com/in/bob", "right host, wrong scheme — the case the protocol check exists for"],
  ["file:///in/bob", "a local file"],
];

const ACCEPTED = [
  ["https://www.linkedin.com/in/real-person/", "the form the codebase uses 35 times"],
  ["https://linkedin.com/in/real-person/", "the bare apex, used once"],
  ["https://uk.linkedin.com/in/real-person/", "a regional subdomain LinkedIn hands out"],
];

// ─── the predicate ───────────────────────────────────────────────────────────

test("NF-9: the allowlist accepts linkedin.com and its subdomains, and nothing else", () => {
  for (const [url, why] of REFUSED) {
    assert.equal(isAllowedLinkedinUrl(url), false, `${url} must be refused — ${why}`);
  }
  for (const [url, why] of ACCEPTED) {
    assert.equal(isAllowedLinkedinUrl(url), true, `${url} must be accepted — ${why}`);
  }
  assert.equal(isAllowedLinkedinUrl(null), false);
  assert.equal(isAllowedLinkedinUrl(""), false);
});

test("NF-9: a substring test would accept the look-alike — the anchor is the point", () => {
  // Documents exactly what the fix buys over the naive check, so a future
  // "simplification" back to includes() has to argue with a failing test.
  const lookalike = "https://linkedin.com.evil.tld/in/bob";
  assert.ok(lookalike.includes("linkedin.com"), "a substring check accepts it");
  assert.equal(isAllowedLinkedinUrl(lookalike), false, "the suffix-anchored check refuses it");
});

// ─── the guard, at the site that steers the browser ──────────────────────────

test("NF-9 repro: a foreign host is refused, and NOTHING is navigated", async () => {
  for (const [url] of REFUSED) {
    pageRequests.length = 0;
    await assert.rejects(
      () => runner.resolveLinkedinUrl(getDb(), target(url), "acct-1"),
      (err: unknown) => err instanceof Error &&
        (err.name === "UntrustedProfileHostError" || err.name === "UnresolvableProfileUrlError"),
      `${url} must be refused`
    );
    // The assertion that matters. A throw AFTER page.goto would leave the
    // hostile page already loaded in the authenticated browser.
    assert.deepEqual(pageRequests, [],
      `${url} must not have caused a browser page to be acquired`);
  }
});

test("NF-9: the foreign-host refusal is distinguishable from the null-vanity one", async () => {
  // Different operator responses: "fix the profile link" versus "work out how a
  // foreign URL got into the contact list". Collapsing them hides the second,
  // which is the more alarming.
  await assert.rejects(
    () => runner.resolveLinkedinUrl(getDb(), target("https://example.com/in/bob"), "a"),
    (err: unknown) => (err as Error).name === "UntrustedProfileHostError"
  );
  await assert.rejects(
    () => runner.resolveLinkedinUrl(getDb(), target("https://www.linkedin.com/in/"), "a"),
    (err: unknown) => (err as Error).name === "UnresolvableProfileUrlError"
  );
});

test("NF-9/I9: the error names the host, never the full URL", async () => {
  try {
    await runner.resolveLinkedinUrl(getDb(), target("https://evil.tld/in/bob?token=SECRET123"), "a");
    assert.fail("should have thrown");
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, /evil\.tld/, "the host is what the operator needs");
    assert.ok(!msg.includes("SECRET123"), "a query parameter may carry a token — never echo the URL");
  }
});

// ─── the over-reach control (docs/operations.md standing practice) ───────────

test("NF-9 over-reach control: every legitimate LinkedIn URL still resolves", async () => {
  // Normal mutations prove the guard does something. This proves it does not do
  // too much — a guard narrowed to `www.linkedin.com` would break enrichment for
  // regional profile URLs that LinkedIn itself hands out.
  for (const [url, why] of ACCEPTED) {
    pageRequests.length = 0;
    const out = await runner.resolveLinkedinUrl(getDb(), target(url), "acct-1");
    assert.equal(out, url, `${url} must pass through unchanged — ${why}`);
    assert.deepEqual(pageRequests, [], "and resolve without needing a browser at all");
  }
});

// ─── exit 2: the URL LinkedIn hands back ─────────────────────────────────────
// resolveLinkedinUrl has two exits and the tests above only reached the first.
// This one takes its URL from `flagshipProfileUrl` in a Sales Navigator API
// response — a value the runner does not control — and a mutation removing its
// host check survived everything above.

/** The minimum page surface exit 2 touches, wired to hand back a chosen profile JSON. */
function fakeSalesNavPage(flagshipProfileUrl: string) {
  let onResponse: ((r: unknown) => void) | null = null;
  return {
    on(event: string, handler: (r: unknown) => void) { if (event === "response") onResponse = handler; },
    async goto() {
      // Fire the response the real listener is waiting for.
      onResponse?.({
        url: () => "https://www.linkedin.com/sales-api/salesApiProfiles/urn:li:fs_salesProfile:(ABC)",
        status: () => 200,
        json: async () => ({ flagshipProfileUrl }),
      });
    },
    async waitForTimeout() { /* immediate — the real one waits 10s */ },
    async close() { /* noop */ },
  };
}

test("NF-9: a hostile flagshipProfileUrl from the Sales Nav response is refused", async () => {
  const salesNavTarget = {
    id: "t-sn", full_name: "Someone",
    linkedin_url: null,
    sales_nav_url: "https://www.linkedin.com/sales/lead/ABC,NAME_SEARCH",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  for (const hostile of [
    "https://example.com/in/bob",
    "https://linkedin.com.evil.tld/in/bob",
  ]) {
    salesNavPageFactory = () => fakeSalesNavPage(hostile);
    await assert.rejects(
      () => runner.resolveLinkedinUrl(getDb(), salesNavTarget, "acct-1"),
      (err: unknown) => (err as Error).name === "UntrustedProfileHostError",
      `${hostile} arriving from LinkedIn's own payload must still be refused`
    );
  }
});

test("NF-9 over-reach: a legitimate flagshipProfileUrl still resolves", async () => {
  const salesNavTarget = {
    id: "t-sn2", full_name: "Someone",
    linkedin_url: null,
    sales_nav_url: "https://www.linkedin.com/sales/lead/ABC,NAME_SEARCH",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  salesNavPageFactory = () => fakeSalesNavPage("https://www.linkedin.com/in/real-person");
  const out = await runner.resolveLinkedinUrl(getDb(), salesNavTarget, "acct-1");
  assert.equal(out, "https://www.linkedin.com/in/real-person/", "and gains its trailing slash as before");
});
