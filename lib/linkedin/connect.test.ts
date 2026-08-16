import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { codeOnly } from "@/tests/support/source-text";
import {
  sendConnectionRequest,
  AlreadyConnectedError,
  PendingInviteError,
  InviteUiError,
  InviteNotSentError,
  SessionExpiredError,
} from "./connect";

// ─── fake Page ───────────────────────────────────────────────────────────────
// connect.ts drives Playwright through a small, fixed set of semantic
// selectors. Rather than emulating a DOM, the fake describes each page
// abstractly and maps those selectors onto it — so a test reads as "the
// profile offers Connect, the invite modal has no Send button" rather than as
// markup.

interface PageState {
  /** null = the <h1>/componentkey top card isn't present at all */
  topCard: { text: string; composeLinks: number; connectCtas: number; composeHref?: string | null;
    /** visible <p> elements; the degree badge is its own <p>· 1st</p> */
    paras?: string[] } | null;
  /** href of the target's OWN Connect link, keyed by their vanityName */
  ownConnectHref: string | null;
  pendingBadges: number;
  sendButton: boolean;
  dialogText: string;
  limitPopup: boolean;
  errorToast: string | null;
  /** vanityNames the sent-invitations manager reports as pending */
  sentInvitations: string[] | null;
}

const blank: PageState = {
  topCard: null,
  ownConnectHref: null,
  pendingBadges: 0,
  sendButton: false,
  dialogText: "",
  limitPopup: false,
  errorToast: null,
  sentInvitations: null,
};

interface Ctx {
  sendClicked: boolean;
  clicks: string[];
}

type Route = { match: RegExp; state: (ctx: Ctx) => Partial<PageState> };

class FakeLocator {
  page: FakePage;
  sel: string;
  scope: "page" | "topCard";

  hasText: string | RegExp | null = null;

  constructor(page: FakePage, sel: string, scope: "page" | "topCard" = "page") {
    this.page = page;
    this.sel = sel;
    this.scope = scope;
  }

  private matches(): number {
    const s = this.state;
    const sel = this.sel;
    if (this.scope === "topCard") {
      if (!s.topCard) return 0;
      if (sel === "p" || sel === "p:visible") {
        const f = this.hasText;
        return (s.topCard.paras ?? []).filter(t => {
          const n = t.replace(/\s+/g, " ").trim();
          return f === null ? true : typeof f === "string" ? n.includes(f) : f.test(n);
        }).length;
      }
      if (sel.includes("/messaging/compose")) return s.topCard.composeLinks;
      if (sel.includes("to connect")) return s.topCard.connectCtas;
      return 0;
    }
    if (sel.includes('componentkey$="Topcard"')) return s.topCard ? 1 : 0;
    if (sel.startsWith("main section")) return 0; // legacy layout not present
    if (sel.includes("custom-invite")) return s.ownConnectHref ? 1 : 0;
    if (sel.includes("Pending")) return s.pendingBadges;
    if (sel.includes("ip-fuse-limit-alert__warning")) return s.limitPopup ? 1 : 0;
    if (sel.includes("artdeco-toast-item-type")) return s.errorToast ? 1 : 0;
    if (sel.includes("Send without") || sel.includes("Send now")) return s.sendButton ? 1 : 0;
    if (sel.includes('role="dialog"')) return s.dialogText ? 1 : 0;
    if (sel.includes('aria-label="More"')) return 0;
    if (sel.includes("menuitem")) return 0;
    return 0;
  }

  private get state(): PageState {
    return this.page.state;
  }

