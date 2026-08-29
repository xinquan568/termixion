#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Self-test for scripts/check-file-budgets.sh (trmx-243, grill Add-on 5 metric 8).
#
# The budget gate is a RATCHET, not a wall: it exists so `main.rs` and `App.tsx` cannot silently
# regrow after the trmx-243 split, while a deliberate, reviewed raise stays a one-line edit. A
# ratchet nobody trusts gets raised reflexively, so this proves the gate actually refuses growth,
# actually passes a file under budget, and — the case that matters most — FAILS CLOSED when it
# cannot measure a watched file at all. A gate that goes green because it could not look is worse
# than no gate.
#
# Two details keep it non-vacuous:
#   * the assertions are on the gate's EXIT STATUS, plus (for the over-budget case) that the message
#     actually names the file, the budget and the actual — an operator who cannot see all three
#     cannot decide between splitting and raising;
#   * the .rs fixture carries a `#[cfg(test)]` block far larger than its body, pinning that the gate
#     counts NON-TEST lines only. A test-heavy PR must never be punished by this gate.
#
# Everything happens in a temp dir; the real tree is never touched.
# Run: bash scripts/check-file-budgets.test.sh
set -euo pipefail

GATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-file-budgets.sh"
[ -f "$GATE" ] || { echo "check-file-budgets.test: gate not found at $GATE" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
fails=0

# Build a fake repo with the two watched paths. <rs-body-lines> non-test lines in main.rs and
# <tsx-lines> in App.tsx; main.rs always gets a 400-line test module on top.
new_repo() { # new_repo <dir> <rs-body-lines> <tsx-lines>
  mkdir -p "$1/crates/termixion-tauri/src" "$1/app/src"
  {
    printf '// SPDX-License-Identifier: ISC\n'
    for _ in $(seq 2 "$2"); do printf 'fn filler() {}\n'; done
    printf '#[cfg(test)]\nmod tests {\n'
    for _ in $(seq 1 397); do printf '    // test filler\n'; done
    printf '}\n'
  } > "$1/crates/termixion-tauri/src/main.rs"
  for _ in $(seq 1 "$3"); do printf 'const filler = 1;\n'; done > "$1/app/src/App.tsx"
}

check() { # check <label> <dir> <expected: pass|fail> [must-contain ...]
  local label="$1" dir="$2" expect="$3" rc=0 out=""
  shift 3
  out="$(bash "$GATE" "$dir" 2>&1)" || rc=$?
  if [ "$expect" = pass ] && [ "$rc" -ne 0 ]; then
    echo "FAIL: $label — expected exit 0, got $rc:"; printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1)); return
  fi
  if [ "$expect" = fail ] && [ "$rc" -eq 0 ]; then
    echo "FAIL: $label — expected a NON-ZERO exit, got 0:"; printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1)); return
  fi
  local needle
  for needle in "$@"; do
    if ! printf '%s' "$out" | grep -qF -- "$needle"; then
      echo "FAIL: $label — output did not mention '$needle':"; printf '%s\n' "$out" | sed 's/^/    /'
      fails=$((fails + 1)); return
    fi
  done
  echo "ok: $label"
}

# (i) both files comfortably under budget → pass. The .rs fixture's 400-line test module is four
# times its body: if the gate counted total lines this case would fail, so it also pins the
# non-test-lines-only rule.
new_repo "$tmp/under" 100 100
check "both files under budget pass (test lines are not counted)" "$tmp/under" pass

# (ii) an over-budget main.rs is REFUSED, and the message names file, budget and actual — the
# acceptance criterion.
new_repo "$tmp/over-rs" 5000 100
check "an over-budget main.rs is REFUSED, naming file/budget/actual" "$tmp/over-rs" fail \
  "crates/termixion-tauri/src/main.rs" "budget" "5000"

# (iii) the same for App.tsx, so the second watched file is really watched and not decoration.
new_repo "$tmp/over-tsx" 100 9000
check "an over-budget App.tsx is REFUSED" "$tmp/over-tsx" fail "app/src/App.tsx" "9000"

# (iv) a watched file that is missing must FAIL CLOSED. A rename or a move that silently drops a
# file out of the gate's sight is exactly how a ratchet stops ratcheting.
new_repo "$tmp/missing" 100 100
rm "$tmp/missing/app/src/App.tsx"
check "a MISSING watched file FAILS CLOSED (never a vacuous OK)" "$tmp/missing" fail "app/src/App.tsx"

# (v) the failure message must tell the operator both legitimate responses. The raise is the
# point — an undocumented ratchet reads as a wall and gets worked around instead of raised.
new_repo "$tmp/advice" 5000 100
check "the failure explains BOTH responses (split, or raise with a reason)" "$tmp/advice" fail \
  "split" "raise"

if [ "$fails" -ne 0 ]; then
  echo "check-file-budgets.test: $fails case(s) failed." >&2
  exit 1
fi
echo "check-file-budgets.test: OK (5 cases)."
