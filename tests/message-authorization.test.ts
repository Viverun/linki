import test from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";

const { sendMessage, NotConnectedError, MessagingUrnUnresolvedError } =
  await import("@/lib/linkedin/message");

const PROFILE = "https://www.linkedin.com/in/someone-123/";
const LIVE_URN = "urn:li:fsd_profile:ACoAALIVEurn";
const CACHED_URN = "urn:li:fsd_profile:ACoAACACHEDurn";
const composeHrefFor = (urn: string) =>
  `/messaging/compose/?profileUrn=${encodeURIComponent(urn)}&recipient=x&screenContext=NON_SELF_PROFILE_VIEW`;

// ─── fake page ───────────────────────────────────────────────────────────────
// Models the REAL control flow so the cached-URN bypass is observable:
//   visitProfile()      → goto(profileUrl) then reads the card
//   openComposeByUrn()  → goto(/messaging/compose/?profileUrn=…) then waits for
//                         div.msg-form__contenteditable
//   sendFromComposeBox()→ clicks that input, then button.msg-form__send-button
// The card models the live DOM contract: the degree badge is its own visible
// <p>· 1st</p>; the Message compose link is a separate anchor.

interface Doc {
  /** visible <p> elements in the top card; badge is "· 1st" */
  paras: string[];
  /** href of the card's Message compose link (the LIVE URN source) */
  composeHref: string | null;
  /** whether the compose page renders its input (openComposeByUrn success) */
  composeOpens: boolean;
}

