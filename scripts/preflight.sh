#!/usr/bin/env bash
# Run BEFORE every commit. Phase 2 shipped a commit with a failing test because
# the suite was run as a report rather than a gate; this makes it a gate.
#
#   ./scripts/preflight.sh   -> exit 0 = safe to commit
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
  "lib/linkedin/runner.ts.bak" "scripts/demo-connect-message.ts" "tests/demo-harness.test.ts"
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

step "eslint at baseline (40 problems)"
n=$(npx eslint . 2>&1 | grep -oE '[0-9]+ problems' | head -1 | grep -oE '^[0-9]+' | head -1)
n=${n:-unknown}
[ "${n}" = "40" ] && ok || bad "${n} problems, baseline is 40 (new lint is a regression)"

echo
if [ "${fail}" = "0" ]; then echo "PREFLIGHT PASS — safe to commit"; else echo "PREFLIGHT FAIL — do not commit"; fi
exit "${fail}"
