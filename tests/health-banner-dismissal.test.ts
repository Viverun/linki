import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bannerFromHealth,
  isDismissedBanner,
  nextDismissedKey,
  type BannerState,
} from "@/lib/health-contract";
import { codeOnly } from "./support/source-text";

/**
 * PR-18 (C4) — alert dismissal.
 *
 * Acceptance: dismiss an outage, observe recovery, then trigger a new outage of
 * the same class in the same tab — the new incident becomes visible. Escalation
 * and network failure remain visible; storage-disabled behaviour and session
 * lifetime are explicit.
 *
 * The dismissal rule lives in `lib/health-contract.ts` as pure functions,
 * following that module's existing convention: this project has no component
 * test tooling, so the decision worth testing is kept outside the React wiring
 * instead of being exercised through it. `session()` below is the component's
 * poll loop minus React — compute a banner, reconcile the dismissal, decide
 * whether it renders.
 */

type Observation = { ok: boolean; body: unknown } | null;

const healthy: Observation = {
  ok: true,
  body: { ok: true, health_schema: 1, restart_will_help: false, runner: { state: "running", consecutive_tick_failures: 0 } },
};

const dead: Observation = {
  ok: false,
  body: { ok: false, restart_will_help: true, runner: { state: "dead", consecutive_tick_failures: 0 } },
};

const degraded = (failures: number, lastErrorClass: string): Observation => ({
  ok: true,
  body: { ok: true, runner: { state: "degraded", consecutive_tick_failures: failures, last_error_class: lastErrorClass } },
});

const unhealthy = (reason: string): Observation => ({
  ok: false,
  body: { ok: false, restart_will_help: false, reason },
});

/** The network is down / the response is unreadable. */
const unreachable: Observation = null;

interface Step {
  banner: BannerState;
  visible: boolean;
  dismissed: string | null;
}

/**
 * One mounted banner, driven by observations.
 *
 * `stored` models sessionStorage: a dismissal written by `dismiss()` is visible
 * to a later mount, which is what "session lifetime" means here. Passing
 * `storageWorks: false` models private mode / disabled storage, where the key
 * survives only as long as this instance does.
 */
function session(opts: { stored?: string | null; storageWorks?: boolean } = {}) {
  const storageWorks = opts.storageWorks ?? true;
  let dismissed: string | null = opts.stored ?? null;
  const storedAtMount = dismissed;

  return {
    storedAtMount,
    observe(input: Observation): Step {
      const banner = bannerFromHealth(input);
      dismissed = nextDismissedKey(dismissed, banner);
      return { banner, visible: banner.severity !== "none" && !isDismissedBanner(dismissed, banner), dismissed };
    },
    dismiss(input: Observation): Step {
      const banner = bannerFromHealth(input);
      assert.equal(banner.severity === "none", false, "nothing to dismiss in a healthy observation");
      dismissed = banner.key;
      void storageWorks; // storage only decides whether the key outlives this instance
      return { banner, visible: false, dismissed };
    },
    get dismissed() {
      return dismissed;
    },
  };
}

// ─── the acceptance scenario ─────────────────────────────────────────────────

test("dismiss an outage, recover, then the same outage again is visible", () => {
  const s = session();

  const first = s.observe(dead);
  assert.equal(first.visible, true, "an incident is visible before it is dismissed");

  const dismissed = s.dismiss(dead);
  assert.equal(dismissed.visible, false);
  assert.equal(s.observe(dead).visible, false, "the same incident stays dismissed while it persists");

  const recovery = s.observe(healthy);
  assert.equal(recovery.banner.severity, "none");
  assert.equal(recovery.dismissed, null, "recovery ends the incident the dismissal referred to");

  const second = s.observe(dead);
  assert.equal(second.visible, true, "the new incident must not be silenced by the old dismissal");
});

test("the identical key is not enough to keep a new incident hidden", () => {
  // Guards the specific regression: same class, same key, different incident.
  const s = session();
  s.dismiss(dead);
  assert.equal(bannerFromHealth(dead).key, bannerFromHealth(dead).key);
  s.observe(healthy);
  assert.equal(s.observe(dead).visible, true);
});

// ─── things that must stay visible regardless ────────────────────────────────

