import test from "node:test";
import assert from "node:assert/strict";
import type { Page, Locator } from "playwright";

const { assertConnectable, openInviteDialog, findTopCard, AlreadyConnectedError, PendingInviteError, InviteUiError } =
  await import("@/lib/linkedin/connect");
const { visitProfile } = await import("@/lib/linkedin/visit");
const message = await import("@/lib/linkedin/message");

const VANITY = "raise-faster";
const URL = `https://www.linkedin.com/in/${VANITY}/`;

// Observed live (Aug 2026). BOTH a non-connection and a confirmed 1st-degree
// connection expose this identical shape — profileUrn included — which is why
// it can never be a connection signal.
const COMPOSE_HREF =
  "/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AACoAADmObfoB&recipient=ACoAADmObfoB&screenContext=NON_SELF_PROFILE_VIEW&interop=msgOverlay";
const connectHref = (v: string) => `/preload/custom-invite/?vanityName=${v}`;

// ─── fake DOM ────────────────────────────────────────────────────────────────
// Faithful to the observed markup:
//   <a role="menuitem" href="/preload/custom-invite/?vanityName=…"
//      componentkey="ConnectButtonstate:invitation:urn:li:member:…_connect">
//     <div>Connect</div>          ← label nested, so :text-is() does NOT match
//     <svg aria-hidden="true">    ← icon
//   </a>
// aria-label is null on every item; the menu has no id; More has no aria-controls.

interface Item { text: string; href?: string | null; componentkey?: string | null }
interface MoreBtn { aria: string; inCard: boolean }

interface Doc {
  hasTopCard: boolean;
  cardText: string;
  /**
   * The card's <p> elements, as observed live: the degree badge is its own
   * <p>· 1st</p>, and LinkedIn also ships HIDDEN variants (a connected card
   * carried <p>· 2nd</p> hidden alongside it), so visibility is load-bearing.
   */
  paras: Array<{ text: string; visible: boolean }>;
  composeHref: string | null;
  /** the person's own Connect CTA in the main card (page-wide custom-invite anchor) */
  ownConnectHref: string | null;
  cardConnectCta: boolean;
  /** Pending affordance inside the target's own card */
  cardPending: boolean;
  mores: MoreBtn[];
  menuItems: Item[];
  /** extra visible menus, to model ambiguity */
  extraVisibleMenus: number;
  menuOpens: boolean;
  sendButtonAfterConnect: boolean;
}

const doc = (d: Partial<Doc> = {}): Doc => ({
  hasTopCard: true, cardText: "Diana C. Follow Message More", paras: [], composeHref: null,
  ownConnectHref: null, cardConnectCta: false, cardPending: false,
  mores: [], menuItems: [], extraVisibleMenus: 0, menuOpens: true, sendButtonAfterConnect: true, ...d,
});

interface Trace { clicked: string[]; typeahead: boolean }

type N =
  | { k: "card" } | { k: "more"; b: MoreBtn } | { k: "menu" }
  | { k: "item"; it: Item } | { k: "anchor"; href: string } | { k: "send" } | { k: "pending" }
  | { k: "para"; text: string };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const attrSub = (sel: string, a: string) => sel.match(new RegExp(`\\[${a}\\*=["']([^"']+)["']`))?.[1] ?? null;
const attrSuffix = (sel: string, a: string) => sel.match(new RegExp(`\\[${a}\\$=["']([^"']+)["']`))?.[1] ?? null;

class FL {
  d: Doc; t: Trace; sel: string; scope: "page" | "card" | "menu"; idx: number | null = null;
  hasTextFilter: string | RegExp | null = null;
  constructor(d: Doc, t: Trace, sel: string, scope: FL["scope"] = "page") { this.d = d; this.t = t; this.sel = sel; this.scope = scope; }
  private clone(): FL { const l = new FL(this.d, this.t, this.sel, this.scope); l.idx = this.idx; l.hasTextFilter = this.hasTextFilter; return l; }
  first(): FL { const l = this.clone(); l.idx = 0; return l; }
  nth(i: number): FL { const l = this.clone(); l.idx = i; return l; }
  filter(o?: { hasText?: string | RegExp }): FL { const l = this.clone(); if (o?.hasText !== undefined) l.hasTextFilter = o.hasText; return l; }
  locator(sel: string, o?: { hasText?: string | RegExp }): FL {
    const n = this.resolve()[0];
    const scope: FL["scope"] = n?.k === "menu" ? "menu" : n?.k === "card" ? "card" : this.scope;
    const l = new FL(this.d, this.t, sel, scope);
    if (o?.hasText !== undefined) l.hasTextFilter = o.hasText;
    return l;
  }

