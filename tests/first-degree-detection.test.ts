import test from "node:test";
import assert from "node:assert/strict";
import type { Page, Locator } from "playwright";

const { assertConnectable, findTopCard, AlreadyConnectedError, PendingInviteError } =
  await import("@/lib/linkedin/connect");
const { visitProfile } = await import("@/lib/linkedin/visit");
const { sendMessage, NotConnectedError } = await import("@/lib/linkedin/message");

const URL = "https://www.linkedin.com/in/raise-faster/";
const URN = "urn:li:fsd_profile:ACoAADummyRaiseFaster";

/** A compose link carrying profileUrn — present on connections AND non-connections. */
const composeWithUrn = (urn = URN) =>
  `https://www.linkedin.com/messaging/compose/?profileUrn=${encodeURIComponent(urn)}&recipient=x`;
/** The Follow-primary / non-connection variant: compose link, no profileUrn. */
const composeWithoutUrn = "https://www.linkedin.com/messaging/compose/?recipient=raise-faster";

// ─── fake page ───────────────────────────────────────────────────────────────

interface Profile {
  hasTopCard: boolean;
  cardText: string;
  /** visible <p> elements in the card; the degree badge is <p>· 1st</p> */
  paras: string[];
  /** href of the compose link INSIDE the person's own top card */
  composeHref: string | null;
  /** a Connect CTA inside the top card */
  connectCta: boolean;
  /** the person's own vanity-matched Connect link, page-wide */
  ownConnectHref: string | null;
  pendingBadges: number;
  /** compose links belonging to OTHER people, outside the top card */
  sidebarComposeHrefs: string[];
}

const profile = (p: Partial<Profile> = {}): Profile => ({
  hasTopCard: true,
  cardText: "",
  paras: [],
  composeHref: null,
  connectCta: false,
  ownConnectHref: null,
  pendingBadges: 0,
  sidebarComposeHrefs: [],
  ...p,
});

interface Trace { typeaheadQueried: boolean; gotos: string[] }

type Scope = "page" | "topCard";

class FakeLocator {
  p: Profile;
  t: Trace;
  sel: string;
  scope: Scope;
  constructor(p: Profile, t: Trace, sel: string, scope: Scope = "page") {
    this.p = p; this.t = t; this.sel = sel; this.scope = scope;
  }
  hasText: string | RegExp | null = null;
  first(): FakeLocator { return this; }
  nth(): FakeLocator { return this; }
  filter(o?: { hasText?: string | RegExp }): FakeLocator {
    if (o?.hasText === undefined) return this;
    const l = new FakeLocator(this.p, this.t, this.sel, this.scope);
    l.hasText = o.hasText; return l;
  }
  locator(sel: string): FakeLocator { return new FakeLocator(this.p, this.t, sel, "topCard"); }

  private isCompose() { return this.sel.includes("/messaging/compose"); }

  async count(): Promise<number> {
    if (this.scope === "topCard") {
      if (!this.p.hasTopCard) return 0;
      if (this.sel === "p" || this.sel === "p:visible") {
        const f = this.hasText;
        return this.p.paras.filter(t => {
          const n = t.replace(/\s+/g, " ").trim();
          return f === null ? true : typeof f === "string" ? n.includes(f) : f.test(n);
        }).length;
      }
      if (this.isCompose()) return this.p.composeHref ? 1 : 0;
      if (this.sel.includes("to connect") || this.sel.includes("custom-invite")) return this.p.connectCta ? 1 : 0;
      return 0;
    }
    if (this.sel.includes('componentkey$="Topcard"')) return this.p.hasTopCard ? 1 : 0;
    if (this.sel.startsWith("main section")) return 0;               // legacy layout absent
    if (this.sel.includes("custom-invite")) return this.p.ownConnectHref ? 1 : 0;
    if (this.sel.includes("Pending")) return this.p.pendingBadges;
    if (this.isCompose()) return this.p.sidebarComposeHrefs.length + (this.p.composeHref ? 1 : 0);
    if (this.sel.includes("msg-connections-typeahead")) { this.t.typeaheadQueried = true; return 0; }
    if (this.sel.includes("msg-form__contenteditable")) return 0;
    return 0;
  }
  async getAttribute(name: string): Promise<string | null> {
    if (name !== "href") return null;
    if (this.scope === "topCard" && this.isCompose()) return this.p.composeHref;
    if (this.isCompose()) return this.p.sidebarComposeHrefs[0] ?? this.p.composeHref;
    if (this.sel.includes("custom-invite")) return this.p.ownConnectHref;
    return null;
  }
  /** The card itself, as returned by findTopCard(), is page-scoped. */
  private isCard() { return this.sel.includes('componentkey$="Topcard"') || this.sel.startsWith("main section"); }

  async innerText(): Promise<string> {
    if (this.scope === "topCard" || this.isCard()) {
      if (!this.p.hasTopCard) throw new Error("no top card");
      return this.p.cardText;
    }
    return "";
  }
  async waitFor(): Promise<void> {
    if ((await this.count()) === 0) throw new Error(`Timeout waiting for ${this.sel}`);
  }
  async click(): Promise<void> {}
  async evaluate(): Promise<unknown> { return undefined; }
  async isVisible(): Promise<boolean> { return (await this.count()) > 0; }
  async type(): Promise<void> {}
}

class FakePage {
  p: Profile;
  t: Trace;
  constructor(p: Profile, t: Trace) { this.p = p; this.t = t; }
  async goto(u: string): Promise<void> { this.t.gotos.push(u); }
  async waitForTimeout(): Promise<void> {}
  url(): string { return URL; }
  locator(sel: string): FakeLocator {
    if (sel.includes("msg-connections-typeahead")) this.t.typeaheadQueried = true;
    return new FakeLocator(this.p, this.t, sel, "page");
  }
  on(): void {}
}

