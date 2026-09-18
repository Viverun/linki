import test, { after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import Papa from "papaparse";
import type { BrowserContext, Route } from "playwright";
import type { NextApiRequest, NextApiResponse } from "next";
import { importCsv } from "@/lib/csv-import";
import { isAllowedSalesNavLeadUrl } from "@/lib/linkedin-url";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE targets (
    id TEXT PRIMARY KEY, linkedin_url TEXT UNIQUE, email TEXT, sales_nav_url TEXT,
    full_name TEXT, first_name TEXT, last_name TEXT, title TEXT, company TEXT,
    location TEXT, city TEXT, country TEXT, phone TEXT, headline TEXT, summary TEXT,
    notes TEXT, positions_json TEXT, skills_json TEXT, enriched_profile_at TEXT,
    posts_json TEXT, posts_scraped_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE list_targets (
    list_id TEXT, target_id TEXT, PRIMARY KEY (list_id, target_id)
  );
`);

const mockModule = mock.module.bind(mock) as unknown as
  (specifier: string, options: { namedExports: Record<string, unknown> }) => void;
let dbCalls = 0;
mockModule("@/lib/db", {
  namedExports: { getDb: () => { dbCalls++; return db; } },
});
const { enrichProfile, enrichList } = await import("@/lib/linkedin/enrich");
const { scrapeProfile, InvalidSalesNavUrlError, ProfileNavigationError } = await import("@/lib/linkedin/profile-scrape");
let sessionCalls = 0;
let accountCalls = 0;
let apiBrowser: ReturnType<typeof browser>;
mockModule("@/lib/linkedin/session", {
  namedExports: {
    getSessionContext: async () => { sessionCalls++; return apiBrowser.ctx; },
    markNeedsReauth: async () => { throw new Error("Unexpected reauth mutation"); },
  },
});
mockModule("@/lib/linkedin/resolve-account", {
  namedExports: { resolveLinkedInAccount: () => { accountCalls++; return { id: "fixture-account" }; } },
});
// C2-B1/PR-09: the API route now acquires its page through the per-account
// browser owner (lib/linkedin/ownership.ts) rather than calling
// getSessionContext directly — wire its context provider to the same fixture
// ctx, counted the same way the old getSessionContext mock above was.
const own = await import("@/lib/linkedin/ownership");
own.setBrowserContextProvider(async () => { sessionCalls++; return apiBrowser.ctx; });
const { default: scrapeHandler } = await import("@/pages/api/targets/[id]/profile-scrape");

after(() => {
  db.close();
  mock.restoreAll();
});
beforeEach(() => {
  db.exec("DELETE FROM list_targets; DELETE FROM targets;");
  dbCalls = 0;
  sessionCalls = 0;
  accountCalls = 0;
  apiBrowser = browser();
});

const validUrls = [
  "https://www.linkedin.com/sales/lead/ACwAA123_-",
  "https://linkedin.com/sales/lead/ACwAA123,NAME_SEARCH",
  "https://uk.linkedin.com/sales/lead/ACwAA123,abc_123,NAME_SEARCH",
  "https://www.linkedin.com/sales/lead/ACwAA123,,NAME_SEARCH/",
  "https://www.linkedin.com/sales/lead/ACwAA123%2Cabc_123%2cNAME_SEARCH?trk=fixture#profile",
  "https://WWW.LINKEDIN.COM:443/sales/lead/ACwAA123?view=profile",
];
const invalidUrls = [
  "not a URL",
  "linkedin.com/sales/lead/ABC",
  "//www.linkedin.com/sales/lead/ABC",
  "http://www.linkedin.com/sales/lead/ABC",
  "ftp://www.linkedin.com/sales/lead/ABC",
  "file:///sales/lead/ABC",
  "data:text/plain,fixture",
  "javascript:void(0)",
  "https://example.test/sales/lead/ABC",
  "https://linkedin.com.example.test/sales/lead/ABC",
  "https://notlinkedin.com/sales/lead/ABC",
  "https://example.test/?url=https://www.linkedin.com/sales/lead/ABC",
  "https://www.linkedin.com@fixture.test/sales/lead/ABC",
  "https://fixture@www.linkedin.com/sales/lead/ABC",
  "https://fixture:secret@www.linkedin.com/sales/lead/ABC",
  "https://@www.linkedin.com/sales/lead/ABC",
  "https://www.linkedin.com:8443/sales/lead/ABC",
  "https://www.linkedin.com./sales/lead/ABC",
  "https://www.linkedin.com/in/fixture",
  "https://www.linkedin.com/sales/home",
  "https://www.linkedin.com/sales/lists/people/123",
  "https://www.linkedin.com/sales/search/people?savedSearchId=123",
  "https://www.linkedin.com/?next=/sales/lead/ABC",
  "https://www.linkedin.com/#/sales/lead/ABC",
  "https://www.linkedin.com/sales/lead/",
  "https://www.linkedin.com/sales/lead/ABC/extra",
  "https://www.linkedin.com/sales/lead/ABC,one,two,three",
  "https://www.linkedin.com/sales/lead/ABC%2Fextra",
  "https://www.linkedin.com/sales/lead/ABC%5Cextra",
  "https://www.linkedin.com/sales/lead/%252FABC",
  "https://www.linkedin.com/sales/lead/ABC%",
  "https://www.linkedin.com/sales/lead/ABC/../DEF",
  "https://www.linkedin.com/other/../sales/lead/ABC",
  "https://www.linkedin.com/sales/lead/%2e%2e/ABC",
  "https://www.linkedin.com\\sales\\lead\\ABC",
  "https://www.linked\nin.com/sales/lead/ABC",
  "https:////www.linkedin.com/sales/lead/ABC",
];

function csv(rows: Array<Record<string, string>>) {
  return Papa.unparse(rows);
}

function snapshots() {
  return {
    targets: db.prepare("SELECT * FROM targets ORDER BY id").all(),
    members: db.prepare("SELECT * FROM list_targets ORDER BY list_id, target_id").all(),
  };
}

function browser(options: { landingUrl?: string; delayedUrl?: string; noData?: boolean; navigationError?: boolean; routedUrl?: string; lateRoutedUrl?: string; routeError?: boolean } = {}) {
  const calls: string[] = [];
  const mainFrame = {};
  let currentUrl = "about:blank";
  let responseHandler: ((response: unknown) => Promise<void>) | undefined;
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  async function request(url: string, navigation = true, main = true) {
    let outcome = "unhandled";
    assert.ok(routeHandler);
    await routeHandler({
      request: () => ({ url: () => url, isNavigationRequest: () => navigation, frame: () => main ? mainFrame : {} }),
      continue: async () => { outcome = "continued"; },
      abort: async () => { outcome = "aborted"; },
    } as unknown as Route);
    return outcome;
  }
  const page = {
    mainFrame: () => mainFrame,
    async route(pattern: string, handler: (route: Route) => Promise<void>) {
      calls.push("route");
      assert.equal(pattern, "**/*");
      if (options.routeError) throw new Error("synthetic route setup failure");
      routeHandler = handler;
    },
    on(event: string, handler: (response: unknown) => Promise<void>) {
      calls.push(`on:${event}`);
      responseHandler = handler;
    },
    async goto(url: string) {
      calls.push(`goto:${url}`);
      if (options.navigationError) throw new Error("synthetic navigation failure");
      assert.equal(await request(url), "continued");
      if (options.routedUrl && await request(options.routedUrl) === "aborted") throw new Error("net::ERR_FAILED");
      currentUrl = options.landingUrl ?? options.routedUrl ?? url;
      if (!options.noData) await responseHandler?.({
        url: () => "https://www.linkedin.com/sales-api/salesApiProfiles/fixture",
        status: () => 200,
        json: async () => ({
          entityUrn: "urn:li:fs_salesProfile:fixture",
          firstName: "Fixture",
          headline: "Enriched headline",
          summary: "Enriched summary",
          positions: [{ title: "Engineer", companyName: "Fixture", current: true }],
          skills: [{ name: "Testing" }],
        }),
      });
    },
    url() { calls.push("url"); return currentUrl; },
    async waitForTimeout() {
      calls.push("wait");
      if (options.lateRoutedUrl) await request(options.lateRoutedUrl);
      currentUrl = options.delayedUrl ?? currentUrl;
    },
    async close() { calls.push("close"); },
  };
  const ctx = {
    async newPage() { calls.push("newPage"); return page; },
    async cookies() { calls.push("cookies"); return []; },
  } as unknown as BrowserContext;
  return { ctx, calls, request };
}

test("PR-07: the lead policy rejects unsupported destinations and preserves supported forms", () => {
  for (const url of validUrls) assert.equal(isAllowedSalesNavLeadUrl(url), true, url);
  for (const url of [...invalidUrls, "", null, undefined]) {
    assert.equal(isAllowedSalesNavLeadUrl(url), false, String(url));
  }
});

test("PR-07: invalid CSV URLs produce row errors without inserts or memberships", async () => {
  const { ctx, calls } = browser();
  const result = importCsv(db, "fixture-list", csv(invalidUrls.map((sales_nav_url, index) => ({
    linkedin_url: `https://www.linkedin.com/in/fixture-${index}`,
    sales_nav_url,
    email: `fixture-${index}@example.test`,
  }))));
  assert.deepEqual(result, {
    imported: 0, updated: 0, skipped: 0,
    errors: invalidUrls.map((_, index) => `Row ${index + 2}: sales_nav_url must be an HTTPS LinkedIn Sales Navigator lead URL (/sales/lead/...)`),
  });
  assert.deepEqual(snapshots(), { targets: [], members: [] });
  assert.deepEqual(await enrichList(ctx, "fixture-list", 0), { enriched: 0, failed: 0 });
  assert.deepEqual(calls, []);
});

