#!/usr/bin/env node
/**
 * THE single definition of "should something restart this container?".
 *
 * Two callers, one definition, so they cannot drift:
 *   - the Docker HEALTHCHECK in the Dockerfile (runs inside the container)
 *   - scripts/watchdog.sh on the host (runs outside it)
 *
 * Exits 1 only for a dead runner that a restart can actually fix. Three of the
 * four 503 reasons /api/health can return — unreachable DB, incomplete schema,
 * unexpected query failure — repeat identically after a restart, and every
 * restart kills in-flight LinkedIn work, so acting on the raw status would
 * restart-loop forever while manufacturing exactly the in_flight ledger states
 * Phase 1 exists to prevent. Those still return 503 so a human sees them; this
 * predicate simply does not act on them.
 *
 * A failed fetch exits 1: the server is not answering at all, which a restart
 * can fix.
 *
 * Usage: node scripts/health-predicate.js [url]
 */
const url = process.argv[2] || "http://127.0.0.1:3000/api/health";

const EXPECTED_SCHEMA = 1;

/**
 * FAIL-SAFE MUST NOT BE FAIL-SILENT.
 *
 * "No action" is the correct response to a payload we do not understand — and it
 * is also exactly what a renamed field looks like. A supervisor that has quietly
 * stopped protecting anything is the worst outcome available here, so every
 * not-understood branch shouts on stderr instead of exiting 0 in silence.
 */
function warn(msg) {
  console.error(`[health-predicate] ${msg}`);
}

fetch(url)
  .then((r) => r.json())
  .then((b) => {
    if (!b || typeof b !== "object") {
      warn("payload is not an object — SUPERVISOR INACTIVE, nothing will be restarted");
      process.exit(0);
    }
    if (b.health_schema !== EXPECTED_SCHEMA) {
      warn(
        `unexpected health_schema=${JSON.stringify(b.health_schema)} (expected ${EXPECTED_SCHEMA}) — ` +
        "SUPERVISOR INACTIVE. The image may predate this predicate, or /api/health's contract changed " +
        "without bumping HEALTH_SCHEMA. Nothing will be restarted until this matches."
      );
      process.exit(0);
    }
    if (typeof b.restart_will_help !== "boolean") {
      warn(
        "predicate field `restart_will_help` absent — SUPERVISOR INACTIVE, image may predate P2-1. " +
        "Nothing will be restarted."
      );
      process.exit(0);
    }
    const act = b.runner && b.runner.state === "dead" && b.restart_will_help === true;
    if (process.env.HEALTH_PREDICATE_VERBOSE === "1") {
      const state = (b.runner && b.runner.state) || b.schema || "unknown";
      console.log(`state=${state} restart_will_help=${b.restart_will_help} act=${!!act}`);
    }
    process.exit(act ? 1 : 0);
  })
  .catch((e) => {
    // The server is not answering at all. That IS restart-fixable.
    warn(`health endpoint unreachable (${e && e.message}) — treating as dead`);
    process.exit(1);
  });
