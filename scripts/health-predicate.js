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

fetch(url)
  .then((r) => r.json())
  .then((b) => {
    const act = !!(b && b.runner && b.runner.state === "dead" && b.restart_will_help === true);
    if (process.env.HEALTH_PREDICATE_VERBOSE === "1") {
      const state = (b && b.runner && b.runner.state) || (b && b.schema) || "unknown";
      console.log(`state=${state} restart_will_help=${b && b.restart_will_help} act=${act}`);
    }
    process.exit(act ? 1 : 0);
  })
  .catch(() => process.exit(1));
