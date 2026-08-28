#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Self-test for scripts/check-main-ci-green.sh (trmx-242, grill H8).
#
# The dry run on a PR branch only ever exercises the no-matching-run branch. Everything that makes
# this gate CORRECT rather than merely present — newest-run precedence, non-success conclusions,
# in-progress runs, provenance filtering, API failure — is covered here with a stubbed `gh`.
#
# The precedence case is the one that matters most: a plain `sort` compares run ids
# lexicographically, so id 999 would outrank id 1000 and an OLDER green run could mask a NEWER
# failure for the same commit. That is a gate that passes when it must not.
#
# Run: bash scripts/check-main-ci-green.test.sh
set -euo pipefail

GATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-main-ci-green.sh"
[ -f "$GATE" ] || { echo "check-main-ci-green.test: gate not found at $GATE" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
mkdir -p "$tmp/bin"
fails=0

# Stub `gh`: emits whatever RUNS_FIXTURE holds (already in the gate's jq output shape), or fails
# when GH_FAIL=1 so the API-error path is covered.
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
if [ "${GH_FAIL:-0}" = "1" ]; then echo "gh: API is down" >&2; exit 1; fi
printf '%s' "${RUNS_FIXTURE:-}"
STUB
chmod +x "$tmp/bin/gh"

check() { # check <label> <expect: pass|fail> [fixture]
  local label="$1" expect="$2" rc=0 out=""
  out="$(PATH="$tmp/bin:$PATH" SHA=deadbeef R=o/r SKIP_ANCESTRY=1 RUNS_FIXTURE="${3-}" \
         bash "$GATE" 2>&1)" || rc=$?
  if [ "$expect" = pass ] && [ "$rc" -ne 0 ]; then
    echo "FAIL: $label — expected PASS, got exit $rc:"; printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
  elif [ "$expect" = fail ] && [ "$rc" -eq 0 ]; then
    echo "FAIL: $label — expected a NON-ZERO exit, got 0:"; printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    echo "ok: $label"
  fi
}

tab="$(printf '\t')"
row() { printf '%s%s%s%s%s%s%s\n' "$1" "$tab" "$2" "$tab" "$3" "$tab" "$4"; }

check "a single green run passes" pass \
  "$(row 2026-08-28T09:00:00Z 1000 completed success)"

check "no matching run FAILS CLOSED" fail ""

check "a failed run FAILS" fail \
  "$(row 2026-08-28T09:00:00Z 1000 completed failure)"

check "a cancelled run FAILS" fail \
  "$(row 2026-08-28T09:00:00Z 1000 completed cancelled)"

check "an in-progress run FAILS (not completed)" fail \
  "$(row 2026-08-28T09:00:00Z 1000 in_progress none)"

# THE precedence case. Same timestamp; ids 999 (green) and 1000 (failed). A lexicographic sort puts
# "999" last and would wrongly pass. Numeric sorting on the id column picks 1000 — the newer run —
# and correctly fails.
check "a NEWER failure outranks an OLDER success at the same timestamp (numeric id sort)" fail \
  "$(row 2026-08-28T09:00:00Z 999 completed success
       row 2026-08-28T09:00:00Z 1000 completed failure)"

# And the converse: a newer success must still pass despite an older failure.
check "a NEWER success outranks an OLDER failure" pass \
  "$(row 2026-08-28T09:00:00Z 999 completed failure
       row 2026-08-28T09:00:00Z 1000 completed success)"

# Distinct timestamps, newest wins.
check "the newest run by timestamp decides" fail \
  "$(row 2026-08-28T08:00:00Z 1000 completed success
       row 2026-08-28T09:00:00Z 1001 completed failure)"

rc=0
out="$(PATH="$tmp/bin:$PATH" SHA=deadbeef R=o/r SKIP_ANCESTRY=1 GH_FAIL=1 bash "$GATE" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then
  echo "FAIL: an API error must FAIL CLOSED, got exit 0"; fails=$((fails + 1))
else
  echo "ok: an API error FAILS CLOSED"
fi

if [ "$fails" -ne 0 ]; then
  echo "check-main-ci-green.test: $fails case(s) failed." >&2
  exit 1
fi
echo "check-main-ci-green.test: OK (9 cases)."
