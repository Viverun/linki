/**
 * Browser-level drill: the two things only a real browser can settle.
 *
 *   - PR-18 — the dismissal lifecycle, exercised through the component's actual
 *     hooks, sessionStorage and re-render, not through the pure functions alone.
 *   - PR-15 — a mutation that fails in the browser (HTML 500, aborted request)
 *     must leave truthful UI state and no success toast.
 *
 * Not part of `npm test`: the isolated gate has no browser (the verification
 * image sets PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD and carries no chromium), so this
 * is host-only evidence, run deliberately. Treat a pass as "this engine, this
 * build"; it is not a cross-browser matrix.
 *
 * Run:
 *   node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *        --import ./scripts/test-setup.mjs scripts/ui-browser-drill.mts
 *
 * Requires a completed `npm run build` (it starts `next start`).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser, type Page } from "playwright";

const REPO = join(dirname(new URL(import.meta.url).pathname), "..");
const PASSWORD = "drill-password-not-a-real-credential";
const EMAIL = "drill@linki.invalid";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${detail}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/**
 * `next start` serves `.next` — whatever was built last, which is not
 * necessarily this source tree. Running the drill against a stale or mutated
 * build is the most plausible way for this evidence to be wrong while every
 * check passes, so make it a check rather than a note in the header.
 */
function staleBuildReason(): string | null {
  const buildId = join(REPO, ".next", "BUILD_ID");
  let built: number;
  try {
    built = statSync(buildId).mtimeMs;
  } catch {
    return "no .next/BUILD_ID — run `npm run build` first";
  }

  const newer: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(REPO, rel), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.(ts|tsx|js|jsx|css|json)$/.test(entry.name) && statSync(join(REPO, child)).mtimeMs > built) {
        newer.push(child);
      }
    }
  };
  for (const dir of ["pages", "components", "lib", "styles"]) {
    try {
      walk(dir);
    } catch {
      /* directory may not exist in every checkout */
    }
  }
  if (newer.length === 0) return null;
  return `${newer.length} source file(s) newer than the build, e.g. ${newer.slice(0, 3).join(", ")}`;
}

