import test from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";

const { visitProfile } = await import("@/lib/linkedin/visit");
const { sendMessage, NotConnectedError } = await import("@/lib/linkedin/message");

const URL = "https://www.linkedin.com/in/vivi-undefined-b08a99423/";

// ─── fake page ───────────────────────────────────────────────────────────────
// Models only what findTopCard() and visitProfile() actually query:
//  - the SDUI card, matched by [componentkey$="Topcard"];
//  - the legacy card, matched by `main section` filtered on a nested <h1>;
//  - the compose link scoped INSIDE whichever card was found.
// "none" reproduces the live regression: an SDUI page seen through the old
// <h1>-only locator, where nothing matches at all.

type Layout = "sdui" | "legacy" | "none";

interface ProfileState {
  layout: Layout;
  /** visible <p> elements in the card; the degree badge is <p>· 1st</p> */
  paras: string[];
  /** text of the target's own top card */
  topCardText: string;
  /** href of the compose link inside the target's own card, if any */
  composeHref: string | null;
}

type Kind = "sduiCard" | "mainSection" | "compose" | "para" | "other";

class FakeLocator {
  st: ProfileState;
  kind: Kind;
  filtered: boolean;
  parentExists = false;
  constructor(st: ProfileState, kind: Kind, filtered = false) {
    this.st = st;
    this.kind = kind;
    this.filtered = filtered;
  }
  /** Does this card locator actually match anything on this layout? */
  private cardExists(): boolean {
    if (this.kind === "sduiCard") return this.st.layout === "sdui";
    // the legacy card only matches once filtered on its nested <h1>
    if (this.kind === "mainSection") return this.filtered && this.st.layout === "legacy";
    return false;
  }
  hasText: string | RegExp | null = null;
  first(): FakeLocator { return this; }
  filter(o?: { hasText?: string | RegExp }): FakeLocator {
    if (o?.hasText === undefined) return new FakeLocator(this.st, this.kind, true);
    const l = new FakeLocator(this.st, this.kind, this.filtered);
    l.parentExists = this.parentExists; l.hasText = o.hasText; return l;
  }
  locator(sel: string): FakeLocator {
    // Scoped lookups inherit their parent: a card that matched nothing cannot
    // yield a compose link. This is what makes the old <h1>-only locator fail
    // on an SDUI page instead of silently finding a link anyway.
    if (sel.includes("/messaging/compose")) {
      const child = new FakeLocator(this.st, "compose");
      child.parentExists = this.cardExists();
      return child;
    }
    if (sel === "p" || sel === "p:visible") {
      const child = new FakeLocator(this.st, "para");
      child.parentExists = this.cardExists();
      return child;
    }
    return new FakeLocator(this.st, "other");
  }
  async count(): Promise<number> {
    if (this.kind === "sduiCard" || this.kind === "mainSection") return this.cardExists() ? 1 : 0;
    if (this.kind === "compose") return this.parentExists && this.st.composeHref ? 1 : 0;
    if (this.kind === "para") {
      if (!this.parentExists) return 0;
      const f = this.hasText;
      return this.st.paras.filter(t => {
        const n = t.replace(/\s+/g, " ").trim();
        return f === null ? true : typeof f === "string" ? n.includes(f) : f.test(n);
      }).length;
    }
    return 0;
  }
  async getAttribute(name: string): Promise<string | null> {
    if (this.kind !== "compose" || name !== "href") return null;
    return this.parentExists ? this.st.composeHref : null;
  }
  async innerText(): Promise<string> {
    if (this.kind === "sduiCard" || this.kind === "mainSection") {
      // Playwright throws when the locator resolves to nothing.
      if (!this.cardExists()) throw new Error("no top card");
      return this.st.topCardText;
    }
    return "";
  }
}

class FakePage {
  st: ProfileState;
  constructor(st: ProfileState) { this.st = st; }
  async goto(): Promise<void> {}
  async waitForTimeout(): Promise<void> {}
  url(): string { return URL; }
  locator(sel: string): FakeLocator {
    if (sel.includes('componentkey$="Topcard"')) return new FakeLocator(this.st, "sduiCard");
    if (sel === "main section") return new FakeLocator(this.st, "mainSection");
    return new FakeLocator(this.st, "other");
  }
}

const pageFor = (st: Partial<ProfileState>): Page =>
  new FakePage({ layout: "sdui", topCardText: "", paras: [], composeHref: null, ...st }) as unknown as Page;

const URN = "urn:li:fsd_profile:ACoAADummyUrn123";
const composeHref = (urn: string) =>
  `https://www.linkedin.com/messaging/compose/?profileUrn=${encodeURIComponent(urn)}&recipient=x`;

