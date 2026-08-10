#!/usr/bin/env bash
# Host-side supervisor for the one failure the other layers cannot reach.
#
# Coverage boundaries, so this is not mistaken for doing more than it does:
#   - a process that EXITS            -> `restart: unless-stopped` already handles it
#   - a dead loop in a LIVE process   -> the in-process watchdog handles it (P2-1 Part A)
#   - alive but UNRESPONSIVE          -> only this: hung event loop, OOM without
#                                        exit, wedged HTTP server
#
# Deliberately not a Docker-socket sidecar. Mounting the socket into a container
# is root-equivalent on the host — `:ro` prevents writing the socket file, not
# using the daemon API through it — and that is a bad trade for a convenience
# restart. This script grants nothing your shell does not already have.
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT:-3456}/api/health}"
STATE_FILE="${STATE_FILE:-${COMPOSE_DIR}/data/.watchdog-state}"
FAILURES_BEFORE_ACTION="${FAILURES_BEFORE_ACTION:-3}"   # x 60s cron = ~3 min sustained
MAX_RESTARTS_PER_HOUR="${MAX_RESTARTS_PER_HOUR:-3}"
SERVICE="${SERVICE:-linki}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [watchdog] $*"; }

# Same predicate as the Docker HEALTHCHECK — one definition, two callers.
if node "${COMPOSE_DIR}/scripts/health-predicate.js" "${HEALTH_URL}"; then
  if [ -f "${STATE_FILE}" ] && [ "$(awk 'NR==1{print $1}' "${STATE_FILE}" 2>/dev/null || echo 0)" != "0" ]; then
    log "healthy again — clearing the failure streak"
    awk 'NR>1' "${STATE_FILE}" > "${STATE_FILE}.tmp" 2>/dev/null || true
    { echo 0; cat "${STATE_FILE}.tmp" 2>/dev/null || true; } > "${STATE_FILE}"
    rm -f "${STATE_FILE}.tmp"
  fi
  exit 0
fi

# Line 1 = consecutive failures. Lines 2+ = epoch seconds of past restarts.
mkdir -p "$(dirname "${STATE_FILE}")"
[ -f "${STATE_FILE}" ] || echo 0 > "${STATE_FILE}"
streak=$(awk 'NR==1{print $1+0}' "${STATE_FILE}")
history=$(awk 'NR>1' "${STATE_FILE}" || true)
streak=$((streak + 1))
{ echo "${streak}"; [ -n "${history}" ] && echo "${history}"; } > "${STATE_FILE}"

if [ "${streak}" -lt "${FAILURES_BEFORE_ACTION}" ]; then
  log "restart-fixable death, streak ${streak}/${FAILURES_BEFORE_ACTION} — not acting yet"
  exit 0
fi

# Restart budget. Autoheal had no backoff; a supervisor without a cap turns one
# broken deploy into an endless restart loop, and every restart kills work.
now=$(date +%s)
recent=$(echo "${history}" | awk -v n="${now}" '$1 > n-3600' | wc -l | tr -d ' ')
if [ "${recent}" -ge "${MAX_RESTARTS_PER_HOUR}" ]; then
  log "BUDGET EXHAUSTED: ${recent} restarts in the last hour (cap ${MAX_RESTARTS_PER_HOUR}). NOT restarting — this needs a human."
  exit 0
fi

log "restarting ${SERVICE} (streak ${streak}, ${recent} restarts in the last hour)"
if (cd "${COMPOSE_DIR}" && docker compose restart "${SERVICE}"); then
  { echo 0; echo "${now}"; [ -n "${history}" ] && echo "${history}"; } \
    | awk -v n="${now}" 'NR==1 || $1 > n-86400' > "${STATE_FILE}"
  log "restart issued"
else
  log "restart FAILED — leaving the streak intact so the next run retries"
fi