interface Trace {
  gotos: string[];
  visitCount: number;
  composeOpenedWith: string[];
  sent: boolean;
  typeaheadTouched: boolean;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

class FL {
  d: Doc; t: Trace; sel: string; scope: "page" | "card";
  hasText: string | RegExp | null = null;
  constructor(d: Doc, t: Trace, sel: string, scope: "page" | "card" = "page") {
    this.d = d; this.t = t; this.sel = sel; this.scope = scope;
  }
  private clone(): FL { const l = new FL(this.d, this.t, this.sel, this.scope); l.hasText = this.hasText; return l; }
  first(): FL { return this; }
  nth(): FL { return this; }
  filter(o?: { hasText?: string | RegExp }): FL {
    const l = this.clone(); if (o?.hasText !== undefined) l.hasText = o.hasText; return l;
  }
  locator(sel: string): FL {
    const isCard = this.sel.includes('componentkey$="Topcard"');
    return new FL(this.d, this.t, sel, isCard ? "card" : this.scope);
  }
  private matches(): number {
    if (this.sel.includes('componentkey$="Topcard"')) return 1;          // card always present
    if (this.sel.startsWith("main section")) return 0;
    if (this.sel === "p" || this.sel === "p:visible") {
      if (this.scope !== "card") return 0;
      const f = this.hasText;
      return this.d.paras.filter(x => {
        const n = norm(x);
        return f === null ? true : typeof f === "string" ? n.includes(f) : f.test(n);
      }).length;
    }
    if (this.sel.includes("/messaging/compose")) return this.scope === "card" && this.d.composeHref ? 1 : 0;
    if (this.sel.includes("msg-form__contenteditable")) return this.d.composeOpens ? 1 : 0;
    if (this.sel.includes("msg-form__send-button")) return this.d.composeOpens ? 1 : 0;
    if (this.sel.includes("msg-connections-typeahead")) { this.t.typeaheadTouched = true; return 0; }
    return 0;
  }
  async count(): Promise<number> { return this.matches(); }
  async isVisible(): Promise<boolean> { return this.matches() > 0; }
  async getAttribute(n: string): Promise<string | null> {
    if (n === "href" && this.sel.includes("/messaging/compose") && this.scope === "card") return this.d.composeHref;
    return null;
  }
  async innerText(): Promise<string> { return this.scope === "card" ? this.d.paras.join(" ") : ""; }
  async waitFor(): Promise<void> { if (this.matches() === 0) throw new Error(`Timeout ${this.sel}`); }
  async click(): Promise<void> {
    if (this.sel.includes("msg-form__send-button")) this.t.sent = true;
  }
  async press(): Promise<void> {}
  async pressSequentially(): Promise<void> {}
  async evaluate(): Promise<unknown> { return undefined; }
  async type(): Promise<void> {}
}

class FP {
  d: Doc; t: Trace;
  constructor(d: Doc, t: Trace) { this.d = d; this.t = t; }
  url(): string { return PROFILE; }
  async goto(u: string): Promise<void> {
    this.t.gotos.push(u);
    if (u.startsWith(PROFILE)) this.t.visitCount++;
    if (u.includes("/messaging/compose")) {
      const m = u.match(/profileUrn=([^&]+)/);
      this.t.composeOpenedWith.push(m ? decodeURIComponent(m[1]) : "(none)");
    }
    if (u.includes("thread/new")) this.t.typeaheadTouched = true;
  }
  async waitForTimeout(): Promise<void> {}
  async evaluate(): Promise<unknown> { return undefined; }
  locator(sel: string): FL {
    if (sel.includes("msg-connections-typeahead")) this.t.typeaheadTouched = true;
    return new FL(this.d, this.t, sel, "page");
  }
}

function mk(d: Partial<Doc> = {}) {
  const doc: Doc = { paras: [], composeHref: null, composeOpens: true, ...d };
  const t: Trace = { gotos: [], visitCount: 0, composeOpenedWith: [], sent: false, typeaheadTouched: false };
  return { page: new FP(doc, t) as unknown as Page, t };
}

const CONNECTED = ["Someone", "· 1st"];
const NOT_CONNECTED = ["Someone", "Follow", "Message"];

// ─── A ───────────────────────────────────────────────────────────────────────

test("A cached URN must NOT authorize a send when the live profile is not first-degree", async () => {
  const { page, t } = mk({ paras: NOT_CONNECTED, composeHref: composeHrefFor(LIVE_URN) });

  await assert.rejects(() => sendMessage(page, "Someone", "hi", PROFILE, CACHED_URN), NotConnectedError);

  assert.deepEqual(t.composeOpenedWith, [], "openComposeByUrn must never be reached");
  assert.equal(t.sent, false, "nothing may be sent");
});

// ─── B ───────────────────────────────────────────────────────────────────────

test("B connected + cached URN + no live URN → live check runs first, cached URN used as address", async () => {
  const { page, t } = mk({ paras: CONNECTED, composeHref: null });

  const r = await sendMessage(page, "Someone", "hi", PROFILE, CACHED_URN);

  assert.equal(t.visitCount, 1, "the profile must be visited before composing");
  assert.ok(t.gotos.findIndex(u => u.startsWith(PROFILE)) < t.gotos.findIndex(u => u.includes("/messaging/compose")),
    `visit must precede compose, got ${JSON.stringify(t.gotos)}`);
  assert.deepEqual(t.composeOpenedWith, [CACHED_URN]);
  assert.equal(t.sent, true);
  assert.equal(r.isFirstDegree, true);
});

// ─── C ───────────────────────────────────────────────────────────────────────

test("C the live URN is preferred over the cached URN", async () => {
  const { page, t } = mk({ paras: CONNECTED, composeHref: composeHrefFor(LIVE_URN) });

  const r = await sendMessage(page, "Someone", "hi", PROFILE, CACHED_URN);

  assert.deepEqual(t.composeOpenedWith, [LIVE_URN], "must address the live URN, not the stale cached one");
  assert.equal(r.messagingUrn, LIVE_URN);
  assert.equal(t.sent, true);
});

// ─── D ───────────────────────────────────────────────────────────────────────

test("D connected but no URN anywhere → MessagingUrnUnresolvedError, no send", async () => {
  const { page, t } = mk({ paras: CONNECTED, composeHref: null });

  await assert.rejects(() => sendMessage(page, "Someone", "hi", PROFILE, null), MessagingUrnUnresolvedError);

  assert.deepEqual(t.composeOpenedWith, []);
  assert.equal(t.sent, false);
});

// ─── E ───────────────────────────────────────────────────────────────────────

test("E cached URN present but live profile not connected → NotConnectedError, no bypass", async () => {
  const { page, t } = mk({ paras: NOT_CONNECTED, composeHref: null });

  await assert.rejects(() => sendMessage(page, "Someone", "hi", PROFILE, CACHED_URN), NotConnectedError);

  assert.equal(t.visitCount, 1, "the live check must still run");
  assert.deepEqual(t.composeOpenedWith, []);
  assert.equal(t.sent, false);
});

// ─── F ───────────────────────────────────────────────────────────────────────

test("F visitProfile runs exactly once, before any compose or send", async () => {
  const { page, t } = mk({ paras: CONNECTED, composeHref: composeHrefFor(LIVE_URN) });

  await sendMessage(page, "Someone", "hi", PROFILE, CACHED_URN);

  assert.equal(t.visitCount, 1, `expected exactly one profile visit, got ${t.visitCount}`);
  assert.equal(t.gotos[0], PROFILE, `the first navigation must be the profile, got ${JSON.stringify(t.gotos)}`);
});

test("F2 a failed compose open does not fall back to any recipient search", async () => {
  const { page, t } = mk({ paras: CONNECTED, composeHref: composeHrefFor(LIVE_URN), composeOpens: false });

  await assert.rejects(() => sendMessage(page, "Someone", "hi", PROFILE, CACHED_URN), MessagingUrnUnresolvedError);

  assert.equal(t.sent, false);
  assert.equal(t.typeaheadTouched, false, "no typeahead / thread-new fallback may exist");
  assert.ok(!t.gotos.some(u => u.includes("thread/new")));
});

// ─── G ───────────────────────────────────────────────────────────────────────

test("G message.ts contains no name-search fallback of any kind", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile("lib/linkedin/message.ts", "utf8");
  for (const banned of ["sendMessageViaTypeahead", "resultNameMatches", "msg-connections-typeahead", "thread/new"]) {
    assert.ok(!src.includes(banned), `message.ts must not reference ${banned}`);
  }
});
