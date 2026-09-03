/**
 * NF-9: what counts as a LinkedIn profile URL the runner may navigate to.
 *
 * A LEAF. It imports nothing, so the check is available to anything that needs
 * it without dragging a module graph along.
 *
 * ── why a host check outranks the vanity check ───────────────────────────────
 *
 * N7b closed the case where a URL yields no vanity. It did not close the case
 * where a URL yields a perfectly good vanity on somebody else's domain:
 *
 *     https://example.com/in/bob             -> vanity "bob"
 *     https://linkedin.com.evil.tld/in/bob   -> vanity "bob"
 *     https://evil.tld/?x=.../in/bob         -> vanity "bob"
 *
 * All three cleared the old `includes("/in/")` gate AND the null-vanity guard,
 * because a vanity was parsed. Verified by execution.
 *
 * The consequence is a different and worse class than N7's. A null vanity wastes
 * a step, or invites a bystander *on LinkedIn*. A foreign host points the
 * **authenticated browser** at attacker-chosen content. Cookies are
 * domain-scoped so the session itself does not leak, but the page is loaded in
 * the same browser context as a live LinkedIn session, with whatever that
 * implies for renderer exploits, downloads, and anything the automation then
 * clicks believing it is on a profile.
 *
 * ── the allowlist ───────────────────────────────────────────────────────────
 *
 * `linkedin.com` and any subdomain. Deliberately not narrowed to
 * `www.linkedin.com`: public profile URLs appear in regional forms
 * (`uk.linkedin.com/in/...`) that LinkedIn itself hands out, and the codebase
 * already uses both `https://www.linkedin.com` (35 occurrences) and
 * `https://linkedin.com` (1). Narrowing to the `www` form would break
 * enrichment for a legitimate profile — the over-reach failure this guard must
 * not commit.
 *
 * The pattern is suffix-anchored, which is the whole point:
 * `linkedin.com.evil.tld` ends with `.evil.tld`, not with `linkedin.com`, so it
 * is refused. A `includes("linkedin.com")` test would accept it — that is the
 * bug class this replaces, one level up from the `/in/` substring gate.
 *
 * The same expression already exists at `lib/linkedin/session.ts:514` inside
 * `isLoggedInAppUrl`, which runs AFTER navigation and answers a different
 * question ("did we land on the logged-in app?"). Consolidating the two is
 * Phase 3 work: it means editing a Ground Rule 5 module for a refactor rather
 * than a defect.
 */

const LINKEDIN_HOST = /(^|\.)linkedin\.com$/;

/**
 * True when `raw` is an absolute http(s) URL on linkedin.com or a subdomain.
 *
 * Says nothing about the path — the vanity check is a separate concern and the
 * two compose. A scheme-less string (`linkedin.com/in/bob`) is REFUSED: `new
 * URL` cannot resolve it, and `page.goto` would be left to guess. Normalising
 * user input belongs at the API boundary, not here; failing closed is the right
 * behaviour for a value that is about to steer a browser.
 */
export function isAllowedLinkedinUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return LINKEDIN_HOST.test(url.hostname);
}

const VANITY_RE = /\/in\/([^/?#]+)/;

/**
 * Phase 4: the vanity in a profile URL, or null. Same expression as
 * `vanityNameOf` in lib/linkedin/connect.ts, but composed with the host
 * allowlist so `https://example.com/in/bob` yields null instead of "bob" —
 * and dependency-free, so API routes can validate input shape without
 * importing the browser-automation graph.
 */
export function profileVanityOf(raw: string | null | undefined): string | null {
  if (!isAllowedLinkedinUrl(raw)) return null;
  return (raw as string).match(VANITY_RE)?.[1]?.toLowerCase() ?? null;
}