test("PR-07: invalid URLs cannot update existing LinkedIn or email targets or attach them to a list", () => {
  const seed = [
    { linkedin_url: "https://www.linkedin.com/in/fixture", email: "", sales_nav_url: validUrls[0], first_name: "Original" },
    { linkedin_url: "", email: "fixture@example.test", sales_nav_url: validUrls[1], first_name: "Original" },
  ];
  assert.equal(importCsv(db, "original-list", csv(seed)).imported, 2);
  const before = snapshots();
  for (const sales_nav_url of invalidUrls) {
    for (const listId of ["original-list", "new-list"]) {
      const result = importCsv(db, listId, csv(seed.map(row => ({ ...row, sales_nav_url, first_name: "Changed" }))));
      assert.equal(result.errors.length, 2);
      assert.equal(result.imported + result.updated + result.skipped, 0);
      assert.deepEqual(snapshots(), before);
    }
  }
});

test("PR-07: mixed CSV reports rejected rows while valid and blank optional URLs retain import behavior", () => {
  const rows = [
    { email: "invalid@example.test", sales_nav_url: invalidUrls[0] },
    ...validUrls.map((sales_nav_url, index) => ({ email: `valid-${index}@example.test`, sales_nav_url })),
    { email: "blank@example.test", sales_nav_url: "" },
    { email: "trimmed@example.test", sales_nav_url: `  ${validUrls[0]}  ` },
  ];
  const result = importCsv(db, "fixture-list", csv(rows));
  assert.equal(result.imported, validUrls.length + 2);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.errors, ["Row 2: sales_nav_url must be an HTTPS LinkedIn Sales Navigator lead URL (/sales/lead/...)"]);
  assert.deepEqual(db.prepare("SELECT sales_nav_url FROM targets ORDER BY rowid").all(),
    [...validUrls, null, validUrls[0]].map(sales_nav_url => ({ sales_nav_url })));
  const repeat = importCsv(db, "fixture-list", csv(rows.slice(1)));
  assert.deepEqual(repeat, { imported: 0, updated: 0, skipped: validUrls.length + 2, errors: [] });
});

