import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * N7b — null vanity as a CLASS, not a single site.
 *
 * N7's one-line fix closed the invitation path. It did not close the class:
 * every consumer that treats a vanity as present-or-absent has to decide what
 * absence means, and the answers were inconsistent.
 *
 * Reachability is established without any claim about LinkedIn's own URLs:
 * `resolveLinkedinUrl` gated on `linkedin_url?.includes("/in/")` — a substring
 * test — and `POST /api/targets` validates only that the field is truthy. Any
 * operator pasting a truncated URL gets there.
 */

const dbDir = mkdtempSync(join(tmpdir(), "linki-null-vanity-test-"));
process.env.LINKI_DB_PATH = join(dbDir, "test.db");
process.env.NEXTAUTH_SECRET ??= "test-secret-for-null-vanity-tests";

const runner = await import("@/lib/linkedin/runner");
const { shouldUnmarkPhantom } = await import("@/lib/linkedin/sync-accepted");
const { vanityNameOf } = await import("@/lib/linkedin/connect");
const { getDb } = await import("@/lib/db");

after(() => {
  try { getDb().close(); } catch { /* never opened */ }
  rmSync(dbDir, { recursive: true, force: true });
});

/** Shapes that pass the old `includes("/in/")` gate and yield no vanity. */
const NULL_VANITY_URLS = [
  "https://www.linkedin.com/in/",
  "https://example.com/in/",
  "linkedin.com/in/?trk=x",
  "https://www.linkedin.com/in//",
];

/**
 * The subset that is null-vanity AND ON LINKEDIN.
 *
 * NF-9 added a host check that runs BEFORE the vanity check, so the other two
 * shapes above are now refused as untrusted hosts instead — a stricter refusal,
 * for a more serious reason. The original guarantee ("every one of these four is
 * refused") is preserved below and unchanged; this subset exists so the
 * null-vanity error can still be asserted precisely, on a host that is allowed.
 */
const NULL_VANITY_ON_LINKEDIN = [
  "https://www.linkedin.com/in/",
  "https://www.linkedin.com/in//",
];

// ─── §3.1 systemic guard at the source ───────────────────────────────────────

test("N7b: the old gate was a substring test, and these four satisfy it", () => {
  // The premise, executed rather than asserted. If this ever stops holding, the
  // guard below is protecting against nothing and should be re-justified.
  for (const url of NULL_VANITY_URLS) {
    assert.ok(url.includes("/in/"), `${url} must satisfy the old gate`);
    assert.equal(vanityNameOf(url), null, `${url} must yield no vanity`);
  }
  assert.equal(vanityNameOf("https://www.linkedin.com/in/real-person/"), "real-person");
});

test("N7b: resolveLinkedinUrl REFUSES every stored URL with no resolvable vanity", async () => {
  // The original guarantee, unchanged: all four are refused. Which error depends
  // on WHY — NF-9's host check runs first and is the more serious finding — so
  // this asserts refusal, and the test below pins the null-vanity error itself.
  for (const url of NULL_VANITY_URLS) {
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => runner.resolveLinkedinUrl(getDb(), { id: "t1", full_name: "Someone", linkedin_url: url } as any, "acct-1"),
      (err: unknown) => err instanceof Error &&
        (err.name === "UnresolvableProfileUrlError" || err.name === "UntrustedProfileHostError"),
      `${url} must be refused at the source`
    );
  }
});

test("N7b: a null vanity ON LINKEDIN raises the null-vanity error specifically", async () => {
  for (const url of NULL_VANITY_ON_LINKEDIN) {
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => runner.resolveLinkedinUrl(getDb(), { id: "t1", full_name: "Someone", linkedin_url: url } as any, "acct-1"),
      (err: unknown) => err instanceof Error && err.name === "UnresolvableProfileUrlError",
      `${url} is on an allowed host, so the refusal must be about the vanity`
    );
  }
});

test("N7b: a valid URL still resolves untouched", async () => {
  const good = "https://www.linkedin.com/in/real-person/";
  const out = await runner.resolveLinkedinUrl(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getDb(), { id: "t2", full_name: "Real Person", linkedin_url: good } as any, "acct-1"
  );
  assert.equal(out, good, "the guard must not become 'refuse everything'");
});

test("N7b/I9: the refusal names the target, never the URL", async () => {
  // The URL is user-supplied and this message reaches logs.
  // On an ALLOWED host, so this exercises the null-vanity error rather than
  // NF-9's host error (which deliberately does name the host — see that entry).
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runner.resolveLinkedinUrl(getDb(), { id: "t3", full_name: "Someone", linkedin_url: "https://www.linkedin.com/in/?token=SECRET123" } as any, "a");
    assert.fail("should have thrown");
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, /Someone/);
    assert.ok(!msg.includes("SECRET123"), "a query parameter may carry a token — never echo the URL");
    assert.ok(!msg.includes("linkedin.com/in/?"), "must not echo the URL");
  }
});

// ─── §3.3 the absence inference, at the site where it is actually wrong ──────

test("N7b repro: an unidentifiable contact must NOT be un-marked as a phantom", () => {
  // The destructive case. `!v || !seen.has(v)` treated "could not parse a
  // vanity" as "definitely gone from the authoritative list". The selection is
  // `linkedin_url LIKE '%/in/%'`, so such a row IS selected — and a real,
  // accepted connection had its degree and connected_at wiped on every
  // verified-complete pass, taking the record of when it was made with it.
  const seen = new Set(["someone-real", "another-person"]);
  for (const url of NULL_VANITY_URLS) {
    assert.equal(
      shouldUnmarkPhantom(url, seen), false,
      `${url} cannot be identified, so nothing may be inferred about it`
    );
  }
});

test("N7b: a genuinely absent contact IS still un-marked", () => {
  // The control that stops the fix becoming "never un-mark anything", which
  // would reinstate the phantom-degree=1 problem the pass exists to correct.
  const seen = new Set(["someone-real"]);
  assert.equal(shouldUnmarkPhantom("https://www.linkedin.com/in/vanished-person/", seen), true);
  assert.equal(shouldUnmarkPhantom("https://www.linkedin.com/in/someone-real/", seen), false,
    "and a present contact is left alone");
});

test("N7b: matching is case- and encoding-insensitive, as before", () => {
  // Behaviour preserved through the extraction — the original lowercased and
  // decoded, and a regression here would un-mark real connections.
  const seen = new Set(["someone-real"]);
  assert.equal(shouldUnmarkPhantom("https://www.linkedin.com/in/Someone-Real/", seen), false);
  assert.equal(shouldUnmarkPhantom("https://www.linkedin.com/in/someone%2Dreal/", seen), false);
});