  async count(): Promise<number> {
    return this.matches();
  }
  first(): FakeLocator {
    return this;
  }
  nth(): FakeLocator {
    return this;
  }
  filter(o?: { hasText?: string | RegExp }): FakeLocator {
    if (o?.hasText === undefined) return this;
    const l = new FakeLocator(this.page, this.sel, this.scope);
    l.hasText = o.hasText;
    return l;
  }
  locator(sel: string): FakeLocator {
    return new FakeLocator(this.page, sel, "topCard");
  }
  async waitFor(): Promise<void> {
    if (this.matches() === 0) throw new Error(`Timeout waiting for ${this.sel}`);
  }
  /**
   * No-op. Production uses this only to scroll the CTA clear of the sticky
   * header; the fake has no viewport, so there is nothing to model.
   */
  async evaluate(): Promise<unknown> {
    return undefined;
  }
  async click(): Promise<void> {
    if (this.matches() === 0) throw new Error(`cannot click ${this.sel}`);
    this.page.ctx.clicks.push(this.sel);
    if (this.sel.includes("Send without") || this.sel.includes("Send now")) {
      this.page.ctx.sendClicked = true;
    }
  }
  async getAttribute(name: string): Promise<string | null> {
    if (name !== "href") return null;
    // Compose hrefs are modelled because visitProfile() extracts the messaging
    // URN from them. They are NOT a connection signal — both connections and
    // non-connections carry profileUrn (verified live Aug 2026).
    if (this.sel.includes("/messaging/compose")) return this.state.topCard?.composeHref ?? null;
    return this.state.ownConnectHref;
  }
  async innerText(): Promise<string> {
    const isCard = this.scope === "topCard" || this.sel.includes('componentkey$="Topcard"');
    if (isCard) {
      if (!this.state.topCard) throw new Error("no top card");
      return this.state.topCard.text;
    }
    if (this.sel.includes('role="dialog"')) return this.state.dialogText;
    if (this.sel.includes("artdeco-toast-item-type")) return this.state.errorToast ?? "";
    return "";
  }
}

class FakePage {
  url_ = "about:blank";
  state: PageState = { ...blank };
  ctx: Ctx = { sendClicked: false, clicks: [] };
  navigations: string[] = [];
  routes: Route[];

  constructor(routes: Route[]) {
    this.routes = routes;
  }

  url(): string {
    return this.url_;
  }
  async goto(url: string): Promise<void> {
    this.navigations.push(url);
    this.url_ = url;
    const route = this.routes.find(r => r.match.test(url));
    this.state = { ...blank, ...(route ? route.state(this.ctx) : {}) };
  }
  waits = 0;
  async waitForTimeout(): Promise<void> {
    this.waits++;
  }
  locator(sel: string): FakeLocator {
    return new FakeLocator(this, sel);
  }
  // Only reached via scrapePendingInvitationVanityNames()
  async evaluate(fn: () => unknown): Promise<unknown> {
    const src = fn.toString();
    if (src.includes("scrollTop")) return undefined;
    if (src.includes(".length")) return 1;
    return this.state.sentInvitations ?? [];
  }
}

const PROFILE = "https://www.linkedin.com/in/jamil-khan-55a621346/";
const VANITY = "jamil-khan-55a621346";
const INVITE_HREF = `/preload/custom-invite/?vanityName=${VANITY}`;

const connectableProfile = (): Partial<PageState> => ({
  topCard: { text: "Jamil Khan\n94 connections", composeLinks: 1, connectCtas: 1 },
  ownConnectHref: INVITE_HREF,
});

const makePage = (routes: Route[]) => new FakePage(routes) as unknown as Page;

// ─── tests ───────────────────────────────────────────────────────────────────