test("PR-07: enrichment independently rejects pre-existing invalid URLs before any browser or DB call", async () => {
  for (const sales_nav_url of [...invalidUrls, ""]) {
    const { ctx, calls } = browser();
    assert.equal(await enrichProfile(ctx, { id: "fixture", full_name: "Fixture", sales_nav_url }), false);
    assert.deepEqual(calls, []);
  }
  assert.equal(dbCalls, 0);
});

test("PR-07: supported CSV lead URLs still navigate unchanged and persist enrichment", async () => {
  for (const [index, sales_nav_url] of validUrls.entries()) {
    const email = `valid-${index}@example.test`;
    assert.equal(importCsv(db, "fixture-list", csv([{ email, sales_nav_url }])).imported, 1);
    const target = db.prepare("SELECT id, sales_nav_url, full_name FROM targets WHERE email = ?").get(email) as
      { id: string; sales_nav_url: string; full_name: string };
    const { ctx, calls } = browser();
    assert.equal(await enrichProfile(ctx, target), true);
    assert.deepEqual(calls, ["newPage", "route", "on:response", `goto:${sales_nav_url}`, "url", "wait", "url", "close"]);
    const enriched = db.prepare("SELECT headline, summary, positions_json, skills_json, enriched_profile_at FROM targets WHERE id = ?").get(target.id) as
      { headline: string; summary: string; positions_json: string; skills_json: string; enriched_profile_at: string | null };
    assert.equal(enriched.headline, "Enriched headline");
    assert.equal(enriched.summary, "Enriched summary");
    assert.deepEqual(JSON.parse(enriched.positions_json), [{ title: "Engineer", companyName: "Fixture", current: true }]);
    assert.deepEqual(JSON.parse(enriched.skills_json), ["Testing"]);
    assert.ok(enriched.enriched_profile_at);
  }
});

