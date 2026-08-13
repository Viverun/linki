/**
 * The vocabulary shared by everything that reports on the runner's condition:
 * the runner itself (which decides when to announce a state), `/api/health`
 * (which reports it to the supervisor), and the UI banner (which shows it to a
 * person).
 *
 * This module is a LEAF ON PURPOSE. It imports nothing, and nothing added here
 * may import anything either.
 *
 * The first attempt put `DEGRADED_AFTER_FAILURES` in `lib/linkedin/runner.ts`
 * and had `pages/api/health.ts` import it. That is a worse bug than the
 * duplication it removed: runner.ts pulls in playwright, apollo, nodemailer and
 * the crypto helpers at module scope, so an import-time throw anywhere in that
 * graph would make /api/health return 500. The supervisor reads that as
 * "unhealthy" and restarts — and a restart cannot fix a module that fails to
 * load, so the restart budget burns down against something it can never repair.
 *
 * The endpoint that decides whether to restart must not depend on the subsystem
 * being judged.
 */

/**
 * Consecutive failed ticks before the runner is called degraded.
 *
 * ~2.5 minutes of consecutive failure at the 30s tick cadence. A judgement call:
 * high enough to ride out a transient blip, low enough to surface NF-4 (a tick
 * that throws every iteration) quickly.
 *
 * One definition, read by both the alerter and the health payload. Two copies
 * drift silently and in a confusing direction: a banner reading "degraded" while
 * no alert fired looks like a broken alerter, and the reverse looks like a
 * broken banner. Neither points at the real cause.
 */
export const DEGRADED_AFTER_FAILURES = 5;

/**
 * Error classes permitted to appear in a health payload, an alert, or a stored
 * settings row.
 *
 * An ALLOWLIST, not a sanitiser. `err.constructor.name` looks safe and mostly
 * is, but it is unbounded in practice — every library invents error classes
 * freely, and a class name can carry interpolated context if someone constructs
 * one that way. Anything not named here becomes `unknown_error`, so the set of
 * strings that can ever leave this process is finite and reviewable.
 *
 * `err.message` must NEVER reach any of those places: SQLite errors carry file
 * paths, fetch errors carry URLs, and a decrypt failure can carry worse (I9).
 */
const PERMITTED_ERROR_CLASSES = new Set([
  // Node / JS built-ins
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "AggregateError",
  // better-sqlite3
  "SqliteError",
  // Playwright
  "TimeoutError",
  // Linki's own, from connect.ts / message.ts / runner.ts
  "WeeklyLimitError", "AlreadyConnectedError", "PendingInviteError", "InviteUiError",
  "InviteNotSentError", "SessionExpiredError", "NotConnectedError",
  "MessagingUrnUnresolvedError", "UnresolvedSideEffectError",
  "AuthenticationNotEstablishedError", "UnencryptedSessionError",
  "UnresolvableProfileUrlError",
  "UntrustedProfileHostError",
]);

export const UNKNOWN_ERROR_CLASS = "unknown_error";

/** Maps any thrown value to an allowlisted class name, or `unknown_error`. */
export function classifyError(err: unknown): string {
  if (!(err instanceof Error)) return UNKNOWN_ERROR_CLASS;
  const name = err.constructor?.name;
  return name && PERMITTED_ERROR_CLASSES.has(name) ? name : UNKNOWN_ERROR_CLASS;
}

// ─── what the banner shows ───────────────────────────────────────────────────
// Kept here, as pure functions over the payload, because the project has no DOM
// test tooling and adding some would mean new dependencies. The decisions worth
// testing — which severity, what text, when a dismissal stops applying — are
// therefore testable in plain node; only the React wiring around them is not.

export type BannerSeverity = "none" | "warn" | "error";

export interface BannerState {
  severity: BannerSeverity;
  headline: string;
  detail: string;
  /**
   * Identity of *this* problem. A dismissal is remembered against this key, so
   * dismissing a degraded banner does not also hide a later dead one — the
   * failure that matters most would otherwise be the one most likely silenced.
   */
  key: string;
}

const NONE: BannerState = { severity: "none", headline: "", detail: "", key: "" };

/**
 * Derives the banner from a health response.
 *
 * `ok` is the HTTP-level ok flag and `body` the parsed payload, or null when the
 * response could not be reached or could not be parsed. A null body is NOT
 * treated as healthy: silence is the failure mode this whole task exists to
 * remove, and a proxy returning an HTML 502 must not read as "all clear".
 */
export function bannerFromHealth(input: { ok: boolean; body: unknown } | null): BannerState {
  if (!input || typeof input.body !== "object" || input.body === null) {
    return {
      severity: "error",
      headline: "Cannot reach the automation service",
      detail: "The health check did not return a readable response. Work may be stopped.",
      key: "unreachable",
    };
  }

  const body = input.body as {
    restart_will_help?: unknown;
    reason?: unknown;
    db?: unknown;
    schema?: unknown;
    runner?: { state?: unknown; consecutive_tick_failures?: unknown; last_error_class?: unknown; revivals?: unknown };
  };
  const runnerState = typeof body.runner?.state === "string" ? body.runner.state : null;

  if (!input.ok) {
    if (runnerState === "dead") {
      return {
        severity: "error",
        headline: "The automation runner has stopped",
        detail: "No campaign work is being executed. It is being restarted automatically; if this persists, the service needs attention.",
        key: "dead",
      };
    }
    // The remaining 503s are all restart_will_help:false — a bad secret, a
    // missing migration, an unreadable database. Say so plainly rather than
    // implying it will clear on its own.
    const reason = typeof body.reason === "string" ? body.reason : "unknown";
    return {
      severity: "error",
      headline: "The automation service is unhealthy",
      detail: `Restarting will not fix this on its own (${reason}). No campaign work is being executed.`,
      key: `unhealthy:${reason}`,
    };
  }

  if (runnerState === "degraded") {
    const failures = typeof body.runner?.consecutive_tick_failures === "number" ? body.runner.consecutive_tick_failures : 0;
    // Re-validated on READ, not trusted because it was allowlisted on write.
    // This is the one value in the payload that originates from a thrown error,
    // and this function is what puts it in the DOM. Checking it here means a
    // leak introduced anywhere upstream — a new writer, a hand-edited settings
    // row, a rolled-back deploy — still cannot reach a page (I9).
    const raw = body.runner?.last_error_class;
    const cls = typeof raw === "string" && PERMITTED_ERROR_CLASSES.has(raw) ? raw : UNKNOWN_ERROR_CLASS;
    return {
      severity: "warn",
      headline: "The automation runner is failing repeatedly",
      detail: `${failures} consecutive attempts have failed (${cls}). The runner is alive but is not completing work.`,
      // Keyed by class, not by count: a dismissal should survive the counter
      // ticking up, but a DIFFERENT failure is a different problem.
      key: `degraded:${cls}`,
    };
  }

  return NONE;
}
