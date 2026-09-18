/**
 * Sales Navigator list scraper using the internal Sales API.
 * Uses Playwright's browser context request (inherits browser TLS fingerprint).
 *
 * Response format discovery (from capture scripts):
 * - ctx.request returns normalized JSON: { data: { metadata: { totalDisplayCount: "106" } }, included: [...] }
 * - Profiles are in `included` filtered by entityUrn containing "salesProfile"
 * - Browser-intercepted first page returns flat: { elements: [...], paging: { total } }
 * - Query format: parentheses/commas unencoded, colons in URN encoded as %3A
 *
 * IMPORTANT — vanityName is gone from salesApiPeopleSearch (dropped by LinkedIn ~March 2026):
 * The list API no longer returns vanityName. To get the real /in/ URL we call
 * salesApiProfiles per batch of 25 after scraping, using flagshipProfileUrl.
 * See docs/linkedin-api-learnings.md for the full investigation.
 */
import type { BrowserOwner } from "@/lib/linkedin/ownership";

export interface ScrapedProfile {
  salesNavUrn: string;
  salesNavUrl: string;
  linkedinUrl: string | null;  // regular /in/ URL
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  degree: number | null;
  // Extended fields
  objectUrn: string | null;       // urn:li:member:XXXX — stable LinkedIn member ID
  summary: string | null;         // About / bio text
  openLink: boolean;              // can message without connecting
  companyIndustry: string | null;
  companyLocation: string | null; // company HQ location
  tenureMonths: number | null;    // months in current role
  spotlightBadges: string | null; // JSON array of badge displayValues
}

interface SalesProfile {
  entityUrn: string;
  objectUrn?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  vanityName?: string;
  geoRegion?: string;
  degree?: number;
  summary?: string;
  openLink?: boolean;
  premium?: boolean;
  pendingInvitation?: boolean;
  currentPositions?: Array<{
    title?: string;
    companyName?: string;
    companyUrn?: string;
    current?: boolean;
    description?: string;
    startedOn?: { year?: number; month?: number };
    tenureAtPosition?: { numYears?: number; numMonths?: number };
    tenureAtCompany?: { numYears?: number; numMonths?: number };
    companyUrnResolutionResult?: {
      name?: string;
      industry?: string;
      location?: string;
      entityUrn?: string;
    };
  }>;
  leadAssociatedAccount?: { name?: string } | null;
  spotlightBadges?: Array<{ displayValue?: string; id?: string }>;
}

// Flat response intercepted from browser
interface FlatResponse {
  elements?: SalesProfile[];
  paging?: { total: number; count: number; start: number };
}

function extractListId(url: string): string | null {
  const match = url.match(/\/sales\/lists\/people\/(\d+)/);
  return match ? match[1] : null;
}

function extractSavedSearchId(url: string): string | null {
  const match = url.match(/[?&]savedSearchId=(\d+)/);
  return match ? match[1] : null;
}

function urnToSalesNavUrl(urn: string): string {
  const match = urn.match(/\(([^)]+)\)/);
  if (!match) return "";
  return `https://www.linkedin.com/sales/lead/${match[1]}`;
}

function profileToResult(el: SalesProfile, linkedinUrl: string | null): ScrapedProfile {
  const currentPos = el.currentPositions?.find((p) => p.current) ?? el.currentPositions?.[0];
  const company = currentPos?.companyUrnResolutionResult ?? null;

  // Tenure in months at current position
  let tenureMonths: number | null = null;
  const t = currentPos?.tenureAtPosition;
  if (t) tenureMonths = (t.numYears ?? 0) * 12 + (t.numMonths ?? 0);

  // Spotlight badge labels as a compact JSON array e.g. ["Changed jobs", "Mentioned in news"]
  const badges = (el.spotlightBadges ?? [])
    .map((b) => b.displayValue)
    .filter(Boolean) as string[];

  return {
    salesNavUrn: el.entityUrn,
    salesNavUrl: urnToSalesNavUrl(el.entityUrn),
    linkedinUrl,
    fullName: el.fullName ?? null,
    firstName: el.firstName ?? null,
    lastName: el.lastName ?? null,
    title: currentPos?.title ?? null,
    company: el.leadAssociatedAccount?.name ?? company?.name ?? currentPos?.companyName ?? null,
    location: el.geoRegion ?? null,
    degree: el.degree ?? null,
    objectUrn: el.objectUrn ?? null,
    summary: el.summary ?? null,
    openLink: el.openLink ?? false,
    companyIndustry: company?.industry ?? null,
    companyLocation: company?.location ?? null,
    tenureMonths,
    spotlightBadges: badges.length > 0 ? JSON.stringify(badges) : null,
  };
}