test("PR-07: list enrichment counts legacy invalid rows as failed without browser calls", async () => {
  db.prepare("INSERT INTO targets (id, sales_nav_url, full_name) VALUES (?, ?, ?)")
    .run("legacy", invalidUrls[0], "Fixture");
  db.prepare("INSERT INTO list_targets VALUES (?, ?)").run("fixture-list", "legacy");
  const before = snapshots();
  const { ctx, calls } = browser();
  const progress: number[][] = [];
  assert.deepEqual(await enrichList(ctx, "fixture-list", 0, (count, total) => progress.push([count, total])),
    { enriched: 0, failed: 1 });
  assert.deepEqual(progress, [[1, 1]]);
  assert.deepEqual(calls, []);
  assert.deepEqual(snapshots(), before);
});

test("PR-07: unsupported landing URLs and late redirects cannot mark enrichment successful", async () => {
  importCsv(db, "fixture-list", csv([{ email: "fixture@example.test", sales_nav_url: validUrls[0] }]));
  const target = db.prepare("SELECT id, sales_nav_url, full_name FROM targets").get() as
    { id: string; sales_nav_url: string; full_name: string };
  const before = snapshots();
  for (const url of ["https://example.test/", "https://www.linkedin.com/login", "http://www.linkedin.com/sales/lead/ABC"]) {
    for (const options of [{ landingUrl: url }, { delayedUrl: url }]) {
      const { ctx, calls } = browser(options);
      assert.equal(await enrichProfile(ctx, target), false);
      assert.equal(calls.at(-1), "close");
      assert.equal(calls.includes("wait"), "delayedUrl" in options);
      assert.deepEqual(snapshots(), before);
    }
  }
  const { ctx } = browser({ landingUrl: validUrls[1], delayedUrl: validUrls[2] });
  assert.equal(await enrichProfile(ctx, target), true);
});

test("PR-07: profile scrape rejects legacy invalid lead URLs before browser acquisition", async () => {
  for (const sales_nav_url of invalidUrls) {
    const { ctx, calls } = browser();
    await assert.rejects(scrapeProfile(ctx, { sales_nav_url, linkedin_url: null }), InvalidSalesNavUrlError);
    assert.deepEqual(calls, []);
  }
});

async function callScrapeApi(id: string) {
  const result = { status: 200, body: undefined as unknown };
  const res = {
    status(status: number) { result.status = status; return this; },
    json(body: unknown) { result.body = body; return this; },
  } as unknown as NextApiResponse;
  await scrapeHandler({ method: "POST", query: { id }, body: {} } as unknown as NextApiRequest, res);
  return result;
}

test("PR-07: API rejects invalid stored URLs before resolving an account or acquiring a session", async () => {
  for (const sales_nav_url of invalidUrls) {
    db.prepare("INSERT OR REPLACE INTO targets (id, sales_nav_url) VALUES (?, ?)").run("legacy", sales_nav_url);
    const before = snapshots();
    assert.deepEqual(await callScrapeApi("legacy"), { status: 400, body: { error: new InvalidSalesNavUrlError().message } });
    assert.deepEqual(snapshots(), before);
  }
  assert.equal(accountCalls, 0);
  assert.equal(sessionCalls, 0);
  assert.deepEqual(apiBrowser.calls, []);
});

test("PR-07: valid stored URLs still scrape and persist through the API", async () => {
  for (const sales_nav_url of validUrls) {
    db.prepare("INSERT OR REPLACE INTO targets (id, sales_nav_url) VALUES (?, ?)").run("valid", sales_nav_url);
    apiBrowser = browser();
    const result = await callScrapeApi("valid");
    assert.equal(result.status, 200);
    assert.ok(apiBrowser.calls.includes(`goto:${sales_nav_url}`));
    assert.equal(apiBrowser.calls.at(-1), "close");
    const row = db.prepare("SELECT headline, posts_scraped_at FROM targets WHERE id = ?").get("valid") as
      { headline: string; posts_scraped_at: string };
    assert.equal(row.headline, "Enriched headline");
    assert.ok(row.posts_scraped_at);
  }
  assert.equal(sessionCalls, validUrls.length);
});

