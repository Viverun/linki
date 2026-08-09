import test from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";

const { visitProfile } = await import("@/lib/linkedin/visit");

const URL = "https://www.linkedin.com/in/someone-123/";
const URN = "urn:li:fsd_profile:ACoAADummyObservation";
const composeHref = `/messaging/compose/?profileUrn=${encodeURIComponent(URN)}&recipient=x&screenContext=NON_SELF_PROFILE_VIEW`;

// ─── fake page ───────────────────────────────────────────────────────────────
// The degree contract is element-level and visibility-sensitive, so the fake
// models paragraphs as { text, visible } pairs rather than as a count or a blob
// of card text. That is what makes "hidden · 1st" and "visible · 2nd" genuinely
// distinguishable here instead of accidentally passing:
//   - `p:visible` must drop hidden paragraphs (a connected card really does
//     ship a hidden `· 2nd` next to the visible `· 1st`);
//   - filter({hasText: /^·?\s*1st$/}) is anchored per element, so prose such as
//     "Partner at 1st Round Capital" must not match even though it contains
//     "1st";
//   - the card's own innerText is deliberately NOT consulted by the production
//     code, so this fake exposes it while keeping it irrelevant.

interface Para { text: string; visible: boolean }
interface Doc {
  hasTopCard: boolean;
  paras: Para[];
  composeHref: string | null;
}

const visible = (text: string): Para => ({ text, visible: true });
const hidden = (text: string): Para => ({ text, visible: false });

class FL {
  // Explicit fields, not constructor parameter properties: Node's strip-only
  // TypeScript mode rejects those outright (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  d: Doc;
  sel: string;
  scope: "page" | "card";
  hasText: string | RegExp | null;
  constructor(d: Doc, sel: string, scope: "page" | "card", hasText: string | RegExp | null = null) {
    this.d = d; this.sel = sel; this.scope = scope; this.hasText = hasText;
  }
  first(): FL { return this; }
  filter(o?: { hasText?: string | RegExp }): FL {
    return o?.hasText === undefined ? this : new FL(this.d, this.sel, this.scope, o.hasText);
  }
  locator(sel: string): FL {
    // Only the top-card locator yields card scope; anything else stays page-wide.
    return new FL(this.d, sel, this.sel.includes('componentkey$="Topcard"') ? "card" : this.scope);
  }
  private paraMatches(): number {
    if (this.scope !== "card") return 0;
    const onlyVisible = this.sel.endsWith(":visible");
    return this.d.paras.filter(p => {
      if (onlyVisible && !p.visible) return false;
      const n = p.text.replace(/\s+/g, " ").trim();
      if (this.hasText === null) return true;
      return typeof this.hasText === "string" ? n.includes(this.hasText) : this.hasText.test(n);
    }).length;
  }
  private matches(): number {
    if (this.sel.includes('componentkey$="Topcard"')) return this.d.hasTopCard ? 1 : 0;
    if (this.sel.startsWith("main section")) return 0;              // legacy layout absent
    if (this.sel === "p" || this.sel === "p:visible") return this.paraMatches();
    if (this.sel.includes("/messaging/compose")) return this.scope === "card" && this.d.composeHref ? 1 : 0;
    return 0;
  }
  async count(): Promise<number> { return this.matches(); }
  async getAttribute(n: string): Promise<string | null> {
    return n === "href" && this.scope === "card" && this.sel.includes("/messaging/compose")
      ? this.d.composeHref
      : null;
  }
  async innerText(): Promise<string> {
    return this.scope === "card" || this.sel.includes('componentkey$="Topcard"')
      ? this.d.paras.map(p => p.text).join(" ")
      : "";
  }
}

class FP {
  d: Doc;
  constructor(d: Doc) { this.d = d; }
  url(): string { return URL; }
  async goto(): Promise<void> {}
  async waitForTimeout(): Promise<void> {}
  locator(sel: string): FL { return new FL(this.d, sel, "page"); }
}

const mk = (d: Partial<Doc> = {}): Page =>
  new FP({ hasTopCard: true, paras: [], composeHref: null, ...d }) as unknown as Page;

// ─── fake fidelity ───────────────────────────────────────────────────────────
// If these fail, every assertion below is meaningless.

test("fake: p:visible excludes hidden paragraphs", async () => {
  const page = mk({ paras: [hidden("· 1st"), visible("· 2nd")] });
  const card = new FL({ hasTopCard: true, paras: [hidden("· 1st"), visible("· 2nd")], composeHref: null },
    '[componentkey$="Topcard"]', "page");
  assert.equal(await card.locator("p:visible").count(), 1, "only the visible paragraph may match");
  assert.equal(await card.locator("p").count(), 2, "unfiltered `p` must still see both");
  assert.ok(page);
});

test("fake: hasText filtering is anchored per element, not substring over the card", async () => {
  const card = new FL(
    { hasTopCard: true, paras: [visible("Partner at 1st Round Capital")], composeHref: null },
    '[componentkey$="Topcard"]', "page",
  );
  assert.equal(await card.locator("p:visible").filter({ hasText: /^·?\s*1st$/ }).count(), 0);
  assert.equal(await card.locator("p:visible").filter({ hasText: "1st" }).count(), 1,
    "a substring filter WOULD match — proving the anchored regex is what saves us");
});

