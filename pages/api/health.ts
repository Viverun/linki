import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { DEGRADED_AFTER_FAILURES, classifyError } from "@/lib/health-contract";
import { methodNotAllowed } from "@/lib/api-validate";

/**
 * Liveness endpoint. Unauthenticated by design (see proxy.ts), therefore:
 * READ-ONLY, CHEAP, and NON-INFORMATIVE. No writes of any kind — an
 * unauthenticated caller must not be able to grow the WAL — and no COUNT(*)
 * over any table.
 *
 * LIVENESS_THRESHOLD_MS is derived from the timeout budget recorded in
 * docs/phase1-baseline.md, not from the tick interval:
 *
 *   worst single step   ≈ 345s  (gotoAuthenticated 122.5 + invite UI 40
 *                                + verifyInvitationSent 182.5)
 *   + randomDelay       ≤  20s
 *   ------------------------------------------------------------------
 *   worst marker gap    ≈ 365s   →  600s threshold, ~64% margin
 *
 * If any Playwright timeout in connect.ts / visit.ts / message.ts changes, this
 * number is invalid. The budget table cross-references back here.
 *
 * Three states, because two cannot express both failure modes:
 *
 *   dead      progress marker stale or absent      → 503
 *   degraded  marker fresh, tick failing repeatedly → 200 + flag
 *   healthy   marker fresh, no consecutive failures → 200
 *
 * Only `dead` returns 503. A deterministically failing tick will not be fixed by
 * a restart, and restarting mid-step is exactly the hazard the ledger exists to
 * prevent — it manufactures the `in_flight` state a human then has to resolve.
 * A supervisor should act on death, never on degradation.
 *
 * An absent marker means the loop never started: it is written at iteration
 * start, so one exists within seconds of boot. Past the healthcheck's
 * --start-period that is genuinely 503-worthy — do not "fix" this into a 200.
 */
const LIVENESS_THRESHOLD_MS = 600_000;

/**
 * Payload contract version, consumed by scripts/health-predicate.js.
 *
 * Bump this whenever a field the predicate reads changes name or meaning. The
 * predicate warns loudly on an unexpected version rather than silently deciding
 * not to act — a safety mechanism that has quietly stopped protecting anything
 * is the worst failure mode available, and a renamed field looks exactly like a
 * healthy "no action needed".
 */
const HEALTH_SCHEMA = 1;

// DEGRADED_AFTER_FAILURES and classifyError come from lib/health-contract.ts,
// a dependency-free leaf. They are deliberately NOT imported from runner.ts —
// the endpoint that decides whether to restart must not depend on the subsystem
// it judges. The reasoning is recorded in that file.

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
    db.prepare("SELECT 1").get();
  } catch (err) {
    // A bad NEXTAUTH_SECRET, wrong permissions, or a corrupt file all repeat
    // identically after a restart — and each restart kills in-flight work.
    return res.status(503).json({
      ok: false, health_schema: HEALTH_SCHEMA, db: "unreachable", restart_will_help: false,
      reason: classifyError(err),
    });
  }

  try {
    // A swallowed migration is invisible everywhere else: the runner would boot
    // and every message step would fail closed on `no such table` long after the
    // fact. Surface it here instead. sqlite_master, not a COUNT over data.
    const ledger = db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = 'step_side_effects'"
    ).get() as { c: number };
    if (ledger.c !== 1) {
      // A swallowed migration repeats on every boot. Restarting just loops.
      return res.status(503).json({
        ok: false, health_schema: HEALTH_SCHEMA, db: "ok", schema: "incomplete", restart_will_help: false,
        reason: "step_side_effects_missing",
      });
    }

    const settings = db.prepare(
      "SELECT key, value FROM app_settings WHERE key IN ('runner_progress_at','runner_progress_phase','runner_tick_failures','runner_last_error_class','runner_revivals')"
    ).all() as Array<{ key: string; value: string }>;
    const get = (k: string) => settings.find(s => s.key === k)?.value ?? null;

    const progressAt = get("runner_progress_at");
    const failures = parseInt(get("runner_tick_failures") ?? "0", 10) || 0;
    const secondsSince = progressAt ? Math.round((Date.now() - new Date(progressAt).getTime()) / 1000) : null;

    const dead = secondsSince === null || secondsSince * 1000 > LIVENESS_THRESHOLD_MS;
    if (dead) {
      // The ONLY restart-fixable 503: the database is fine, the schema is
      // complete, and the loop simply is not running. The in-process watchdog
      // gets first refusal; the supervisor is the backstop for a process that
      // cannot help itself.
      return res.status(503).json({
        ok: false, health_schema: HEALTH_SCHEMA, db: "ok", schema: "ok", restart_will_help: true,
        runner: {
          state: "dead", last_progress_at: progressAt, seconds_since_progress: secondsSince,
          revivals: parseInt(get("runner_revivals") ?? "0", 10) || 0,
        },
      });
    }

    const degraded = failures >= DEGRADED_AFTER_FAILURES;
    return res.status(200).json({
      ok: true, health_schema: HEALTH_SCHEMA, db: "ok", schema: "ok", restart_will_help: false,
      runner: {
        state: degraded ? "degraded" : "healthy",
        last_progress_at: progressAt,
        seconds_since_progress: secondsSince,
        phase: get("runner_progress_phase"),
        consecutive_tick_failures: failures,
        // Repeated automatic revivals are a symptom worth seeing even while the
        // instance reads healthy right now.
        revivals: parseInt(get("runner_revivals") ?? "0", 10) || 0,
        // Class only, never a message — messages carry profile URLs (I9).
        last_error_class: degraded ? (get("runner_last_error_class") || null) : null,
      },
    });
  } catch (err) {
    // An unexpected query failure against a reachable DB is not a liveness
    // problem and will recur.
    return res.status(503).json({
      ok: false, health_schema: HEALTH_SCHEMA, db: "ok", schema: "unknown", restart_will_help: false,
      reason: classifyError(err),
    });
  }
}