function mk(p: Partial<Profile> = {}) {
  const prof = profile(p);
  const trace: Trace = { typeaheadQueried: false, gotos: [] };
  return { page: new FakePage(prof, trace) as unknown as Page, prof, trace };
}

const topCardOf = async (page: Page): Promise<Locator | null> => findTopCard(page);

// ─── assertConnectable ───────────────────────────────────────────────────────

test("Follow + Message with no profileUrn is CONNECTABLE, not already-connected", async () => {
  // The raise-faster regression: creator/Follow-primary layout renders a
  // Message button for a NON-connection, and Connect lives in the More menu.
  const { page } = mk({ cardText: "Raise Faster Follow Message", composeHref: composeWithoutUrn });
  const topCard = await topCardOf(page);

  await assert.doesNotReject(
    () => assertConnectable(page, topCard, "raise-faster"),
    "a compose link without profileUrn must not imply a connection"
  );
});

test("a compose link WITH profileUrn is still NOT proof of a connection", async () => {
  // Superseded Aug 2026: a confirmed non-connection (/in/raise-faster/) and a
  // confirmed 1st-degree (/in/demo-investor-4aa78a428/) expose structurally
  // identical profileUrn compose links, so the link proves nothing either way.
  const { page } = mk({ cardText: "Someone Message", composeHref: composeWithUrn() });
  const topCard = await topCardOf(page);

  await assert.doesNotReject(() => assertConnectable(page, topCard, "someone"));
});

test("the 1st-degree text path still detects a connection", async () => {
  const { page } = mk({ cardText: "Someone · 1st · Mumbai", paras: ["· 1st"], composeHref: null });
  const topCard = await topCardOf(page);

  await assert.rejects(() => assertConnectable(page, topCard, "someone"), AlreadyConnectedError);
});

test("an own Connect link short-circuits even when a compose link is present", async () => {
  const { page } = mk({
    cardText: "Someone Connect Message",
    composeHref: composeWithUrn(),
    ownConnectHref: "/preload/custom-invite/?vanityName=someone",
  });
  const topCard = await topCardOf(page);

  await assert.doesNotReject(() => assertConnectable(page, topCard, "someone"));
});

test("a Connect CTA inside the top card short-circuits too", async () => {
  const { page } = mk({ cardText: "Someone Connect Message", composeHref: composeWithUrn(), connectCta: true });
  const topCard = await topCardOf(page);

  await assert.doesNotReject(() => assertConnectable(page, topCard, null));
});

test("Pending wins over a compose link", async () => {
  const { page } = mk({ cardText: "Someone Pending Message", composeHref: composeWithUrn() });
  const topCard = await topCardOf(page);

  await assert.rejects(() => assertConnectable(page, topCard, "someone"), PendingInviteError);
});

test("sidebar compose links belonging to other people are ignored", async () => {
  // Page-wide compose links exist for suggested profiles; only the target's own
  // top card may be consulted.
  const { page } = mk({
    cardText: "Someone Follow",
    composeHref: null,
    sidebarComposeHrefs: [composeWithUrn("urn:li:fsd_profile:STRANGER")],
  });
  const topCard = await topCardOf(page);

  await assert.doesNotReject(
    () => assertConnectable(page, topCard, "someone"),
    "another person's compose link must never mark this target connected"
  );
});

// ─── visitProfile ────────────────────────────────────────────────────────────

test("visitProfile: compose href without profileUrn is NOT first-degree", async () => {
  const { page } = mk({ cardText: "Raise Faster Follow Message", composeHref: composeWithoutUrn });

  assert.deepEqual(await visitProfile(page, URL), { degree: "not_first_degree", isFirstDegree: false, messagingUrn: null });
});

test("visitProfile: the '1st' badge decides first-degree; the URN is then extracted", async () => {
  const { page } = mk({ cardText: "Someone · 1st · Message", paras: ["· 1st"], composeHref: composeWithUrn() });

  assert.deepEqual(await visitProfile(page, URL), { degree: "first_degree", isFirstDegree: true, messagingUrn: URN });
});

test("a compose link alone never yields first-degree, with or without a URN", async () => {
  // The isFirstDegree=true / messagingUrn=null pair is now REACHABLE (a 1st
  // badge with no compose link) but harmless: the typeahead it used to feed has
  // been deleted, so sendMessage() raises MessagingUrnUnresolvedError instead.
  for (const p of [
    { cardText: "Follow Message", composeHref: composeWithoutUrn },
    { cardText: "Follow Message", composeHref: composeWithUrn() },
    { cardText: "", composeHref: null },
  ]) {
    const { page } = mk(p);
    assert.deepEqual(await visitProfile(page, URL), { degree: "not_first_degree", isFirstDegree: false, messagingUrn: null },
      `compose link must not imply connection: ${JSON.stringify(p)}`);
  }
});

// ─── sendMessage ─────────────────────────────────────────────────────────────

test("sendMessage refuses a non-connection and never touches the typeahead", async () => {
  const { page, trace } = mk({ cardText: "Raise Faster Follow Message", composeHref: composeWithoutUrn });

  await assert.rejects(() => sendMessage(page, "raise-faster", "hi", URL, null), NotConnectedError);
  assert.equal(trace.typeaheadQueried, false, "name-search typeahead must never be invoked");
  assert.ok(
    !trace.gotos.some(u => u.includes("/messaging/thread/new")),
    `must not open the new-thread composer, got ${JSON.stringify(trace.gotos)}`
  );
});