test("throws instead of reporting success when the Send button is missing", async () => {
  const page = makePage([
    { match: /\/in\//, state: connectableProfile },
    // Invite page renders, but with no Send button (the regression: the old
    // code found 0 send buttons and returned normally, so the runner logged
    // "Connection request sent" for an invitation that never happened).
    { match: /custom-invite/, state: () => ({ dialogText: "Add a note to your invitation?" }) },
  ]);

  await assert.rejects(() => sendConnectionRequest(page, PROFILE), InviteUiError);
});

test("a missing Send button never reaches the send/verify stage", async () => {
  const fake = new FakePage([
    { match: /\/in\//, state: connectableProfile },
    { match: /custom-invite/, state: () => ({}) },
  ]);
  await assert.rejects(() => sendConnectionRequest(fake as unknown as Page, PROFILE));
  assert.equal(fake.ctx.sendClicked, false);
  // Opening the invite UI now clicks the person's own Connect CTA first, so the
  // guarantee under test is narrower than "nothing was clicked": no Send-shaped
  // control may ever be clicked when no Send button exists.
  assert.ok(
    !fake.ctx.clicks.some(sel => /Send without|Send now|Send invitation/i.test(sel)),
    `no Send control may be clicked, got ${JSON.stringify(fake.ctx.clicks)}`
  );
});

test("throws when Send was clicked but the invitation is not pending afterwards", async () => {
  const page = makePage([
    {
      match: /\/in\//,
      // Still offering Connect after the click == LinkedIn recorded nothing.
      state: connectableProfile,
    },
    { match: /custom-invite/, state: () => ({ sendButton: true, dialogText: "Add a note to your invitation?" }) },
    { match: /invitation-manager/, state: () => ({ sentInvitations: ["someone-else-123"] }) },
  ]);

  await assert.rejects(() => sendConnectionRequest(page, PROFILE), InviteNotSentError);
});

test("returns normally once the profile shows Pending", async () => {
  const page = makePage([
    {
      match: /\/in\//,
      state: ctx =>
        ctx.sendClicked
          ? { topCard: { text: "Jamil Khan\nPending", composeLinks: 1, connectCtas: 0 }, pendingBadges: 1 }
          : connectableProfile(),
    },
    { match: /custom-invite/, state: () => ({ sendButton: true, dialogText: "Add a note to your invitation?" }) },
  ]);

  await sendConnectionRequest(page, PROFILE);
});

test("falls back to the sent-invitations list when the profile shows no Pending badge", async () => {
  const page = makePage([
    {
      match: /\/in\//,
      state: ctx =>
        ctx.sendClicked
          ? { topCard: { text: "Jamil Khan", composeLinks: 1, connectCtas: 0 } }
          : connectableProfile(),
    },
    { match: /custom-invite/, state: () => ({ sendButton: true, dialogText: "Add a note to your invitation?" }) },
    { match: /invitation-manager/, state: () => ({ sentInvitations: [VANITY] }) },
  ]);

  await sendConnectionRequest(page, PROFILE);
});

test("throws SessionExpiredError when LinkedIn serves the login interstitial", async () => {
  // The concrete trigger behind the reported incident: a stale li_at makes
  // /preload/custom-invite bounce to /uas/login, where no Send button exists.
  const fake = new FakePage([]);
  const page = fake as unknown as Page;
  fake.goto = async (url: string) => {
    fake.navigations.push(url);
    fake.url_ = `https://www.linkedin.com/uas/login?session_redirect=${encodeURIComponent(url)}`;
    fake.state = { ...blank };
  };

  await assert.rejects(() => sendConnectionRequest(page, PROFILE), SessionExpiredError);
});

test("fails fast on an authwall instead of polling it for 45s", async () => {
  // An authwall never self-clears, so waiting it out just stalls every target.
  const fake = new FakePage([]);
  fake.goto = async (url: string) => {
    fake.navigations.push(url);
    fake.url_ = `https://www.linkedin.com/authwall?sessionRedirect=${encodeURIComponent(url)}`;
    fake.state = { ...blank };
  };

  await assert.rejects(() => sendConnectionRequest(fake as unknown as Page, PROFILE), SessionExpiredError);
  assert.equal(fake.waits, 0, "should not poll an authwall at all");
});

test("catches an authwall redirect that fires after domcontentloaded", async () => {
  // LinkedIn issues the authwall bounce client-side, so the URL still looks
  // like the profile at the instant goto() resolves.
  const fake = new FakePage([]);
  let pendingRedirect: string | null = null;
  fake.goto = async (url: string) => {
    fake.navigations.push(url);
    fake.url_ = url;
    fake.state = { ...blank, ...connectableProfile() };
    pendingRedirect = `https://www.linkedin.com/authwall?sessionRedirect=${encodeURIComponent(url)}`;
  };
  fake.waitForTimeout = async () => {
    fake.waits++;
    if (pendingRedirect) {
      fake.url_ = pendingRedirect;
      pendingRedirect = null;
      fake.state = { ...blank };
    }
  };

  await assert.rejects(() => sendConnectionRequest(fake as unknown as Page, PROFILE), SessionExpiredError);
});

test("throws PendingInviteError when an invitation is already pending", async () => {
  const page = makePage([
    {
      match: /\/in\//,
      state: () => ({ topCard: { text: "Jamil Khan\nPending", composeLinks: 0, connectCtas: 0 }, pendingBadges: 1 }),
    },
  ]);

  await assert.rejects(() => sendConnectionRequest(page, PROFILE), PendingInviteError);
});

test("throws AlreadyConnectedError for a 1st-degree connection", async () => {
  const page = makePage([
    {
      match: /\/in\//,
      state: () => ({ topCard: { text: "Jamil Khan\n1st\n94 connections", composeLinks: 1, connectCtas: 0,
        paras: ["Jamil Khan", "· 1st"],
        composeHref: "/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AACoAAReal" } }),
    },
  ]);

  await assert.rejects(() => sendConnectionRequest(page, PROFILE), AlreadyConnectedError);
});

test("a Message link in the top card does not imply connected while Connect is offered", async () => {
  // Regression guard for the Jul 2026 incident class: the current layout shows
  // /messaging/compose on the top card of NON-connections too, so the compose
  // link alone must not short-circuit into AlreadyConnectedError.
  const page = makePage([
    {
      match: /\/in\//,
      state: ctx =>
        ctx.sendClicked
          ? { topCard: { text: "Jamil Khan\nPending", composeLinks: 1, connectCtas: 0 }, pendingBadges: 1 }
          : connectableProfile(),
    },
    { match: /custom-invite/, state: () => ({ sendButton: true, dialogText: "Add a note to your invitation?" }) },
  ]);

  await sendConnectionRequest(page, PROFILE);
});

// ─── N7: the two "no vanity" paths must agree ────────────────────────────────
//
// openInviteDialog has two ways in. Case 2 (the More menu) already refuses:
//   "Without a vanity there is nothing to bind to, and guessing is how you
//    invite a stranger."  (connect.ts:343)
// Case 1 (the direct CTA) fell back to an UNSCOPED selector —
//   a[aria-label*="Invite"][aria-label*="to connect"]:visible, a[href*="custom-invite"]:visible
// — which matches any invitation link anywhere on the page. LinkedIn renders
// exactly that markup for "People also viewed" and "More profiles for you", so
// on a profile whose own URL carries no parseable vanity, the first match can
// belong to a completely different person. Same function, same reasoning,
// opposite behaviour.

/** A URL that reaches the profile but yields no vanity: vanityNameOf returns null. */
const NO_VANITY_PROFILE = "https://www.linkedin.com/in/";

test("N7 repro: a profile with no resolvable vanity must not invite a bystander", async () => {
  // The page offers a Connect CTA that belongs to SOMEONE ELSE — the shape of a
  // sidebar recommendation. With no vanity there is nothing to bind to, so the
  // unscoped fallback would happily click it.
  const fake = new FakePage([
    { match: /\/in\//, state: () => ({
        ...connectableProfile(),
        ownConnectHref: "/preload/custom-invite/?vanityName=somebody-else",
      }) },
    { match: /custom-invite/, state: () => ({ sendButton: true, dialogText: "Add a note" }) },
  ]);

  await assert.rejects(
    () => sendConnectionRequest(fake as unknown as Page, NO_VANITY_PROFILE),
    InviteUiError,
    "must refuse, exactly as the More-menu path already does"
  );
});

