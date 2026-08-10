import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

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
 * ~2.5 minutes of consecutive failure at the 30s tick cadence. A judgement call:
 * high enough to ride out a transient blip, low enough to surface NF-4 (a tick
 * that throws every iteration) quickly.
 */
const DEGRADED_AFTER_FAILURES = 5;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();

  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
    db.prepare("SELECT 1").get();
  } catch (err) {
    return res.status(503).json({
      ok: false, db: "unreachable",
      reason: err instanceof Error ? err.constructor.name : "unknown",
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
      return res.status(503).json({ ok: false, db: "ok", schema: "incomplete", reason: "step_side_effects_missing" });
    }

    const settings = db.prepare(
      "SELECT key, value FROM app_settings WHERE key IN ('runner_progress_at','runner_progress_phase','runner_tick_failures','runner_last_error_class')"
    ).all() as Array<{ key: string; value: string }>;
    const get = (k: string) => settings.find(s => s.key === k)?.value ?? null;

    const progressAt = get("runner_progress_at");
    const failures = parseInt(get("runner_tick_failures") ?? "0", 10) || 0;
    const secondsSince = progressAt ? Math.round((Date.now() - new Date(progressAt).getTime()) / 1000) : null;

    const dead = secondsSince === null || secondsSince * 1000 > LIVENESS_THRESHOLD_MS;
    if (dead) {
      return res.status(503).json({
        ok: false, db: "ok", schema: "ok",
        runner: { state: "dead", last_progress_at: progressAt, seconds_since_progress: secondsSince },
      });
    }

    const degraded = failures >= DEGRADED_AFTER_FAILURES;
    return res.status(200).json({
      ok: true, db: "ok", schema: "ok",
      runner: {
        state: degraded ? "degraded" : "healthy",
        last_progress_at: progressAt,
        seconds_since_progress: secondsSince,
        phase: get("runner_progress_phase"),
        consecutive_tick_failures: failures,
        // Class only, never a message — messages carry profile URLs (I9).
        last_error_class: degraded ? (get("runner_last_error_class") || null) : null,
      },
    });
  } catch (err) {
    return res.status(503).json({
      ok: false, db: "ok", schema: "unknown",
      reason: err instanceof Error ? err.constructor.name : "unknown",
    });
  }
}