test("escalation stays visible while something lesser is dismissed", () => {
  const s = session();
  s.dismiss(degraded(5, "TypeError"));

  assert.equal(s.observe(degraded(6, "TypeError")).visible, false, "same class, still dismissed");
  assert.equal(s.observe(dead).visible, true, "dead is a different problem and was never dismissed");
});

test("a network failure stays visible while a runner problem is dismissed", () => {
  const s = session();
  s.dismiss(degraded(5, "TypeError"));

  assert.equal(s.observe(unreachable).visible, true, "an unreachable service is not the incident that was dismissed");
});

test("a different failure class is a different incident", () => {
  const s = session();
  s.dismiss(degraded(5, "TypeError"));

  assert.equal(s.observe(degraded(5, "SqliteError")).visible, true);
});

test("a different unhealthy reason is a different incident", () => {
  const s = session();
  s.dismiss(unhealthy("step_side_effects_missing"));

  assert.equal(s.observe(unhealthy("db_unavailable")).visible, true);
});

test("the failure counter ticking up does not un-dismiss", () => {
  // The dismissal is keyed by class on purpose: a persistent incident that keeps
  // failing is the same incident, and re-showing it every tick would train the
  // operator to dismiss without reading.
  const s = session();
  s.dismiss(degraded(5, "TypeError"));

  assert.equal(s.observe(degraded(9, "TypeError")).visible, false);
  assert.equal(s.observe(degraded(40, "TypeError")).visible, false);
});

// ─── session lifetime and storage ────────────────────────────────────────────

test("a dismissal stored earlier in the session still applies after a reload", () => {
  const first = session();
  first.dismiss(dead);
  const stored = first.dismissed;

  const reloaded = session({ stored });
  assert.equal(reloaded.storedAtMount, stored, "sessionStorage, so the key survives a reload in this tab");
  assert.equal(reloaded.observe(dead).visible, false);
});

test("storage disabled: the dismissal covers this incident only", () => {
  // readDismissed() throws -> null, so nothing is stored. The in-memory key must
  // still suppress the incident on screen, and must still end at recovery —
  // otherwise a private-mode user sees either a banner they cannot dismiss or
  // one that never comes back.
  const s = session({ storageWorks: false });

  s.dismiss(dead);
  assert.equal(s.observe(dead).visible, false, "an unpersisted dismissal still applies to this incident");
  s.observe(healthy);
  assert.equal(s.observe(dead).visible, true, "and it still ends when the condition clears");
});

test("a healthy observation never renders a banner, dismissed or not", () => {
  const s = session({ stored: "dead" });
  const step = s.observe(healthy);
  assert.equal(step.banner.severity, "none");
  assert.equal(step.visible, false);
  assert.equal(step.dismissed, null, "a stored key is dropped once the condition is gone");
});

test("an unknown stored value suppresses nothing", () => {
  const s = session({ stored: "degraded:SomethingFromAnOlderBuild" });
  assert.equal(s.observe(dead).visible, true);
});

// ─── the component actually uses the tested rule ─────────────────────────────

/**
 * The decisions above are only authoritative if the component delegates to them.
 * A future edit that compares `dismissedKey === banner.key` inline would restore
 * the exact defect while every test above stayed green, so the wiring is
 * asserted too — on comment-stripped source, since the prose here names the
 * functions.
 */
test("the banner delegates its dismissal decisions to the contract module", () => {
  const src = codeOnly(
    readFileSync(join(import.meta.dirname, "..", "components", "layout", "RunnerHealthBanner.tsx"), "utf8"),
    { strings: false }
  );

  assert.match(src, /isDismissedBanner\(dismissedKey,\s*banner\)/, "render must ask the shared rule");
  assert.match(src, /nextDismissedKey\(dismissedRef\.current,\s*next\)/, "each poll must reconcile the dismissal");
  assert.doesNotMatch(src, /dismissedKey\s*===\s*banner\.key/, "an inline key comparison restores PR-18");
});

test("a dismissal is session-scoped, not persisted across sessions", () => {
  const src = codeOnly(
    readFileSync(join(import.meta.dirname, "..", "components", "layout", "RunnerHealthBanner.tsx"), "utf8"),
    { strings: false }
  );

  assert.match(src, /window\.sessionStorage/, "a dismissal must not outlive the tab");
  assert.doesNotMatch(src, /window\.localStorage/, "localStorage would hide the next outage after a browser restart");
});