export interface ImportProgress {
  phase: 'scraping' | 'enriching' | 'visiting';
  page?: number;
  totalPages?: number;
  count: number;
  total: number;
}

export interface ScrapeOptions {
  /** 1-based page to begin this window at (for batched imports). Default 1. */
  startPage?: number;
  /** Max pages to fetch in THIS window, starting at startPage. Default 50. */
  maxPages?: number;
  onProgress?: (p: ImportProgress) => void;
  /** Polled between pages; return true to stop early (cancel / deleted list). */
  isCanceled?: () => boolean | Promise<boolean>;
  /** Called once per verified page (including the first), with that page's deduped profiles. */
  onPage?: (pageNum: number, profiles: ScrapedProfile[]) => void | Promise<void>;
}

export interface WindowedScrapeResult {
  profiles: ScrapedProfile[];
  /** Last page actually fetched in this window. */
  lastPage: number;
  /** Total profiles available in the whole search. */
  knownTotal: number;
  /** True if this window reached the end of the search (nothing left to batch). */
  exhausted: boolean;
  /** Set when a page's intercept returned nothing (even after retry) — the window ended early without advancing lastPage. */
  stalled?: { page: number; reason: string };
}

export async function scrapeNavigatorList(
  owner: BrowserOwner,
  salesNavUrl: string,
  opts: ScrapeOptions = {}
): Promise<WindowedScrapeResult> {
  const { startPage = 1, maxPages = 50, onProgress, isCanceled, onPage } = opts;
  const listId = extractListId(salesNavUrl);
  if (!listId) throw new Error(`Invalid Sales Navigator URL: ${salesNavUrl}`);

  const allElements: SalesProfile[] = [];
  const seen = new Set<string>();
  const PAGE_SIZE = 25;
  const buildUrl = (n: number) =>
    `https://www.linkedin.com/sales/lists/people/${listId}?${n > 1 ? `page=${n}&` : ""}sortCriteria=CREATED_TIME&sortOrder=DESCENDING`;

  const page = await owner.newPage();
  let knownTotal = 0;
  let intercepted: FlatResponse | null = null;
  let stalled: { page: number; reason: string } | undefined;

  const waitForIntercept = async (url: string, waitMs: number): Promise<FlatResponse | null> => {
    intercepted = null;
    page.removeAllListeners("response");
    page.on("response", async (response) => {
      if (intercepted) return;
      if (response.url().includes("salesApiPeopleSearch") && response.status() === 200) {
        try { intercepted = await response.json() as FlatResponse; } catch { /* ignore */ }
      }
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(waitMs);
    return intercepted;
  };

  // First page of the window
  const firstData = await waitForIntercept(buildUrl(startPage), 15000);
  if (!firstData) {
    const finalUrl = page.url();
    console.error(`[scraper] no intercept after 15s. Final URL: ${finalUrl}`);
    await page.close();
    throw new Error("No data intercepted from Sales Nav — session may need re-authentication");
  }

  knownTotal = firstData.paging?.total ?? 0;
  const firstPageProfiles: SalesProfile[] = [];
  for (const el of firstData.elements ?? []) {
    if (!el.entityUrn || seen.has(el.entityUrn)) continue;
    seen.add(el.entityUrn);
    allElements.push(el);
    firstPageProfiles.push(el);
  }
  console.log(`[scraper] page ${startPage}: ${allElements.length} elements, total=${knownTotal}`);
  await onPage?.(startPage, firstPageProfiles.map(el => profileToResult(el, null)));

  const totalPages = Math.ceil(knownTotal / PAGE_SIZE);
  const endPage = Math.min(totalPages, startPage + maxPages - 1);
  let lastPage = startPage;
  onProgress?.({ phase: 'scraping', page: startPage, totalPages: endPage, count: allElements.length, total: knownTotal });

  for (let pageNum = startPage + 1; pageNum <= endPage; pageNum++) {
    if (owner.signal.aborted) break;
    if (isCanceled && (await isCanceled())) break;
    const delayMs = 60000 + Math.random() * 60000;
    console.log(`[scraper] waiting ${Math.round(delayMs / 1000)}s before page ${pageNum}...`);
    await page.waitForTimeout(delayMs);
    if (owner.signal.aborted) break;
    if (isCanceled && (await isCanceled())) break;

    let pageData = await waitForIntercept(buildUrl(pageNum), 15000);
    if (!pageData || (pageData.elements?.length ?? 0) === 0) {
      console.log(`[scraper] page ${pageNum} empty on first try — retrying with 15s wait`);
      pageData = await waitForIntercept(buildUrl(pageNum), 15000);
    }
    if (!pageData || (pageData.elements?.length ?? 0) === 0) {
      stalled = { page: pageNum, reason: "no data intercepted after retry" };
      console.warn(`[scraper] page ${pageNum} still empty after retry — ending window at verified page ${lastPage}`);
      break;
    }
    const pagePageProfiles: SalesProfile[] = [];
    for (const el of pageData.elements ?? []) {
      if (!el.entityUrn || seen.has(el.entityUrn)) continue;
      seen.add(el.entityUrn);
      allElements.push(el);
      pagePageProfiles.push(el);
    }
    console.log(`[scraper] page ${pageNum}/${endPage}: ${allElements.length} (total ${knownTotal})`);
    await onPage?.(pageNum, pagePageProfiles.map(el => profileToResult(el, null)));
    lastPage = pageNum;
    onProgress?.({ phase: 'scraping', page: pageNum, totalPages: endPage, count: allElements.length, total: knownTotal });
  }

  await page.close();
  return {
    profiles: allElements.map(el => profileToResult(el, null)),
    lastPage,
    knownTotal,
    exhausted: !stalled && lastPage >= totalPages,
    ...(stalled ? { stalled } : {}),
  };
}

export async function scrapeSavedSearch(
  owner: BrowserOwner,
  savedSearchUrl: string,
  opts: ScrapeOptions = {}
): Promise<WindowedScrapeResult> {
  const { startPage = 1, maxPages = 50, onProgress, isCanceled, onPage } = opts;
  const savedSearchId = extractSavedSearchId(savedSearchUrl);
  if (!savedSearchId) throw new Error(`Invalid Sales Navigator saved search URL: ${savedSearchUrl}`);

  const allElements: SalesProfile[] = [];
  const seen = new Set<string>();
  const PAGE_SIZE = 25;
  const buildUrl = (n: number) =>
    `https://www.linkedin.com/sales/search/people?savedSearchId=${savedSearchId}${n > 1 ? `&page=${n}` : ""}`;

  const page = await owner.newPage();
  let knownTotal = 0;
  let stalled: { page: number; reason: string } | undefined;

  const waitForIntercept = async (url: string, waitMs: number): Promise<FlatResponse | null> => {
    let intercepted: FlatResponse | null = null;
    page.removeAllListeners("response");
    page.on("response", async (response) => {
      if (intercepted) return;
      if (response.url().includes("salesApiLeadSearch") && response.status() === 200) {
        try { intercepted = await response.json() as FlatResponse; } catch { /* ignore */ }
      }
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(waitMs);
    return intercepted;
  };

  // First page of the window
  const firstData = await waitForIntercept(buildUrl(startPage), 15000);
  if (!firstData) {
    await page.close();
    throw new Error("No data intercepted from saved search — session may need re-authentication");
  }

  knownTotal = firstData.paging?.total ?? 0;
  const firstPageProfiles: SalesProfile[] = [];
  for (const el of firstData.elements ?? []) {
    if (!el.entityUrn || seen.has(el.entityUrn)) continue;
    seen.add(el.entityUrn);
    allElements.push(el);
    firstPageProfiles.push(el);
  }
  console.log(`[scraper:saved-search] page ${startPage}: ${allElements.length} elements, total=${knownTotal}`);
  await onPage?.(startPage, firstPageProfiles.map(el => profileToResult(el, null)));

  const totalPages = Math.ceil(knownTotal / PAGE_SIZE);
  const endPage = Math.min(totalPages, startPage + maxPages - 1);
  let lastPage = startPage;
  onProgress?.({ phase: 'scraping', page: startPage, totalPages: endPage, count: allElements.length, total: knownTotal });

  for (let pageNum = startPage + 1; pageNum <= endPage; pageNum++) {
    if (owner.signal.aborted) break;
    if (isCanceled && (await isCanceled())) break;
    const delayMs = 60000 + Math.random() * 60000;
    console.log(`[scraper:saved-search] waiting ${Math.round(delayMs / 1000)}s before page ${pageNum}...`);
    await page.waitForTimeout(delayMs);
    if (owner.signal.aborted) break;
    if (isCanceled && (await isCanceled())) break;

    let pageData = await waitForIntercept(buildUrl(pageNum), 15000);
    if (!pageData || (pageData.elements?.length ?? 0) === 0) {
      console.log(`[scraper:saved-search] page ${pageNum} empty on first try — retrying with 15s wait`);
      pageData = await waitForIntercept(buildUrl(pageNum), 15000);
    }
    if (!pageData || (pageData.elements?.length ?? 0) === 0) {
      stalled = { page: pageNum, reason: "no data intercepted after retry" };
      console.warn(`[scraper:saved-search] page ${pageNum} still empty after retry — ending window at verified page ${lastPage}`);
      break;
    }
    const pagePageProfiles: SalesProfile[] = [];
    for (const el of pageData.elements ?? []) {
      if (!el.entityUrn || seen.has(el.entityUrn)) continue;
      seen.add(el.entityUrn);
      allElements.push(el);
      pagePageProfiles.push(el);
    }
    console.log(`[scraper:saved-search] page ${pageNum}/${endPage}: ${allElements.length} (total ${knownTotal})`);
    await onPage?.(pageNum, pagePageProfiles.map(el => profileToResult(el, null)));
    lastPage = pageNum;
    onProgress?.({ phase: 'scraping', page: pageNum, totalPages: endPage, count: allElements.length, total: knownTotal });
  }

  await page.close();
  return {
    profiles: allElements.map(el => profileToResult(el, null)),
    lastPage,
    knownTotal,
    exhausted: !stalled && lastPage >= totalPages,
    ...(stalled ? { stalled } : {}),
  };
}

/**
 * Dispatcher — accepts either a lead list URL or a saved search URL.
 * Callers don't need to know which type they're dealing with.
 */
export async function scrapeNavigatorUrl(
  owner: BrowserOwner,
  url: string,
  opts: ScrapeOptions = {}
): Promise<WindowedScrapeResult> {
  if (extractSavedSearchId(url)) {
    return scrapeSavedSearch(owner, url, opts);
  }
  if (extractListId(url)) {
    return scrapeNavigatorList(owner, url, opts);
  }
  throw new Error(`Unrecognized Sales Navigator URL. Expected a list URL (/sales/lists/people/...) or saved search URL (?savedSearchId=...)`);
}