test("PR-07: routes reject only unsupported main-frame navigation and permit resources and subframes", async () => {
  for (const scrape of [false, true]) {
    const fixture = browser();
    if (scrape) await scrapeProfile(fixture.ctx, { sales_nav_url: validUrls[0], linkedin_url: null });
    else assert.equal(await enrichProfile(fixture.ctx, { id: "fixture", full_name: "Fixture", sales_nav_url: validUrls[0] }), true);
    for (const url of validUrls) assert.equal(await fixture.request(url), "continued");
    for (const url of invalidUrls) assert.equal(await fixture.request(url), "aborted");
    for (const url of ["https://static.example.test/app.js", "https://www.linkedin.com/sales-api/salesApiProfiles/fixture"]) {
      assert.equal(await fixture.request(url, false), "continued");
      assert.equal(await fixture.request(url, true, false), "continued");
    }
  }
});

test("PR-07: blocked routed navigation cannot produce success even if the page remains on the lead", async () => {
  for (const url of ["https://example.test/", "https://www.linkedin.com/login", "https://www.linkedin.com/checkpoint/"]) {
    for (const options of [{ routedUrl: url }, { lateRoutedUrl: url }]) {
      const enrichment = browser(options);
      assert.equal(await enrichProfile(enrichment.ctx, { id: "fixture", full_name: "Fixture", sales_nav_url: validUrls[0] }), false);
      assert.equal(enrichment.calls.at(-1), "close");
      const scrape = browser(options);
      await assert.rejects(scrapeProfile(scrape.ctx, { sales_nav_url: validUrls[0], linkedin_url: null }), ProfileNavigationError);
      assert.equal(scrape.calls.at(-1), "close");
    }
  }
});

test("PR-07: profile scrape rejects unsupported landings and API reports upstream failure without persistence", async () => {
  db.prepare("INSERT INTO targets (id, sales_nav_url) VALUES (?, ?)").run("valid", validUrls[0]);
  const before = snapshots();
  for (const options of [
    { landingUrl: "https://example.test/" },
    { delayedUrl: "https://www.linkedin.com/login" },
    { routedUrl: "https://www.linkedin.com/login" },
  ]) {
    apiBrowser = browser(options);
    assert.deepEqual(await callScrapeApi("valid"), { status: 502, body: { error: new ProfileNavigationError().message } });
    assert.deepEqual(snapshots(), before);
    assert.equal(apiBrowser.calls.at(-1), "close");
  }
});

test("PR-07: optional posts navigation is confined to the fixed feed page without blocking resources", async () => {
  const fixture = browser();
  const result = await scrapeProfile(fixture.ctx, {
    sales_nav_url: validUrls[0], linkedin_url: "https://www.linkedin.com/in/fixture",
  });
  assert.deepEqual(result.recent_posts, []);
  assert.equal(fixture.calls.filter(call => call === "newPage").length, 2);
  assert.ok(fixture.calls.includes("goto:https://www.linkedin.com/feed/"));
  assert.equal(await fixture.request("https://www.linkedin.com/feed/"), "continued");
  assert.equal(await fixture.request("https://www.linkedin.com/login"), "aborted");
  assert.equal(await fixture.request("https://example.test/"), "aborted");
  assert.equal(await fixture.request("https://static.example.test/app.js", false), "continued");
  assert.equal(fixture.calls.at(-1), "close");
});

test("PR-07: route setup failure closes both consumers without navigation", async () => {
  const enrichment = browser({ routeError: true });
  assert.equal(await enrichProfile(enrichment.ctx, { id: "fixture", full_name: "Fixture", sales_nav_url: validUrls[0] }), false);
  const scrape = browser({ routeError: true });
  await assert.rejects(scrapeProfile(scrape.ctx, { sales_nav_url: validUrls[0], linkedin_url: null }), /synthetic route setup failure/);
  for (const fixture of [enrichment, scrape]) {
    assert.equal(fixture.calls.at(-1), "close");
    assert.equal(fixture.calls.some(call => call.startsWith("goto:")), false);
  }
});

test("PR-07: missing profile data and navigation errors remain failures and close the page", async () => {
  importCsv(db, "fixture-list", csv([{ email: "fixture@example.test", sales_nav_url: validUrls[0] }]));
  const target = db.prepare("SELECT id, sales_nav_url, full_name FROM targets").get() as
    { id: string; sales_nav_url: string; full_name: string };
  const before = snapshots();
  for (const options of [{ noData: true }, { navigationError: true }]) {
    const { ctx, calls } = browser(options);
    assert.equal(await enrichProfile(ctx, target), false);
    assert.equal(calls.at(-1), "close");
    assert.deepEqual(snapshots(), before);
  }
});
