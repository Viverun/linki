#!/usr/bin/env bash
# Mutation harness. Source it, then call `mutate`.
#
#   source scripts/mutate.sh
#   mutate "<name>" <file-to-mutate> <test-file> "<expected test name substring>" '<python snippet>'
#
# ── WHY THIS IS A SCRIPT AND NOT A HABIT ─────────────────────────────────────
#
# Mutation testing is this project's primary evidence standard: a test is only
# believed once a mutation that should break it does. That makes the harness
# itself load-bearing — a harness that misreports turns the whole evidence base
# into noise. Three ways it has actually misreported, all found the hard way:
#
#   1. NO-OP.        The target literal did not exist, so the replace changed
#                    nothing. The untouched test passed and was scored SURVIVED.
#   2. BROKEN RUN.   The runner command lived in a shell variable and was
#                    expanded unquoted under zsh, which does NOT word-split. The
#                    command never ran, zero failures were seen, and that too was
#                    scored SURVIVED.
#   3. INCONCLUSIVE. A mutation that breaks compilation makes the test FILE fail
#                    to load. `node --test` then reports `tests 1 / fail 1` with
#                    the file path as the failing entry. A harness asking only
#                    "did anything fail?" scores this KILLED — while the test it
#                    was aimed at detected nothing at all about the behaviour.
#
# (1) and (2) fail SAFE: they can only invent a false SURVIVOR, never a false
# kill, so they understate coverage. (3) fails UNSAFE — it is the only one that
# can manufacture a kill that never happened. See docs/operations.md.
#
# The rule this encodes: a kill must be attributed to a NAMED test. "The suite
# went red" is not evidence about any particular assertion.
set -uo pipefail

MUTATE_ROOT="${MUTATE_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

mutate () {
  if [ "$#" -ne 5 ]; then
    echo "usage: mutate <name> <target> <test-file> <expected-test-substring> <python-snippet>" >&2
    return 64
  fi
  local name="$1" target="$2" testfile="$3" expect="$4" snippet="$5"
  cd "${MUTATE_ROOT}" || return 1

  local backup; backup=$(mktemp)
  cp "$target" "$backup"
  restore () { cp "$backup" "$target"; rm -f "$backup"; }

  if ! python3 -c "$snippet" 2>/dev/null; then
    printf "  ⚠️  %-48s SNIPPET ERROR — mutation not applied\n" "$name"; restore; return 2
  fi
  # (1) Proof the file actually changed.
  if diff -q "$backup" "$target" >/dev/null; then
    printf "  ⚠️  %-48s NO-OP — target literal absent\n" "$name"; restore; return 2
  fi

  local out
  out=$(timeout 250 node --experimental-strip-types --experimental-test-module-mocks \
        --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --disable-warning=ExperimentalWarning \
        --import ./scripts/test-setup.mjs --test "$testfile" 2>&1)
  restore

  # (2) Proof the run happened at all, independent of its result.
  if ! grep -qE "^(#|ℹ) tests " <<<"$out"; then
    printf "  ⚠️  %-48s BROKEN RUN — no summary emitted\n" "$name"; return 2
  fi

  # (3) A failing entry naming a test FILE means the module never loaded — a
  # compile error, an import-time throw, a missing export. Every test in the file
  # is reported failing without any of them having evaluated anything. That is
  # inconclusive about the target assertion, and must never be scored as a kill.
  local failures
  # `✖ failing tests:` is node's section header, not a failing test. Counting it
  # inflates every failure count by one and can look like a second detection.
  failures=$(grep -E "^✖ " <<<"$out" | sed 's/^✖ //' | sed 's/ ([0-9.]*ms)$//' \
             | grep -vxF "failing tests:" | sort -u)
  if grep -qE "\.(test\.(ts|mjs|js))$" <<<"$failures"; then
    printf "  ⚠️  %-48s INCONCLUSIVE — module failed to load, re-target\n" "$name"
    grep -E "\.(test\.(ts|mjs|js))$" <<<"$failures" | head -2 | sed 's/^/        /'
    return 3
  fi

  if [ -z "$failures" ]; then
    printf "  ❌ %-48s SURVIVED\n" "$name"; return 1
  fi

  # A kill must be ATTRIBUTED. The named test is the one claiming to detect this
  # behaviour; another test failing instead is still information, but it is not
  # evidence about the assertion under review.
  local n; n=$(grep -c . <<<"$failures")
  if grep -qF -- "$expect" <<<"$failures"; then
    printf "  ✅ %-48s KILLED by \"%s\" (+%s other)\n" "$name" "$expect" "$((n - 1))"
    return 0
  fi
  printf "  ⚠️  %-48s KILLED BY OTHER (%s) — expected \"%s\"\n" "$name" "$n" "$expect"
  head -3 <<<"$failures" | sed 's/^/        /'
  return 4
}