test("N7: refusing happens with ZERO clicks — no invitation can have been sent", async () => {
  // The guarantee that matters. Throwing after clicking is not a fix: the
  // invitation is irreversible and the ledger would have nothing recorded.
  const fake = new FakePage([
    { match: /\/in\//, state: () => ({
        ...connectableProfile(),
        ownConnectHref: "/preload/custom-invite/?vanityName=somebody-else",
      }) },
    { match: /custom-invite/, state: () => ({ sendButton: true, dialogText: "Add a note" }) },
  ]);

  await assert.rejects(() => sendConnectionRequest(fake as unknown as Page, NO_VANITY_PROFILE));
  assert.equal(fake.ctx.sendClicked, false, "no Send was clicked");
  assert.deepEqual(fake.ctx.clicks, [], "and nothing at all was clicked — not even the CTA");
});

test("N7: a resolvable vanity still connects normally", async () => {
  // The refusal must be scoped to the null case only. This is the control that
  // stops the fix from being "disable invitations".
  const fake = new FakePage([
    { match: /\/in\//, state: connectableProfile },
    { match: /custom-invite/, state: () => ({ sendButton: true, dialogText: "Add a note" }) },
    { match: /invitation-manager/, state: () => ({ sentInvitations: ["jamil-khan-55a621346"] }) },
  ]);
  await sendConnectionRequest(fake as unknown as Page, PROFILE);
  assert.equal(fake.ctx.sendClicked, true, "a normal invitation is unaffected");
});

test("N7b/§3.4: verifyInvitationSent's vanity comparison is never reached with a null vanity", () => {
  // Signal 2 of verifyInvitationSent compares a vanity against the
  // sent-invitations scrape, and `vanity ? ... : 0` means a null vanity would
  // read as "not offered / not pending" — an absence inference of exactly the
  // kind N7b is about.
  //
  // It is UNREACHABLE, and the reason is ordering rather than a check of its
  // own: sendConnectionRequest calls openInviteDialog before
  // verifyInvitationSent, and openInviteDialog now throws on a null vanity. So
  // control never arrives. Asserted here as an ORDERING property, because that
  // is the thing a future edit could silently break — moving verification
  // earlier, or catching InviteUiError, would make signal 2 live again.
  const src = codeOnlyConnect();
  const openIdx = src.indexOf("await openInviteDialog(");
  const verifyIdx = src.indexOf("await verifyInvitationSent(");
  assert.ok(openIdx > 0 && verifyIdx > 0, "both calls must exist");
  assert.ok(openIdx < verifyIdx,
    "openInviteDialog must run BEFORE verifyInvitationSent — that ordering is what makes " +
    "signal 2 unreachable with a null vanity");

  // And the refusal must not be caught between them.
  const between = src.slice(openIdx, verifyIdx);
  assert.ok(!/catch\s*\(/.test(between),
    "nothing may swallow the refusal between opening the invite UI and verifying it");
});

function codeOnlyConnect(): string {
  // Comments and strings stripped — the §2 rule. This assertion is about call
  // ORDER in code, and connect.ts's prose mentions both function names.
  //
  // H2 (2026-08-16): this was a PRIVATE COPY of the old regex helper, left
  // behind when ca35aaf replaced the shared one with a walker. It truncated
  // `const HARD_WALL_RE = /\/authwall\b|\/checkpoint\//;` at the `//` inside the
  // regex literal — real code, deleted silently. The assertions below survived
  // only because they are anchored positively (`openIdx > 0 && verifyIdx > 0`)
  // and the damage fell outside the slice they read. Now delegated, so there is
  // one implementation and `tests/source-text-drift.test.ts` keeps it that way.
  return codeOnly(readFileSync("lib/linkedin/connect.ts", "utf8"));
}