// ─── A. top card absent → inconclusive ───────────────────────────────────────

test("A no top card → inconclusive, not a negative observation", async () => {
  const r = await visitProfile(mk({ hasTopCard: false, composeHref }), URL);

  assert.deepEqual(r, { degree: "inconclusive", isFirstDegree: false, messagingUrn: null });
});

test("A2 inconclusive is returned even when compose links exist page-wide", async () => {
  // A sidebar full of other people's compose links must not upgrade the
  // observation: without the card there is nothing to observe.
  const r = await visitProfile(mk({ hasTopCard: false, paras: [visible("· 1st")], composeHref }), URL);

  assert.equal(r.degree, "inconclusive");
});

// ─── B. visible 1st badge → first_degree ─────────────────────────────────────

test("B visible '· 1st' badge → first_degree with the URN extracted", async () => {
  const r = await visitProfile(mk({ paras: [visible("Someone"), visible("· 1st")], composeHref }), URL);

  assert.deepEqual(r, { degree: "first_degree", isFirstDegree: true, messagingUrn: URN });
});

test("B2 first_degree with no compose link → connected, URN null", async () => {
  const r = await visitProfile(mk({ paras: [visible("· 1st")], composeHref: null }), URL);

  assert.deepEqual(r, { degree: "first_degree", isFirstDegree: true, messagingUrn: null });
});

test("B3 the real connected card — visible '· 1st' beside a hidden '· 2nd'", async () => {
  // Exactly what the live DOM ships (verified Aug 2026).
  const r = await visitProfile(mk({ paras: [visible("· 1st"), hidden("· 2nd")], composeHref }), URL);

  assert.equal(r.degree, "first_degree");
});

// ─── C. card found, no badge → not_first_degree ──────────────────────────────

test("C card found with no degree badge → not_first_degree", async () => {
  const r = await visitProfile(mk({ paras: [visible("Someone"), visible("Follow"), visible("Message")], composeHref }), URL);

  assert.deepEqual(r, { degree: "not_first_degree", isFirstDegree: false, messagingUrn: null });
});

test("C2 a profileUrn compose link is never promoted to a connection", async () => {
  // /in/raise-faster/ (NOT connected) and a confirmed 1st-degree both render
  // structurally identical profileUrn compose links.
  const r = await visitProfile(mk({ paras: [visible("Raise Faster"), visible("Message")], composeHref }), URL);

  assert.equal(r.degree, "not_first_degree");
  assert.equal(r.messagingUrn, null, "no URN may leak out of a non-connection");
});

// ─── D. hidden 1st badge → not_first_degree ──────────────────────────────────

test("D a HIDDEN '· 1st' does not count", async () => {
  const r = await visitProfile(mk({ paras: [visible("· 2nd"), hidden("· 1st")], composeHref }), URL);

  assert.equal(r.degree, "not_first_degree");
  assert.equal(r.messagingUrn, null);
});

// ─── E. visible 2nd badge → not_first_degree ─────────────────────────────────

test("E a visible '· 2nd' badge → not_first_degree", async () => {
  const r = await visitProfile(mk({ paras: [visible("Someone"), visible("· 2nd")], composeHref }), URL);

  assert.equal(r.degree, "not_first_degree");
});

test("E2 '· 3rd' likewise", async () => {
  const r = await visitProfile(mk({ paras: [visible("· 3rd")], composeHref }), URL);

  assert.equal(r.degree, "not_first_degree");
});

// ─── F. prose containing "1st" → not_first_degree ────────────────────────────

test("F prose containing '1st' is not a badge", async () => {
  for (const prose of [
    "Partner at 1st Round Capital",
    "1st Lieutenant, US Army",
    "Ranked 1st in EMEA",
    "1st",                              // control: this one IS badge-shaped
  ]) {
    const r = await visitProfile(mk({ paras: [visible(prose)], composeHref }), URL);
    const expected = prose === "1st" ? "first_degree" : "not_first_degree";
    assert.equal(r.degree, expected, `"${prose}" should be ${expected}`);
  }
});

// ─── invariants ──────────────────────────────────────────────────────────────

test("isFirstDegree is true for first_degree only — both negatives fail closed", async () => {
  const cases: Array<[Partial<Doc>, string, boolean]> = [
    [{ hasTopCard: false }, "inconclusive", false],
    [{ paras: [visible("Follow")] }, "not_first_degree", false],
    [{ paras: [visible("· 1st")] }, "first_degree", true],
  ];
  for (const [doc, degree, isFirstDegree] of cases) {
    const r = await visitProfile(mk({ composeHref, ...doc }), URL);
    assert.equal(r.degree, degree);
    assert.equal(r.isFirstDegree, isFirstDegree, `isFirstDegree must be ${isFirstDegree} for ${degree}`);
  }
});

test("a URN is returned only alongside first_degree", async () => {
  for (const doc of [{ hasTopCard: false }, { paras: [visible("Message")] }, { paras: [hidden("· 1st")] }]) {
    const r = await visitProfile(mk({ composeHref, ...doc }), URL);
    assert.equal(r.messagingUrn, null, `${r.degree} must not carry a URN`);
  }
});
