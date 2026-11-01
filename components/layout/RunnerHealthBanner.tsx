import { useCallback, useEffect, useRef, useState } from "react";
import {
  bannerFromHealth,
  isDismissedBanner,
  nextDismissedKey,
  type BannerState,
} from "@/lib/health-contract";

/**
 * Puts the runner's condition in front of a person.
 *
 * P2-2: before this, a runner that failed every tick incremented a counter, set
 * a settings row, and told nobody. `/api/health` reported it faithfully to
 * anyone who asked, and nobody asked. An operator who checks a dashboard only
 * when they already suspect a problem will not discover a silent one.
 *
 * Mounted by Layout BELOW its `/login` early return, so "never poll from the
 * login page" is structural rather than a condition here that a later edit could
 * drop. An unauthenticated poller would also be pointless: /api/health is public
 * (see proxy.ts), but a logged-out visitor can do nothing about the answer.
 */

/** Matches the runner's own cadence closely enough to be current, and is far too
 *  slow to matter for load — the endpoint does two indexed reads and no COUNT. */
const POLL_MS = 60_000;

/** Session-scoped, so a dismissal never outlives the tab. localStorage would let
 *  someone dismiss a banner in March and not see the next outage in June. It is
 *  ALSO cleared when the condition clears (see `nextDismissedKey`), so one
 *  incident cannot silence the next one of the same class. */
const DISMISS_KEY = "linki:health-banner-dismissed";

/**
 * Also the SSR path: `window` is undefined on the server, which throws a
 * ReferenceError straight into this catch. Returning null there is correct — an
 * unknown dismissal state should show the banner, never hide it.
 */
function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null; // SSR, private mode, or storage disabled — show the banner
  }
}

/**
 * Persists the dismissal, or removes it on recovery.
 *
 * When storage is unavailable the write fails silently and the key lives only in
 * component state: the dismissal still applies to the incident in view, but a
 * reload shows the banner again. That is the explicit storage-disabled behaviour
 * — fail toward visibility, never toward an outage nobody can see.
 */
function writeDismissed(key: string | null): void {
  try {
    if (key === null) window.sessionStorage.removeItem(DISMISS_KEY);
    else window.sessionStorage.setItem(DISMISS_KEY, key);
  } catch {
    /* storage unavailable — the in-memory key still covers this incident */
  }
}

export default function RunnerHealthBanner() {
  const [banner, setBanner] = useState<BannerState | null>(null);
  // Read in the initialiser rather than in an effect. Calling setState
  // synchronously from an effect triggers a cascading render (and is a lint
  // error here). No hydration mismatch results: the first render returns null
  // regardless, because `banner` is not populated until the first poll resolves.
  const [dismissedKey, setDismissedKey] = useState<string | null>(readDismissed);
  // Mirrored in a ref so the poll callback can reconcile the dismissal without
  // being re-created (which would restart the interval) and without reading a
  // stale closure.
  const dismissedRef = useRef<string | null>(dismissedKey);

  const applyDismissal = useCallback((next: string | null) => {
    if (dismissedRef.current === next) return;
    dismissedRef.current = next;
    setDismissedKey(next);
    writeDismissed(next);
  }, []);

  const poll = useCallback(async () => {
    let next: BannerState;
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      // `res.ok` is checked rather than assumed: /api/health answers 503 WITH a
      // JSON body, and a proxy in front of a stopped container answers with HTML.
      // `.json()` on the latter throws, and an alerting component that dies
      // silently on the exact failure it exists to report is worse than none.
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      next = bannerFromHealth({ ok: res.ok, body });
    } catch {
      // Network-level failure: the server is unreachable, which is itself the
      // most severe thing this banner reports.
      next = bannerFromHealth(null);
    }
    setBanner(next);
    // PR-18: a dismissal covers one incident. Seeing the condition clear ends
    // it, so the next outage of the same class is shown again. Without this the
    // key — which deliberately identifies the class, not the occurrence — would
    // silence every later incident of that class for the rest of the session.
    applyDismissal(nextDismissedKey(dismissedRef.current, next));
  }, [applyDismissal]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      void poll();
      timer = setInterval(() => { void poll(); }, POLL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    // Paused while the tab is hidden. A backgrounded dashboard left open for a
    // week would otherwise issue ~10,000 requests to say nothing changed, and
    // browsers throttle background timers unpredictably anyway. Polling resumes
    // with an immediate check on return, so the first thing a returning operator
    // sees is current.
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poll]);

  if (!banner || banner.severity === "none") return null;
  if (isDismissedBanner(dismissedKey, banner)) return null;

  const dismiss = () => applyDismissal(banner.key);

  const tone =
    banner.severity === "error"
      ? "bg-error/15 border-error/40 text-error-content"
      : "bg-warning/15 border-warning/40 text-warning-content";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-3 border-b px-4 py-2.5 text-sm ${tone}`}
    >
      <div className="flex-1 min-w-0">
        <span className="font-semibold">{banner.headline}</span>
        <span className="opacity-80"> — {banner.detail}</span>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss this notice for this session"
        className="shrink-0 opacity-60 hover:opacity-100 px-2 leading-none"
      >
        ✕
      </button>
    </div>
  );
}
