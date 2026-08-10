#!/usr/bin/env bash
# Run AFTER staging, IMMEDIATELY BEFORE committing, and CHAIN IT:
#
#   git add <paths> && ./scripts/preflight.sh && git commit ...
#
# The chain is the point. Phase 2 shipped a commit with a failing test because the
# suite was run as a report rather than a gate. It then happened a second time in
# a milder form: preflight was run BEFORE `git add`, correctly reported the new
# file as untracked, and the commit proceeded anyway because the output was piped
# to `tail` instead of gating the command. A gate you read is a report. A gate you
# chain with && is a gate.
#
# Order matters: run this AFTER staging, or the untracked check fires on the very
# files you are about to commit.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail=0
step() { printf '%-42s' "$1"; }
ok()   { echo "OK"; }
bad()  { echo "FAIL — $1"; fail=1; }

# The six local-only paths, by IDENTITY not count. A count drifts silently: one
# artifact replaced by another still counts six.
LOCAL_ONLY=(
  "diag.ts" "invite-diag.ts" "whoami.ts"
  "scripts/demo-connect-message.ts" "tests/demo-harness.test.ts"
)

step "local-only files ignored"
missing=""
for f in "${LOCAL_ONLY[@]}"; do
  [ -e "$f" ] || missing="${missing} ${f}(absent)"
  git check-ignore -q "$f" || missing="${missing} ${f}(NOT-IGNORED)"
done
[ -z "${missing}" ] && ok || bad "${missing}"

# Untracked = neither ignored nor staged. Anything here is either a new file you
# forgot to `git add`, or a local artifact that belongs in .git/info/exclude.
step "no unexpected untracked files"
extra=$(git status --porcelain | grep '^??' || true)
[ -z "${extra}" ] && ok || bad "$(echo "${extra}" | tr '\n' ' ')(stage it, or add to .git/info/exclude)"

step "tsc --noEmit"
if npx tsc --noEmit >/tmp/preflight-tsc.log 2>&1; then ok; else bad "$(grep -c 'error TS' /tmp/preflight-tsc.log) errors"; fi

step "npm test"
if npm test >/tmp/preflight-test.log 2>&1; then
  ok
else
  bad "$(grep -E '^. (pass|fail)' /tmp/preflight-test.log | tr '\n' ' ')"
  grep -E '^✖' /tmp/preflight-test.log | sort -u | head -5 | sed 's/^/    /'
fi

# NOT an equality check. An equality check punishes improvement: the first person
# to legitimately fix a lint error gets a failing gate, and the predictable
# response is to bypass or delete the gate — a worse outcome than 40 lint errors.
# A gate should catch regression and never block progress. Same principle as the
# test-count tripwire. Lower the baseline here when errors are genuinely fixed.
ESLINT_BASELINE="${ESLINT_BASELINE:-40}"
step "eslint <= baseline (${ESLINT_BASELINE})"
n=$(npx eslint . 2>&1 | grep -oE '[0-9]+ problems' | head -1 | grep -oE '^[0-9]+' | head -1)
n=${n:-unknown}
if [ "${n}" = "unknown" ]; then
  bad "could not parse eslint output"
elif [ "${n}" -le "${ESLINT_BASELINE}" ]; then
  ok
  [ "${n}" -lt "${ESLINT_BASELINE}" ] && echo "    (improved: ${n} < ${ESLINT_BASELINE} — lower ESLINT_BASELINE in this script)"
else
  bad "${n} problems, baseline ${ESLINT_BASELINE} — new lint is a regression"
fi

echo
if [ "${fail}" = "0" ]; then echo "PREFLIGHT PASS — safe to commit"; else echo "PREFLIGHT FAIL — do not commit"; fi
exit "${fail}"