  /** One selector alternative vs one menu item. Models the REAL nested-label DOM. */
  private itemMatch(part: string, it: Item): boolean {
    if (!part.includes("menuitem")) return false;
    // :text-is() targets the element's own text; the real label is nested, so it never matches.
    if (/:text-is\(/.test(part)) return false;
    if (/:has-text\(/.test(part)) {
      const v = part.match(/:has-text\((?:"([^"]*)"|'([^']*)')\)/)?.slice(1).find(Boolean) ?? "";
      return norm(it.text).toLowerCase().includes(v.toLowerCase());
    }
    const aria = attrSub(part, "aria-label");
    if (aria !== null) return false; // every real menu item has aria-label = null
    const hrefSubs = [...part.matchAll(/\[href\*=["']([^"']+)["']\]/g)].map(m => m[1]);
    if (hrefSubs.length) return hrefSubs.every(s => (it.href ?? "").includes(s));
    const ckSuffix = attrSuffix(part, "componentkey");
    if (ckSuffix !== null) return (it.componentkey ?? "").endsWith(ckSuffix);
    const ckSub = attrSub(part, "componentkey");
    if (ckSub !== null) return (it.componentkey ?? "").includes(ckSub);
    return true; // bare [role="menuitem"]
  }

  private resolve(): N[] {
    const out: N[] = [];
    for (const part of this.sel.split(/,(?![^()]*\))/).map(s => s.trim())) {
      if (part.includes("menuitem")) {
        if (this.scope !== "menu") continue;            // menu items only exist inside the opened menu
        for (const it of this.d.menuItems) if (this.itemMatch(part, it)) out.push({ k: "item", it });
        continue;
      }
      if (part.includes('role="menu"')) {
        if (this.d.menuOpens) { out.push({ k: "menu" }); for (let i = 0; i < this.d.extraVisibleMenus; i++) out.push({ k: "menu" }); }
        continue;
      }
      if (/aria-label/.test(part) && /More/.test(part)) {
        const pool = this.scope === "card" ? this.d.mores.filter(m => m.inCard) : this.d.mores;
        for (const b of pool) {
          const ex = part.match(/\[aria-label=["']([^"']+)["']/)?.[1];
          const pre = part.match(/\[aria-label\^=["']([^"']+)["']/)?.[1];
          if ((ex && b.aria === ex) || (pre && b.aria.startsWith(pre))) out.push({ k: "more", b });
        }
        continue;
      }
      if (part.includes("custom-invite")) {
        const subs = [...part.matchAll(/\[href\*=["']([^"']+)["']\]/g)].map(m => m[1]);
        const h = this.d.ownConnectHref;
        if (h && subs.every(s => h.includes(s))) out.push({ k: "anchor", href: h });
        continue;
      }
      if (part.includes("to connect")) { if (this.scope === "card" && this.d.cardConnectCta) out.push({ k: "anchor", href: connectHref(VANITY) }); continue; }
      if (part.includes("/messaging/compose")) { if (this.scope === "card" && this.d.composeHref) out.push({ k: "anchor", href: this.d.composeHref }); continue; }
      if (/Pending/.test(part)) { if (this.d.cardPending && (this.scope === "card" || this.scope === "page")) out.push({ k: "pending" }); continue; }
      if (part.includes("Send without") || part.includes("Send now") || part.includes("Send invitation")) {
        if (this.d.sendButtonAfterConnect && this.t.clicked.some(c => c.startsWith("Connect"))) out.push({ k: "send" });
        continue;
      }
      if (/^p(:visible)?$/.test(part)) {
        if (this.scope !== "card") continue;                 // badge lookups are card-scoped
        const wantVisible = part.includes(":visible");
        for (const q of this.d.paras) if (!wantVisible || q.visible) out.push({ k: "para", text: q.text });
        continue;
      }
      if (part.includes('componentkey$="Topcard"')) { if (this.d.hasTopCard) out.push({ k: "card" }); continue; }
      if (part.includes("msg-connections-typeahead")) { this.t.typeahead = true; continue; }
    }
    let res = out;
    if (this.hasTextFilter !== null) {
      const f = this.hasTextFilter;
      const textOf = (n: N): string | null => n.k === "item" ? norm(n.it.text) : n.k === "para" ? norm(n.text) : null;
      res = res.filter(n => {
        const t = textOf(n);
        return t !== null && (typeof f === "string" ? t.includes(f) : f.test(t));
      });
    }
    return this.idx === null ? res : (res[this.idx] ? [res[this.idx]] : []);
  }

  async count(): Promise<number> { return this.resolve().length; }
  async isVisible(): Promise<boolean> { return this.resolve().length > 0; }
  async waitFor(): Promise<void> { if (this.resolve().length === 0) throw new Error(`Timeout ${this.sel}`); }
  async evaluate(): Promise<unknown> { return undefined; }
  async getAttribute(n: string): Promise<string | null> {
    const x = this.resolve()[0]; if (!x) return null;
    if (x.k === "anchor" && n === "href") return x.href;
    if (x.k === "item" && n === "href") return x.it.href ?? null;
    if (x.k === "item" && n === "componentkey") return x.it.componentkey ?? null;
    if (x.k === "item" && n === "aria-label") return null;      // real DOM
    if (x.k === "more" && n === "aria-controls") return null;   // real DOM
    if (x.k === "menu" && n === "id") return null;              // real DOM
    return null;
  }
  async innerText(): Promise<string> {
    const x = this.resolve()[0];
    if (x?.k === "para") return x.text;
    if (x?.k === "item") return x.it.text;
    if (this.scope === "card" || this.sel.includes('componentkey$="Topcard"')) {
      if (!this.d.hasTopCard) throw new Error("no top card");
      return this.d.cardText;
    }
    return "";
  }
  async click(): Promise<void> {
    const x = this.resolve()[0];
    if (!x) throw new Error(`cannot click ${this.sel}`);
    if (x.k === "more") { this.t.clicked.push(`More(${x.b.inCard ? "card" : "other"})`); return; }
    if (x.k === "item") { this.t.clicked.push(norm(x.it.text)); return; }
    this.t.clicked.push(this.sel);
  }
  async type(): Promise<void> {}
}

class FP {
  d: Doc; t: Trace;
  constructor(d: Doc, t: Trace) { this.d = d; this.t = t; }
  url(): string { return URL; }
  async goto(u: string): Promise<void> { if (/thread\/new/.test(u)) this.t.typeahead = true; }
  async waitForTimeout(): Promise<void> {}
  locator(sel: string, o?: { hasText?: string | RegExp }): FL {
    if (sel.includes("msg-connections-typeahead")) this.t.typeahead = true;
    const l = new FL(this.d, this.t, sel, "page");
    if (o?.hasText !== undefined) l.hasTextFilter = o.hasText;
    return l;
  }
  on(): void {}
}

function mk(d: Partial<Doc> = {}) {
  const dd = doc(d); const t: Trace = { clicked: [], typeahead: false };
  return { page: new FP(dd, t) as unknown as Page, d: dd, t };
}
const card = async (p: Page): Promise<Locator | null> => findTopCard(p);
const CARD_MORE: MoreBtn = { aria: "More", inCard: true };
const NAV_MORE: MoreBtn = { aria: "More", inCard: false };
const CONNECT_ITEM = { text: "Connect", href: connectHref(VANITY), componentkey: "ConnectButtonstate:invitation:urn:li:member:965635578_connect" };
const REAL_MENU = [
  { text: "Send profile in a message", href: "/messaging/compose/?screenContext=NON_SELF_PROFILE_VIEW&body=x" },
  { text: "Save to PDF" },
  CONNECT_ITEM,
  { text: "Report / Block", href: "/preload/report-in-modal/?entityUrn=x" },
  { text: "About this member", href: URL },
];

// ════ CONNECT-STATE TESTS ════

test("T1 Follow-primary: Follow+Message+More, Connect in menu → connectable", async () => {
  const { page } = mk({ cardText: "Diana C. Follow Message More", mores: [CARD_MORE], menuItems: REAL_MENU });
  const c = await card(page);
  await assert.doesNotReject(() => assertConnectable(page, c, VANITY));
});

test("T2 Follow-primary with profileUrn compose link → still connectable", async () => {
  const { page } = mk({ cardText: "Diana C. Follow Message More", composeHref: COMPOSE_HREF, mores: [CARD_MORE], menuItems: REAL_MENU });
  const c = await card(page);
  await assert.doesNotReject(() => assertConnectable(page, c, VANITY));
});

test("T3 explicit 1st-degree indicator → AlreadyConnectedError", async () => {
  const { page } = mk({ cardText: "Demo Investor · 1st · Message", paras: [{ text: "· 1st", visible: true }] });
  const c = await card(page);
  await assert.rejects(() => assertConnectable(page, c, VANITY), AlreadyConnectedError);
});

test("T4 1st-degree is decided by the '1st' indicator, not by profileUrn", async () => {
  const withBoth = mk({ cardText: "Demo Investor · 1st · Message", paras: [{ text: "· 1st", visible: true }], composeHref: COMPOSE_HREF });
  const cBoth = await card(withBoth.page);
  await assert.rejects(() => assertConnectable(withBoth.page, cBoth, VANITY), AlreadyConnectedError);
  // same compose link, no 1st indicator → must NOT be connected
  const urnOnly = mk({ cardText: "Diana C. Follow Message", composeHref: COMPOSE_HREF });
  const cUrn = await card(urnOnly.page);
  await assert.doesNotReject(() => assertConnectable(urnOnly.page, cUrn, VANITY),
    "profileUrn alone must never imply a connection");
});

test("T5 non-connected + profileUrn + Connect available → connectable (core Slice A regression)", async () => {
  const { page } = mk({ cardText: "Diana C. Follow Message More", composeHref: COMPOSE_HREF, ownConnectHref: connectHref(VANITY) });
  const c = await card(page);
  await assert.doesNotReject(() => assertConnectable(page, c, VANITY));
});

test("T6 pending → PendingInviteError, nothing clicked", async () => {
  const { page, t } = mk({ cardText: "Diana C. Pending Message", cardPending: true });
  const c = await card(page);
  await assert.rejects(() => assertConnectable(page, c, VANITY), PendingInviteError);
  assert.deepEqual(t.clicked, []);
});

test("T7 More menu offers 'Remove connection' → AlreadyConnectedError, zero clicks", async () => {
  const { page, t } = mk({ mores: [CARD_MORE], menuItems: [{ text: "Message" }, { text: "Remove connection" }] });
  await assert.rejects(() => openInviteDialog(page, URL, VANITY), AlreadyConnectedError);
  assert.deepEqual(t.clicked.filter(c => !c.startsWith("More(")), [], `no menu item may be clicked, got ${JSON.stringify(t.clicked)}`);
});

test("T8 'Connections' is not a connection signal", async () => {
  const { page, t } = mk({ mores: [CARD_MORE], menuItems: [{ text: "Connections" }, { text: "Save to PDF" }] });
  await assert.rejects(() => openInviteDialog(page, URL, VANITY), InviteUiError);
  assert.ok(!t.clicked.some(c => /Connection/i.test(c)));
});

test("T9 'Remove connection' + 'Connect' together → AlreadyConnectedError, zero clicks", async () => {
  const { page, t } = mk({ mores: [CARD_MORE], menuItems: [{ text: "Remove connection" }, CONNECT_ITEM] });
  await assert.rejects(() => openInviteDialog(page, URL, VANITY), AlreadyConnectedError);
  assert.deepEqual(t.clicked.filter(c => !c.startsWith("More(")), []);
});

// ════ MORE-BUTTON TESTS ════

test("T10 multiple page-wide More buttons → the card's is used, never a positional guess", async () => {
  const { page, t } = mk({ mores: [NAV_MORE, NAV_MORE, CARD_MORE], menuItems: REAL_MENU });
  await openInviteDialog(page, URL, VANITY);
  assert.ok(t.clicked.includes("More(card)"), `must open the card's More, got ${JSON.stringify(t.clicked)}`);
  assert.ok(!t.clicked.includes("More(other)"), "must never open another More");
});

test("T11 no More button in the top card → InviteUiError, no click", async () => {
  const { page, t } = mk({ mores: [NAV_MORE], menuItems: REAL_MENU });
  await assert.rejects(() => openInviteDialog(page, URL, VANITY), InviteUiError);
  assert.deepEqual(t.clicked, []);
});

test("T12 multiple visible menus with no aria-controls → InviteUiError, no guess", async () => {
  const { page, t } = mk({ mores: [CARD_MORE], menuItems: REAL_MENU, extraVisibleMenus: 2 });
  await assert.rejects(() => openInviteDialog(page, URL, VANITY), InviteUiError);
  assert.ok(!t.clicked.some(c => c === "Connect"));
});

// ════ MENU CONNECT SELECTOR TESTS ════

test("T13 realistic Connect item (nested label, aria-label null, invite href) is discovered", async () => {
  const { page, t } = mk({ mores: [CARD_MORE], menuItems: REAL_MENU });
  await openInviteDialog(page, URL, VANITY);
  assert.ok(t.clicked.includes("Connect"), `Connect must be clicked, got ${JSON.stringify(t.clicked)}`);
});

test("T14 the Connect selector does not match 'Remove connection'", async () => {
  const { page, t } = mk({ mores: [CARD_MORE], menuItems: [{ text: "Remove connection" }] });
  await assert.rejects(() => openInviteDialog(page, URL, VANITY));
  assert.ok(!t.clicked.includes("Remove connection"));
});

test("T15 the Connect selector does not match 'Connections'", async () => {
  const { page, t } = mk({ mores: [CARD_MORE], menuItems: [{ text: "Connections" }] });
  await assert.rejects(() => openInviteDialog(page, URL, VANITY), InviteUiError);
  assert.ok(!t.clicked.includes("Connections"));
});

test("T16 another person's Connect item is ignored", async () => {
  const { page, t } = mk({
    mores: [CARD_MORE],
    menuItems: [{ text: "Connect", href: connectHref("some-other-person"), componentkey: "ConnectButtonstate:invitation:urn:li:member:999_connect" }],
  });
  await assert.rejects(() => openInviteDialog(page, URL, VANITY), InviteUiError);
  assert.deepEqual(t.clicked.filter(c => !c.startsWith("More(")), [], "a stranger's Connect must never be clicked");
});

// ════ VISIT / MESSAGE TESTS ════

test("T17 non-connected + profileUrn compose link → isFirstDegree false", async () => {
  const { page } = mk({ cardText: "Diana C. Follow Message", composeHref: COMPOSE_HREF });
  assert.deepEqual(await visitProfile(page, URL), { degree: "not_first_degree", isFirstDegree: false, messagingUrn: null });
});

test("T18 confirmed 1st-degree → isFirstDegree true, URN extracted", async () => {
  const { page } = mk({ cardText: "Demo Investor · 1st · Message", paras: [{ text: "· 1st", visible: true }], composeHref: COMPOSE_HREF });
  const r = await visitProfile(page, URL);
  assert.equal(r.isFirstDegree, true);
  assert.equal(r.messagingUrn, "urn:li:fsd_profile:ACoAADmObfoB");
});

test("T19 non-connected → sendMessage throws NotConnectedError, typeahead never invoked", async () => {
  const { page, t } = mk({ cardText: "Diana C. Follow Message", composeHref: COMPOSE_HREF });
  await assert.rejects(() => message.sendMessage(page, "raise-faster", "hi", URL, null), message.NotConnectedError);
  assert.equal(t.typeahead, false, "name-search typeahead must be unreachable");
});

test("T20 connected but no resolvable URN → safe error, never typeahead", async () => {
  const { page, t } = mk({ cardText: "Demo Investor · 1st · connected", composeHref: null });
  await assert.rejects(() => message.sendMessage(page, "Demo Investor", "hi", URL, null));
  assert.equal(t.typeahead, false, "must never fall back to searching by name");
});

// ── absorbed from the retired Slice B suite (its fake modelled aria-labels the
//    real DOM does not have; these scenarios re-expressed against real markup) ──

test("T21 an exact Pending item in the More menu → PendingInviteError, zero clicks", async () => {
  const { page, t } = mk({
    mores: [CARD_MORE],
    menuItems: [{ text: "Pending", componentkey: "ConnectButtonstate:invitation:urn:li:member:965635578_pending" }, { text: "Message" }],
  });
  await assert.rejects(() => openInviteDialog(page, URL, VANITY), PendingInviteError);
  assert.deepEqual(t.clicked.filter(c => !c.startsWith("More(")), []);
});

test("T22 a More button that opens no menu → InviteUiError, no Connect click", async () => {
  const { page, t } = mk({ mores: [CARD_MORE], menuItems: REAL_MENU, menuOpens: false });
  await assert.rejects(() => openInviteDialog(page, URL, VANITY), InviteUiError);
  assert.ok(!t.clicked.includes("Connect"));
});

test("T23 when Connect is in the main card, the More menu is never opened", async () => {
  const { page, t } = mk({
    ownConnectHref: connectHref(VANITY),
    mores: [CARD_MORE],
    menuItems: REAL_MENU,
    sendButtonAfterConnect: false,
  });
  await openInviteDialog(page, URL, VANITY).catch(() => { /* no send button; irrelevant here */ });
  assert.ok(!t.clicked.some(c => c.startsWith("More(")), `More must not be opened, got ${JSON.stringify(t.clicked)}`);
});

// ════ DEGREE BADGE — real DOM contract ════
// Observed live: a connected card renders <p>· 1st</p> as its own element, with
// a HIDDEN <p>· 2nd</p> beside it. A non-connected card has no degree element
// at all. Headlines/company/location live in their own, longer <p>s — which is
// why anchoring to a whole element defeats "1st Round Capital" and friends.

const BADGE_1ST = { text: "· 1st", visible: true };
const BADGE_2ND_HIDDEN = { text: "· 2nd", visible: false };
const NAME_P = { text: "Demo Investor", visible: true };

test("T24 visible <p>· 1st</p> → first-degree", async () => {
  const { page } = mk({ cardText: "Demo Investor · 1st Investor at Freelance", paras: [NAME_P, BADGE_1ST, BADGE_2ND_HIDDEN] });
  const c = await card(page);
  await assert.rejects(() => assertConnectable(page, c, VANITY), AlreadyConnectedError);
  assert.equal((await visitProfile(page, URL)).isFirstDegree, true);
});

test("T25 HIDDEN <p>· 1st</p> → NOT first-degree", async () => {
  // LinkedIn ships inapplicable degree variants hidden; a hidden badge is not a
  // connection.
  const { page } = mk({ cardText: "Someone · 1st", paras: [NAME_P, { text: "· 1st", visible: false }] });
  const c = await card(page);
  await assert.doesNotReject(() => assertConnectable(page, c, VANITY));
  assert.equal((await visitProfile(page, URL)).isFirstDegree, false);
});

test("T26 visible <p>· 2nd</p> only → NOT first-degree", async () => {
  const { page } = mk({ cardText: "Someone · 2nd", paras: [NAME_P, { text: "· 2nd", visible: true }] });
  const c = await card(page);
  await assert.doesNotReject(() => assertConnectable(page, c, VANITY));
  assert.equal((await visitProfile(page, URL)).isFirstDegree, false);
});

for (const headline of ["Partner at 1st Round Capital London", "1st Lieutenant, US Army", "Ranked 1st in EMEA sales 2025"]) {
  test(`T27 headline "${headline}" → NOT first-degree`, async () => {
    const { page } = mk({
      cardText: `Jane Doe ${headline} Follow Message`,
      paras: [{ text: "Jane Doe", visible: true }, { text: headline, visible: true }],
    });
    const c = await card(page);
    await assert.doesNotReject(() => assertConnectable(page, c, VANITY),
      "arbitrary '1st' in a headline must never imply a connection");
    assert.equal((await visitProfile(page, URL)).isFirstDegree, false);
  });
}

test("T28 compose profileUrn WITHOUT a degree badge → NOT first-degree", async () => {
  const { page } = mk({ cardText: "Diana C. Follow Message", paras: [NAME_P], composeHref: COMPOSE_HREF });
  assert.deepEqual(await visitProfile(page, URL), { degree: "not_first_degree", isFirstDegree: false, messagingUrn: null });
});

test("T29 compose profileUrn WITH a degree badge → first-degree + URN", async () => {
  const { page } = mk({ cardText: "Demo Investor · 1st", paras: [NAME_P, BADGE_1ST], composeHref: COMPOSE_HREF });
  const r = await visitProfile(page, URL);
  assert.equal(r.isFirstDegree, true);
  assert.equal(r.messagingUrn, "urn:li:fsd_profile:ACoAADmObfoB");
});

test("T30 no degree evidence and no Connect/Remove/Pending → InviteUiError", async () => {
  const { page, t } = mk({ cardText: "Diana C. Follow Message", paras: [NAME_P], mores: [CARD_MORE], menuItems: [{ text: "Save to PDF" }] });
  await assert.rejects(() => openInviteDialog(page, URL, VANITY), InviteUiError);
  assert.deepEqual(t.clicked.filter(c => !c.startsWith("More(")), []);
});

test("T31 Pending + Connect in the menu → PendingInviteError, zero clicks", async () => {
  const { page, t } = mk({ mores: [CARD_MORE], menuItems: [{ text: "Pending" }, CONNECT_ITEM] });
  await assert.rejects(() => openInviteDialog(page, URL, VANITY), PendingInviteError);
  assert.deepEqual(t.clicked.filter(c => !c.startsWith("More(")), []);
});
