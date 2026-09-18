import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserOwner } from "@/lib/linkedin/ownership";
import { scrapeNavigatorList } from "@/lib/linkedin/scraper";

const LIST_URL = "https://www.linkedin.com/sales/lists/people/123";

interface Script {
  /** page number -> raw elements for that page, or null for "no intercept" */
  pages: Record<number, Array<{ entityUrn: string }> | null>;
  knownTotal: number;
  /** call `onGoto(n)` after handling page n's goto (used to flip abort/cancel flags mid-run) */
  onGoto?: (n: number) => void;
}

function makeFakePage(script: Script) {
  let listener: ((response: {
    url: () => string;
    status: () => number;
    json: () => Promise<unknown>;
  }) => void | Promise<void>) | null = null;
  let lastUrl = "";

  const fakePage = {
    async goto(url: string) {
      lastUrl = url;
      const m = url.match(/[?&]page=(\d+)/);
      const n = m ? parseInt(m[1], 10) : 1;
      const elements = script.pages[n];
      if (elements !== null && elements !== undefined && listener) {
        const response = {
          url: () => "https://www.linkedin.com/voyager/api/salesApiPeopleSearch?x=1",
          status: () => 200,
          json: async () => ({ elements, paging: { total: script.knownTotal } }),
        };
        await listener(response);
      }
      script.onGoto?.(n);
    },
    async waitForTimeout() {
      return;
    },
    on(event: string, cb: typeof listener) {
      if (event === "response") listener = cb;
    },
    removeAllListeners(event: string) {
      if (event === "response") listener = null;
    },
    url() {
      return lastUrl;
    },
    async close() {
      return;
    },
  };
  return fakePage;
}

function makeOwner(fakePage: ReturnType<typeof makeFakePage>, signal: AbortSignal): BrowserOwner {
  return {
    accountId: "a",
    label: "t",
    signal,
    context: { pages: () => [], newPage: async () => fakePage },
    newPage: async () => fakePage,
  } as unknown as BrowserOwner;
}

function el(id: string) {
  return { entityUrn: `urn:li:fs_salesProfile:(${id},NAME_SEARCH,${id})` };
}

test("SC1: onPage fires for every verified page, lastPage advances, exhausted when window covers the whole list", async () => {
  const script: Script = {
    pages: {
      1: [el("p1"), el("p2")],
      2: [el("p3")],
      3: [el("p4")],
    },
    knownTotal: 75, // PAGE_SIZE=25 -> 3 total pages
  };
  const fakePage = makeFakePage(script);
  const controller = new AbortController();
  const owner = makeOwner(fakePage, controller.signal);

  const seenPages: Array<{ page: number; count: number }> = [];
  const result = await scrapeNavigatorList(owner, LIST_URL, {
    maxPages: 3,
    onPage: (pageNum, profiles) => {
      seenPages.push({ page: pageNum, count: profiles.length });
    },
  });

  assert.deepEqual(seenPages, [
    { page: 1, count: 2 },
    { page: 2, count: 1 },
    { page: 3, count: 1 },
  ]);
  assert.equal(result.lastPage, 3);
  assert.equal(result.exhausted, true);
  assert.equal(result.stalled, undefined);
  assert.equal(result.profiles.length, 4);
});

test("SC2: a page missing after retry stalls the window without advancing lastPage", async () => {
  const script: Script = {
    pages: {
      1: [el("p1")],
      2: null, // no intercept, and retry also gets null (same script entry)
      3: [el("p3")], // never reached
    },
    knownTotal: 75,
  };
  const fakePage = makeFakePage(script);
  const controller = new AbortController();
  const owner = makeOwner(fakePage, controller.signal);

  const seenPages: number[] = [];
  const result = await scrapeNavigatorList(owner, LIST_URL, {
    maxPages: 3,
    onPage: (pageNum) => {
      seenPages.push(pageNum);
    },
  });

  assert.deepEqual(seenPages, [1]);
  assert.equal(result.lastPage, 1);
  assert.ok(result.stalled);
  assert.equal(result.stalled?.page, 2);
  assert.match(result.stalled?.reason ?? "", /no data intercepted/);
  assert.equal(result.exhausted, false);
  assert.equal(result.profiles.length, 1);
});

test("SC3: owner.signal aborted before page 2 stops the loop without throwing and without stalled", async () => {
  const script: Script = {
    pages: {
      1: [el("p1")],
      2: [el("p2")], // scripted but should never be fetched
    },
    knownTotal: 75,
  };
  const controller = new AbortController();
  const script2: Script = {
    ...script,
    onGoto: (n) => {
      if (n === 1) controller.abort();
    },
  };
  const fakePage = makeFakePage(script2);
  const owner = makeOwner(fakePage, controller.signal);

  const seenPages: number[] = [];
  const result = await scrapeNavigatorList(owner, LIST_URL, {
    maxPages: 3,
    onPage: (pageNum) => {
      seenPages.push(pageNum);
    },
  });

  assert.deepEqual(seenPages, [1]);
  assert.equal(result.lastPage, 1);
  assert.equal(result.stalled, undefined);
});

test("SC4: isCanceled true before page 2 stops the loop the same way as an abort, without stalled", async () => {
  const script: Script = {
    pages: {
      1: [el("p1")],
      2: [el("p2")], // scripted but should never be fetched
    },
    knownTotal: 75,
  };
  const fakePage = makeFakePage(script);
  const controller = new AbortController();
  const owner = makeOwner(fakePage, controller.signal);

  const seenPages: number[] = [];
  const result = await scrapeNavigatorList(owner, LIST_URL, {
    maxPages: 3,
    isCanceled: () => true,
    onPage: (pageNum) => {
      seenPages.push(pageNum);
    },
  });

  assert.deepEqual(seenPages, [1]);
  assert.equal(result.lastPage, 1);
  assert.equal(result.stalled, undefined);
});
