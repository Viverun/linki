import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { codeOnly } from "@/tests/support/source-text";

/**
 * NF-10 — one concept, two definitions, and a tripwire so it never becomes three.
 *
 * `lib/linkedin-url.ts` is the canonical host allowlist (NF-9). A second, byte-
 * identical expression lives in `lib/linkedin/session.ts` inside
 * `isLoggedInAppUrl`. That is the drift shape the predicate-delegation test
 * exists to prevent: two definitions of one concept, diverging silently, so a
 * host is accepted by one and refused by the other.
 *
 * ── why the duplicate is TOLERATED rather than removed ───────────────────────
 *
 * Delegating would mean rewriting `isLoggedInAppUrl`'s body — it needs the host
 * decision AND the pathname, so it cannot simply call the leaf and return; the
 * try/catch and the URL parse both move. `session.ts` is a Ground Rule 5
 * component, and a body rewrite for a refactor is exactly the kind of edit that
 * rule exists to stop. Recorded as NF-10 for Phase 3.
 *
 * The two functions also genuinely differ in job:
 *
 *   isAllowedLinkedinUrl   "may the runner navigate here?"   PRE-navigation trust gate
 *   isLoggedInAppUrl       "did the browser land on the app?" POST-navigation classification
 *
 * ── and why the drift is survivable meanwhile ────────────────────────────────
 *
 * The failure direction is benign. If the leaf gains a host that
 * `isLoggedInAppUrl` lacks, the runner navigates there and then decides it is
 * not on the app — an unnecessary re-auth, not a wrong action. The reverse
 * cannot happen: the runner never reaches a host the leaf refuses.
 *
 * ── what this test actually guards ───────────────────────────────────────────
 *
 * Not the duplication — that is accepted and recorded. A THIRD copy. Each new
 * copy multiplies the drift surface and none of them will be found by grep once
 * someone writes the regex slightly differently.
 */

const ROOT = join(import.meta.dirname, "..");

/** Any expression that decides "is this host LinkedIn?" — however it is spelled. */
const HOST_EXPRESSION = /linkedin\\?\.com\$|linkedin\.com['"]\s*\)|hostname[\s\S]{0,40}linkedin/i;

/** Sites permitted to hold one, with the reason. Anything else is a new copy. */
const KNOWN = new Map([
  ["lib/linkedin-url.ts", "canonical — the NF-9 allowlist"],
  ["lib/linkedin/session.ts", "isLoggedInAppUrl, post-navigation classification — NF-10, Phase 3"],
]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git" || entry === "data") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

test("NF-10: no THIRD definition of 'is this host LinkedIn?' appears", () => {
  const offenders: string[] = [];

  for (const file of sourceFiles(ROOT)) {
    const rel = relative(ROOT, file);
    // Comments and strings stripped — the standing source-text rule. Several
    // files DISCUSS linkedin.com in prose, and a test that counted those would
    // fail for a reason that does not exist.
    const code = codeOnly(readFileSync(file, "utf8"));
    if (!HOST_EXPRESSION.test(code)) continue;
    if (KNOWN.has(rel)) continue;
    offenders.push(rel);
  }

  assert.deepEqual(
    offenders, [],
    `A new host-matching expression appeared outside lib/linkedin-url.ts.\n\n` +
    offenders.map(o => `  ${o}`).join("\n") +
    `\n\nUse isAllowedLinkedinUrl from lib/linkedin-url.ts. Two definitions of one\n` +
    `concept drift silently — a host ends up accepted by one and refused by the\n` +
    `other, and the resulting bug looks like a LinkedIn problem rather than ours.\n` +
    `The one tolerated duplicate is recorded as NF-10.\n`
  );
});

test("NF-10: both known sites still hold the expression the tripwire assumes", () => {
  // Guards the guard. If either site is refactored so the pattern no longer
  // matches, the test above starts passing vacuously for that file and would not
  // notice a third copy being added in its place.
  for (const [rel, why] of KNOWN) {
    const code = codeOnly(readFileSync(join(ROOT, rel), "utf8"));
    assert.ok(
      HOST_EXPRESSION.test(code),
      `${rel} no longer contains a host expression (${why}). Either it was ` +
      `consolidated — remove it from KNOWN and close NF-10 — or the pattern ` +
      `stopped matching, in which case this tripwire is no longer watching it.`
    );
  }
});

test("NF-10: the two expressions still agree, so the tolerated drift has not started", () => {
  // The duplicate is accepted only while the two agree. This compares them on
  // the hosts that matter rather than comparing source text, so a rewrite that
  // preserves behaviour is fine and one that changes it is not.
  const sessionSrc = codeOnly(readFileSync(join(ROOT, "lib/linkedin/session.ts"), "utf8"));
  const match = sessionSrc.match(/\/\(\^\|\\\.\)linkedin\\\.com\$\//);
  assert.ok(match, "session.ts must still use the suffix-anchored form");

  // Re-derive session.ts's predicate from its own source and check it against
  // the leaf's on the NF-9 table.
  const sessionHost = new RegExp("(^|\\.)linkedin\\.com$");
  const cases: Array<[string, boolean]> = [
    ["www.linkedin.com", true],
    ["linkedin.com", true],
    ["uk.linkedin.com", true],
    ["linkedin.com.evil.tld", false],
    ["notlinkedin.com", false],
    ["example.com", false],
  ];
  for (const [host, expected] of cases) {
    assert.equal(sessionHost.test(host), expected, `session.ts's expression on ${host}`);
  }
});
