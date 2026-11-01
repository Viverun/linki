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
#
# PR-05 control-flow rules. Each one is here because violating it is silent:
#
#   1. The state file is READ-MODIFY-WRITE, so runs are serialised with flock.
#      Two overlapping invocations both read streak=2 and both write 3, so a
#      restart is never recorded and the budget believes fewer restarts happened
#      than actually did. Cron overlapping its own previous run is not exotic:
#      one slow probe is enough.
#   2. History is written by a helper, not inline as
#      `{ echo ...; [ -n "$h" ] && echo "$h"; }`. Under `pipefail` that group
#      exits 1 when the history is empty, which made the SUCCESSFUL restart path
#      exit 1 before logging "restart issued" — i.e. the very first restart after
#      a fresh state reported failure to cron while the restart had worked.
#   3. Every state write goes to a sibling temp file and is renamed. In-place
#      `>` truncation leaves a zero-byte file if the host dies mid-write, and a
#      zero-byte state file reads back as "streak 0, no restarts" — it forgets
#      the budget in the direction that keeps restarting.
#   4. Only exit 1 from the predicate means "a restart can fix this" (see
#      scripts/health-predicate.js). Any other status is the PROBE failing to
#      run — missing node, syntax error, OOM kill — and treating that as a dead
#      app would let a broken supervisor restart the service three times an hour.
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT:-3456}/api/health}"
STATE_FILE="${STATE_FILE:-${COMPOSE_DIR}/data/.watchdog-state}"
FAILURES_BEFORE_ACTION="${FAILURES_BEFORE_ACTION:-3}"   # x 60s cron = ~3 min sustained
MAX_RESTARTS_PER_HOUR="${MAX_RESTARTS_PER_HOUR:-3}"
SERVICE="${SERVICE:-linki}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [watchdog] $*"; }

mkdir -p "$(dirname "${STATE_FILE}")"

# Serialise before touching the state. Fail CLOSED if flock is unavailable:
# running unserialised would silently reintroduce rule 1, and a supervisor that
# looks like it is protecting the budget while losing updates is worse than one
# that loudly refuses to start. util-linux is present on every supported host
# (and in the node:22-slim verification image).
if ! command -v flock >/dev/null 2>&1; then
  log "FATAL: flock not found — refusing to run unserialised (concurrent runs lose budget updates)"
  exit 2
fi
exec 9>"${STATE_FILE}.lock"
if ! flock -n 9; then
  # Correct outcome, not an error: the other invocation is already deciding, and
  # counting this as a failure would advance the streak twice per incident.
  log "another invocation holds the lock — skipping this tick"
  exit 0
fi

state_is_present() { [ -s "${STATE_FILE}" ]; }

# A missing or zero-byte file is a fresh state, not a crash. The streak is the
# first line; everything after it is epoch seconds of past restarts.
if ! state_is_present; then
  printf '0\n' > "${STATE_FILE}"
fi
streak="$(awk 'NR==1{print $1+0}' "${STATE_FILE}")"
history="$(awk 'NR>1 && NF' "${STATE_FILE}")"

# Atomic write. $1 = streak, $2 = optional epoch of the restart just performed.
# History is pruned to the last 24h on every write: it only exists to feed the
# one-hour budget, so anything older cannot change a decision.
write_state() {
  local streak_next="$1" restart_ts="${2:-}"
  local now_ts tmp
  now_ts="$(date +%s)"
  tmp="${STATE_FILE}.tmp.$$"
  {
    echo "${streak_next}"
    [ -z "${restart_ts}" ] || echo "${restart_ts}"
    printf '%s\n' "${history}" | awk -v n="${now_ts}" 'NF && $1 > n-86400'
  } > "${tmp}"
  mv -f "${tmp}" "${STATE_FILE}"
}

# Same predicate as the Docker HEALTHCHECK — one definition, two callers.
health_rc=0
node "${COMPOSE_DIR}/scripts/health-predicate.js" "${HEALTH_URL}" || health_rc=$?

if [ "${health_rc}" -eq 0 ]; then
  if [ "${streak}" != "0" ]; then
    log "healthy again — clearing the failure streak"
    write_state 0
  fi
  exit 0
fi

if [ "${health_rc}" -ne 1 ]; then
  log "health predicate could not run (exit ${health_rc}) — NOT being treated as an unhealthy app; fix the supervisor"
  exit 0
fi

streak=$((streak + 1))
write_state "${streak}"

if [ "${streak}" -lt "${FAILURES_BEFORE_ACTION}" ]; then
  log "restart-fixable death, streak ${streak}/${FAILURES_BEFORE_ACTION} — not acting yet"
  exit 0
fi

# Restart budget. Autoheal had no backoff; a supervisor without a cap turns one
# broken deploy into an endless restart loop, and every restart kills work.
now="$(date +%s)"
recent="$(printf '%s\n' "${history}" | awk -v n="${now}" 'NF && $1 > n-3600' | wc -l | tr -d ' ')"
if [ "${recent}" -ge "${MAX_RESTARTS_PER_HOUR}" ]; then
  log "BUDGET EXHAUSTED: ${recent} restarts in the last hour (cap ${MAX_RESTARTS_PER_HOUR}). NOT restarting — this needs a human."
  exit 0
fi

log "restarting ${SERVICE} (streak ${streak}, ${recent} restarts in the last hour)"
if (cd "${COMPOSE_DIR}" && docker compose restart "${SERVICE}"); then
  # Budget records the restart we actually performed, and the streak resets
  # because the condition it counted is now being treated.
  write_state 0 "${now}"
  log "restart issued"
else
  # The streak stays so the next run retries — a failed restart command must not
  # look like a recovered service. Exit non-zero so cron/monitoring sees it: the
  # one thing a silent supervisor must not do is fail quietly.
  log "restart FAILED — leaving the streak intact so the next run retries"
  exit 1
fi