// ─── (1) SDUI Topcard is recognised ──────────────────────────────────────────

test("the SDUI Topcard layout is recognised", async () => {
  // The live regression: this layout has no <h1>, so the old locator matched
  // nothing and every connected target read as NOT connected.
  const page = pageFor({ layout: "sdui", topCardText: "Vivi undefined 1st", paras: ["· 1st"], composeHref: composeHref(URN) });

  const result = await visitProfile(page, URL);

  assert.equal(result.isFirstDegree, true, "an SDUI card must be found, not silently missed");
});

// ─── (2) legacy layout still works ───────────────────────────────────────────

test("the legacy `main section` + h1 layout is still recognised", async () => {
  const page = pageFor({ layout: "legacy", topCardText: "Someone 1st", paras: ["· 1st"], composeHref: composeHref(URN) });

  const result = await visitProfile(page, URL);

  assert.equal(result.isFirstDegree, true);
  assert.equal(result.messagingUrn, URN);
});

// ─── (3) connected SDUI profile ──────────────────────────────────────────────

test("a connected SDUI profile returns isFirstDegree: true via the 1st badge", async () => {
  const page = pageFor({ layout: "sdui", topCardText: "Vivi undefined · 1st", paras: ["· 1st"], composeHref: composeHref(URN) });

  assert.deepEqual(await visitProfile(page, URL), { degree: "first_degree", isFirstDegree: true, messagingUrn: URN });
});

test("a '1st' badge with no compose link is first-degree with no URN", async () => {
  // Slice C: the badge is the connection signal. No compose link means no URN,
  // which is safe — sendMessage() raises MessagingUrnUnresolvedError rather
  // than searching for a recipient by name.
  const page = pageFor({ layout: "sdui", topCardText: "Vivi undefined · 1st · Mumbai", paras: ["· 1st"], composeHref: null });

  assert.deepEqual(await visitProfile(page, URL), { degree: "first_degree", isFirstDegree: true, messagingUrn: null });
});

// ─── (4) non-connected profiles ──────────────────────────────────────────────

test("a non-connected profile still returns isFirstDegree: false", async () => {
  const page = pageFor({ layout: "sdui", topCardText: "Someone · 3rd · Connect", composeHref: null });

  assert.deepEqual(await visitProfile(page, URL), { degree: "not_first_degree", isFirstDegree: false, messagingUrn: null });
});

test("no top card at all returns INCONCLUSIVE rather than throwing", async () => {
  // Not a negative observation: nothing was inspected, so a stored degree=1
  // must survive this. See tests/runner-visit-degree.test.ts case I.
  const page = pageFor({ layout: "none", topCardText: "", composeHref: null });

  assert.deepEqual(await visitProfile(page, URL), { degree: "inconclusive", isFirstDegree: false, messagingUrn: null });
});

// ─── (5) URN extraction is unchanged ─────────────────────────────────────────

test("the messaging URN is decoded from the compose link's profileUrn param", async () => {
  const page = pageFor({ layout: "sdui", topCardText: "x · 1st", paras: ["· 1st"], composeHref: composeHref(URN) });

  assert.equal((await visitProfile(page, URL)).messagingUrn, URN, "must be URL-decoded");
});

test("a compose link without profileUrn is NOT first-degree", async () => {
  // The raise-faster regression: a Follow-primary/non-connection profile renders
  // a Message button whose href carries no profileUrn.
  const page = pageFor({
    layout: "sdui",
    topCardText: "x",
    composeHref: "https://www.linkedin.com/messaging/compose/?recipient=x",
  });

  assert.deepEqual(await visitProfile(page, URL), { degree: "not_first_degree", isFirstDegree: false, messagingUrn: null });
});

// ─── (6) sendMessage still refuses a genuine non-connection ──────────────────

test("sendMessage refuses to message a genuinely non-1st-degree profile", async () => {
  // The safety guard must survive the fix: a real non-connection must still
  // raise NotConnectedError rather than falling through to the name-search
  // typeahead, which is what messaged an unrelated person in Jul 2026.
  const page = pageFor({ layout: "sdui", topCardText: "Someone · 3rd · Connect", composeHref: null });

  await assert.rejects(
    () => sendMessage(page, "Someone Else", "hello", URL, null),
    NotConnectedError
  );
});

test("sendMessage refuses when no top card can be resolved at all", async () => {
  const page = pageFor({ layout: "none", topCardText: "", composeHref: null });

  await assert.rejects(() => sendMessage(page, "Someone Else", "hello", URL, null), NotConnectedError);
});