const dir = mkdtempSync(join(tmpdir(), "linki-ui-drill-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

process.env.LINKI_DB_PATH = join(dir, "drill.db");
process.env.NEXTAUTH_SECRET = "ui-drill-secret-not-for-production";
process.env.NEXTAUTH_URL = base;

const { getDb } = await import("@/lib/db");
const bcrypt = (await import("bcryptjs")).default;

const db = getDb();
db.prepare("INSERT INTO users (id, email, password_hash, session_version) VALUES (?, ?, ?, 0)").run(
  "drill-user",
  EMAIL,
  bcrypt.hashSync(PASSWORD, 10)
);

const server = spawn(process.execPath, [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)], {
  cwd: REPO,
  env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

let browser: Browser | undefined;

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/login`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  throw new Error(`next start did not answer in 60s:\n${serverLog}`);
}

// ── synthetic health payloads, shaped exactly as /api/health emits them ──────
type HealthMode = "healthy" | "degraded" | "dead";
const HEALTH: Record<HealthMode, { status: number; body: unknown }> = {
  healthy: {
    status: 200,
    body: { ok: true, health_schema: 1, restart_will_help: false, runner: { state: "running", consecutive_tick_failures: 0 } },
  },
  degraded: {
    status: 200,
    body: {
      ok: true,
      health_schema: 1,
      restart_will_help: false,
      runner: { state: "degraded", consecutive_tick_failures: 6, last_error_class: "TypeError" },
    },
  },
  dead: {
    status: 503,
    body: { ok: false, health_schema: 1, restart_will_help: true, runner: { state: "dead", consecutive_tick_failures: 0 } },
  },
};

const BANNER = '[role="status"]';
const HEALTH_API = "**/api/health";
const LISTS_API = "**/api/lists**";
const DISMISS = 'button[aria-label="Dismiss this notice for this session"]';

async function newPage(opts: { storageThrows?: boolean } = {}): Promise<Page> {
  const context = await browser!.newContext();
  if (opts.storageThrows) {
    // Private-mode-like: the property exists but every access throws, which is
    // what the component's readDismissed/writeDismissed catch.
    await context.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        get() {
          throw new DOMException("storage disabled for drill", "SecurityError");
        },
      });
    });
  }
  const page = await context.newPage();
  // Sonner toasts are transient (a few seconds), so a single `count()` after the
  // fact can miss one entirely — which is how "no success toast" passed on a
  // build that *did* claim success. Record every toast that is ever added and
  // assert over the log.
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __toastLog: string[] }).__toastLog = log;
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of Array.from(m.addedNodes)) {
          if (node.nodeType !== 1) continue;
          const el = node as Element;
          const toast = el.matches("[data-sonner-toast]") ? el : el.querySelector("[data-sonner-toast]");
          if (toast) log.push((toast.textContent ?? "").trim());
        }
      }
    // `document`, not `document.documentElement`: an init script runs before the
    // root element exists, and observing a null target throws — silently, since
    // nothing surfaces init-script exceptions.
    }).observe(document, { childList: true, subtree: true });
  });
  return page;
}

async function login(page: Page) {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 }),
    page.click('button[type="submit"]'),
  ]);
}

/**
 * Route /api/health to a synthetic payload, then load an authenticated page.
 *
 * `expectBanner` defaults to "anything that is not healthy shows a banner", and
 * an expectation of ABSENCE still waits for the poll to have been answered —
 * otherwise the assertion passes because the banner has not rendered yet, which
 * is the classic way a "stays dismissed" check proves nothing.
 */
async function observe(
  page: Page,
  mode: HealthMode,
  opts: { path?: string; expectBanner?: boolean } = {}
) {
  const expectBanner = opts.expectBanner ?? mode !== "healthy";

  await page.unroute(HEALTH_API).catch(() => {});
  await page.route(HEALTH_API, (route) =>
    route.fulfill({
      status: HEALTH[mode].status,
      contentType: "application/json",
      body: JSON.stringify(HEALTH[mode].body),
    })
  );

  const polled = page.waitForResponse((r) => r.url().includes("/api/health"), { timeout: 20_000 });
  await page.goto(`${base}${opts.path ?? "/"}`, { waitUntil: "domcontentloaded" });
  const response = await polled;
  // The component awaits res.json() and then setBanner; give React that turn
  // before asserting anything about the DOM.
  await page.waitForTimeout(250);

  if (expectBanner) {
    await page.waitForSelector(BANNER, { timeout: 15_000 });
  } else if (await bannerVisible(page)) {
    throw new Error(`expected no banner for "${mode}", but one is visible (health ${response.status()})`);
  }
}

const bannerVisible = (page: Page) => page.locator(BANNER).isVisible().catch(() => false);
const toasts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __toastLog?: string[] }).__toastLog ?? []);
const storedKey = (page: Page) =>
  page.evaluate(() => {
    try {
      return window.sessionStorage.getItem("linki:health-banner-dismissed");
    } catch {
      return "THREW";
    }
  });

try {
  // A thrown expectation (a timeout waiting for a banner that should be
  // there) is a failed check, not a crashed script: record it, keep the
  // summary meaningful, and let the cleanup below still run.
  try {
    const stale = staleBuildReason();
    check("the drill runs a build of the current source tree", stale === null, stale ?? "");

    await waitForServer();
    // Playwright's bundled chromium revision is not the one in this host's cache,
    // and downloading a browser is not something an evidence run should do
    // implicitly. Prefer the installed Chrome (what an operator actually uses) and
    // fall back to the bundled build when it is present.
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
      console.log(`  engine: system Chrome ${browser.version()}`);
    } catch (err) {
      browser = await chromium.launch({ headless: true });
      console.log(`  engine: bundled chromium ${browser.version()} (chrome channel unavailable: ${(err as Error).message.split("\n")[0]})`);
    }

    // ── PR-18: the acceptance scenario, in a real browser ─────────────────────
    {
      const page = await newPage();
      await login(page);

      await observe(page, "dead");
      check("PR-18 dead runner shows the banner", await bannerVisible(page));
      check("PR-18 dismissal writes sessionStorage", (await storedKey(page)) === null, "before dismissing");

      await page.click(DISMISS);
      await page.waitForSelector(BANNER, { state: "detached", timeout: 10_000 });
      check("PR-18 dismiss hides the banner", !(await bannerVisible(page)));
      check("PR-18 dismissal is stored under the incident key", (await storedKey(page)) === "dead");

      await observe(page, "dead", { expectBanner: false });
      check("PR-18 the same incident stays dismissed across a reload", !(await bannerVisible(page)));

      await observe(page, "healthy");
      check("PR-18 recovery clears the stored key", (await storedKey(page)) === null);

      await observe(page, "dead");
      check("PR-18 a NEW incident of the same class is visible again", await bannerVisible(page));

      // Escalation: a dismissed lesser incident must not hide a worse one.
      await page.click(DISMISS).catch(() => {});
      await observe(page, "degraded");
      await page.click(DISMISS);
      await page.waitForSelector(BANNER, { state: "detached", timeout: 10_000 });
      check("PR-18 degraded is dismissed", !(await bannerVisible(page)));
      await observe(page, "dead");
      check("PR-18 escalation stays visible while a lesser incident is dismissed", await bannerVisible(page));

      await page.close();
    }

    // ── PR-18: storage disabled must fail toward visibility ───────────────────
    {
      const page = await newPage({ storageThrows: true });
      await login(page);

      await observe(page, "dead");
      check("PR-18 storage disabled: banner is still shown", await bannerVisible(page));
      await page.click(DISMISS);
      await page.waitForSelector(BANNER, { state: "detached", timeout: 10_000 });
      check("PR-18 storage disabled: dismiss still applies to this incident", !(await bannerVisible(page)));

      await observe(page, "dead");
      check("PR-18 storage disabled: reload shows the banner again", await bannerVisible(page));

      await page.close();
    }

    // ── PR-15: a failed mutation must not claim success ───────────────────────
    //
    // The lists page's create flow goes through `mutateFetch` in
    // `lib/ui-mutation.ts`. The POST is intercepted and answered with the shapes a
    // proxy or a dead connection actually produce: an HTML 500 body (which is NOT
    // JSON, the case that used to throw out of the error branch) and an aborted
    // request (`status: 0`).
    //
    // What is asserted is the operator-visible outcome, not an internal: the row
    // count does not grow, the dialog stays open, the URL does not move, no
    // success toast appears, and the error toast does.
    //
    // The third case is the one that needed code: a request the SERVER APPLIED
    // whose response never arrives. The client cannot know the list exists, so it
    // must not claim failure — it reads the collection back and reports what it
    // finds, which is also why nothing here re-sends the POST.
    {
      const page = await newPage();
      await login(page);

      // Positive control first. Every assertion below is of the form "nothing
      // happened", which a page whose create flow is simply broken would satisfy
      // perfectly. So: the same flow, against the real server, must create a list
      // and survive a reload. The failure cases then start from a non-empty table.
      {
        await page.goto(`${base}/lists`, { waitUntil: "domcontentloaded" });
        const createButton = page.getByRole("button", { name: /new list/i });
        await createButton.first().waitFor({ state: "visible", timeout: 20_000 });
        const modal = page.locator(".modal-box");
        const rowsBefore = await page.locator("table tbody tr").count();

        await createButton.click();
        await modal.locator("input").first().fill("drill-control");
        await modal.locator('button[type="submit"]').click();

        const successToast = page.getByText("List created", { exact: true });
        check(
          "PR-15 control: a real create reports success",
          await successToast.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false)
        );
        check("PR-15 control: the dialog closes on success", !(await modal.isVisible()));
        // Proves the recorder below is actually recording: a toast has to be seen
        // for "no success toast" to mean anything.
        check(
          "PR-15 control: the success toast was observed",
          (await toasts(page)).some((t) => /list created/i.test(t)),
          JSON.stringify(await toasts(page))
        );
        check(
          "PR-15 control: the new row is rendered",
          (await page.locator("table tbody tr").count()) === rowsBefore + 1
        );

        await page.reload({ waitUntil: "domcontentloaded" });
        const stored = page.getByText("drill-control", { exact: true });
        check(
          "PR-15 control: the list exists on the server after a reload",
          await stored.first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false)
        );
      }

      for (const failure of ["html-500", "abort"] as const) {
        await page.unroute(LISTS_API).catch(() => {});
        await page.route(LISTS_API, (route) => {
          // Reads must still work: the page has to render its real table for the
          // row-count comparison to mean anything.
          if (route.request().method() !== "POST") return route.continue();
          if (failure === "html-500") {
            return route.fulfill({ status: 500, contentType: "text/html", body: "<html><body>Bad gateway</body></html>" });
          }
          return route.abort("failed");
        });

        await page.goto(`${base}/lists`, { waitUntil: "domcontentloaded" });
        const rows = page.locator("table tbody tr");

        // Wait for the control rather than counting it: `/lists` is streamed, so a
        // `count()` right after domcontentloaded can legitimately be 0 while the
        // button appears a few milliseconds later. Counting is how this check
        // silently stopped testing anything.
        const createButton = page.getByRole("button", { name: /new list/i });
        const found = await createButton
          .first()
          .waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        if (!found) {
          const buttons = (await page.locator("button").allTextContents()).map((t) => t.trim()).filter(Boolean);
          check(
            `PR-15 ${failure}: found a mutation control on /lists`,
            false,
            `no control matched at ${page.url()} — buttons: ${JSON.stringify(buttons.slice(0, 12))}`
          );
          continue;
        }

        const listName = `drill-${failure}`;
        const before = await rows.count();
        check(`PR-15 ${failure}: the comparison starts from a real row`, before >= 1, `${before} rows`);
        await createButton.click();
        // daisyUI renders the dialog as `.modal-box`, not `[role=dialog]`.
        const modal = page.locator(".modal-box");
        await modal.locator("input").first().fill(listName);
        await modal.locator('button[type="submit"]').click();

        // The message is the reconciled one: "could not reach the server" would be
        // an unverified claim about a request whose response was lost, and this
        // case is a 5xx or a dropped connection, so the client looks first.
        const errorToast = page.getByText("List not created — the server has no list with that name", {
          exact: true,
        });
        const toldTheTruth = await errorToast
          .waitFor({ timeout: 15_000 })
          .then(() => true)
          .catch(() => false);

        const log = await toasts(page);
        check(`PR-15 ${failure}: the failure is reported to the operator`, toldTheTruth, JSON.stringify(log));
        check(
          `PR-15 ${failure}: no success toast for a failed mutation`,
          !log.some((t) => /^list created/i.test(t)),
          JSON.stringify(log)
        );
        check(`PR-15 ${failure}: the dialog stays open (nothing was created)`, await modal.isVisible());
        check(`PR-15 ${failure}: the page did not navigate as if it worked`, new URL(page.url()).pathname === "/lists", page.url());

        await page.waitForTimeout(500);
        check(
          `PR-15 ${failure}: no row was added locally`,
          (await rows.count()) === before,
          `${before} before, ${await rows.count()} after`
        );

        // The server is the tie-breaker: a reload must not reveal a list the UI
        // pretended not to create (and, symmetrically, must not have lost one).
        await page.unroute(LISTS_API).catch(() => {});
        await page.reload({ waitUntil: "domcontentloaded" });
        check(
          `PR-15 ${failure}: the database has no such list after a reload`,
          (await page.getByText(listName, { exact: true }).count()) === 0
        );
      }

      // ── PR-15: the server applied it, the response never arrived ───────────
      //
      // `route.fetch()` performs the real POST — the list IS created — and then
      // drops the response, which is what a proxy timeout or a dying connection
      // looks like to the browser. The client must not report failure (the list
      // exists) and must not retry (a second list would be created): it reads the
      // collection back and says what it found.
      {
        const name = "drill-lost-response";
        await page.unroute(LISTS_API).catch(() => {});
        await page.route(LISTS_API, async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          await route.fetch();
          await route.abort("failed");
        });

        await page.goto(`${base}/lists`, { waitUntil: "domcontentloaded" });
        const rows = page.locator("table tbody tr");
        const createButton = page.getByRole("button", { name: /new list/i });
        await createButton.first().waitFor({ state: "visible", timeout: 20_000 });
        const before = await rows.count();

        await createButton.click();
        const modal = page.locator(".modal-box");
        await modal.locator("input").first().fill(name);
        await modal.locator('button[type="submit"]').click();

        const confirmed = page.getByText(/List created \(confirmed after a lost response\)/);
        check(
          "PR-15 lost response: the client verifies instead of claiming failure",
          await confirmed.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false),
          JSON.stringify(await toasts(page))
        );
        check("PR-15 lost response: the dialog closes only once the server confirms", !(await modal.isVisible()));
        await page.waitForTimeout(500);
        check(
          "PR-15 lost response: exactly one row was added (nothing re-sent the POST)",
          (await rows.count()) === before + 1,
          `${before} before, ${await rows.count()} after`
        );

        await page.unroute(LISTS_API).catch(() => {});
        await page.reload({ waitUntil: "domcontentloaded" });
        // Same trap as the "found a mutation control" check, in a new place: a
        // count() straight after a navigation on a streamed page can be 0 because
        // the row has not rendered yet. Wait for it, then count.
        const row = page.getByText(name, { exact: true });
        await row.first().waitFor({ timeout: 15_000 }).catch(() => {});
        const persisted = await row.count();
        check(
          "PR-15 lost response: the server holds exactly one such list",
          persisted === 1,
          `${persisted} matching row(s)`
        );
      }

      // ── PR-15: the same ambiguity on another page ──────────────────────────
      //
      // One page's create flow could be a special case in the page rather than a
      // property of the boundary. The companies page shares nothing with /lists
      // but the boundary, so repeating the lost-response case here is what makes
      // the claim "the pattern generalises" rather than "one page was patched".
      {
        const name = "drill-lost-company";
        const companiesApi = "**/api/companies**";
        await page.route(companiesApi, async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          await route.fetch();
          await route.abort("failed");
        });

        await page.goto(`${base}/companies`, { waitUntil: "domcontentloaded" });
        const addButton = page.getByRole("button", { name: /add company/i });
        const found = await addButton
          .first()
          .waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        check("PR-15 companies: the create control is present", found);

        if (found) {
          await addButton.click();
          const modal = page.locator(".modal-box");
          await modal.locator("input").first().fill(name);
          await modal.locator('button[type="submit"]').click();

          check(
            "PR-15 companies: a lost response is confirmed, not reported as failure",
            await page
              .getByText(/Company created \(confirmed after a lost response\)/)
              .waitFor({ timeout: 20_000 })
              .then(() => true)
              .catch(() => false),
            JSON.stringify(await toasts(page))
          );
          check("PR-15 companies: the dialog closes only once the server confirms", !(await modal.isVisible()));

          await page.unroute(companiesApi).catch(() => {});
          await page.reload({ waitUntil: "domcontentloaded" });
          const row = page.getByText(name, { exact: true });
          await row.first().waitFor({ timeout: 15_000 }).catch(() => {});
          check(
            "PR-15 companies: exactly one company was created",
            (await row.count()) === 1,
            `${await row.count()} matching row(s)`
          );
        }
      }

      // ── PR-15: a create that navigates, with the response lost ─────────────
      //
      // The campaigns page is the third surface and the hardest of the three:
      // its success path NAVIGATES to the new campaign, so an ambiguous outcome
      // that is merely reported as failure leaves the operator on a list that
      // says the campaign does not exist — while it does. The reconciliation has
      // to find the campaign and continue, not stop.
      {
        const name = "drill-lost-campaign";
        const workflowsApi = "**/api/workflows**";
        await page.route(workflowsApi, async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          await route.fetch();
          await route.abort("failed");
        });

        await page.goto(`${base}/workflows`, { waitUntil: "domcontentloaded" });
        const newButton = page.getByRole("button", { name: /new campaign/i });
        const found = await newButton
          .first()
          .waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        check("PR-15 campaigns: the create control is present", found);

        if (found) {
          await newButton.click();
          const modal = page.locator(".modal-box");
          await modal.locator("input").first().fill(name);
          await modal.locator('button[type="submit"]').click();

          const navigated = await page
            .waitForURL((u) => /^\/workflows\/[^/]+$/.test(u.pathname), { timeout: 20_000 })
            .then(() => true)
            .catch(() => false);
          check(
            "PR-15 campaigns: a lost response still lands on the campaign that exists",
            navigated,
            `${page.url()} ${JSON.stringify(await toasts(page))}`
          );

          await page.unroute(workflowsApi).catch(() => {});

          // ── PR-15: the same ambiguity on the campaign detail page ────────
          //
          // The detail page's writes are a different shape again: a rename
          // changes a single field on a row the page is already showing, and the
          // old code discarded the response entirely — a refused rename closed
          // the editor and said nothing. The lost-response case must end with
          // the page showing the new name, not with a silent reversion.
          const renamedName = `${name}-renamed`;
          const workflowPut = "**/api/workflows/*";
          await page.route(workflowPut, async (route) => {
            if (route.request().method() !== "PUT") return route.continue();
            await route.fetch();
            await route.abort("failed");
          });

          const renameButton = page.locator('button[title="Click to rename"]');
          const canRename = await renameButton
            .first()
            .waitFor({ state: "visible", timeout: 20_000 })
            .then(() => true)
            .catch(() => false);
          check("PR-15 detail: the rename control is present", canRename);

          if (canRename) {
            await renameButton.first().click();
            const renameInput = page.locator("input.input-xs").first();
            await renameInput.waitFor({ state: "visible", timeout: 10_000 });
            await renameInput.fill(renamedName);
            await renameInput.press("Enter");

            check(
              "PR-15 detail: a lost rename is confirmed, not reported as failure",
              await page
                .getByText(/Renamed \(confirmed after a lost response\)/)
                .first()
                .waitFor({ timeout: 20_000 })
                .then(() => true)
                .catch(() => false),
              JSON.stringify(await toasts(page))
            );
          }

          await page.unroute(workflowPut).catch(() => {});
          await page.goto(`${base}/workflows`, { waitUntil: "domcontentloaded" });
          const row = page.getByText(canRename ? renamedName : name, { exact: true });
          await row.first().waitFor({ timeout: 15_000 }).catch(() => {});
          check(
            "PR-15 campaigns: exactly one campaign was created",
            (await row.count()) === 1,
            `${await row.count()} matching row(s)`
          );
          check(
            "PR-15 detail: the lost-response rename survived a reload",
            (await page.getByText(name, { exact: true }).count()) === 0,
            `old name still present: ${JSON.stringify(await toasts(page))}`
          );
        }
      }

      await page.close();
    }
  } catch (err) {
    check("the drill ran to completion", false, err instanceof Error ? err.message.split("\n")[0] : String(err));
  }
} finally {
  await browser?.close().catch(() => {});
  server.kill("SIGTERM");
  await sleep(300);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error(`UI DRILL FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}
console.log("UI DRILL PASSED\n");
