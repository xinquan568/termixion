#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Self-test for scripts/check-no-zwc.sh (trmx-240, L14). The repo shipped 8 compiled zsh wordcode
# files (996 KB) that zsh loads IN PREFERENCE to the reviewable source beside them; this proves the
# gate that stops them coming back actually refuses one.
#
# Two details keep it non-vacuous, and both are easy to get wrong:
#   * the planted .zwc is `git add`-ed — `git ls-files` reports only TRACKED files, so an untracked
#     fixture would sail past a gate that is working perfectly, and the test would go green either way;
#   * the assertion is on the gate's non-zero EXIT STATUS, not on anything it printed.
#
# Everything happens in a temp `git init`; the real tree is never touched.
# Run: bash scripts/check-no-zwc.test.sh
set -euo pipefail

GATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-no-zwc.sh"
[ -f "$GATE" ] || { echo "check-no-zwc.test: gate not found at $GATE" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
fails=0

new_repo() { # new_repo <dir>
  mkdir -p "$1"
  git -C "$1" init --quiet
  git -C "$1" config user.email t@example.com
  git -C "$1" config user.name t
  mkdir -p "$1/resources/shell-enhancements/powerlevel10k/internal"
  printf 'print hi\n' > "$1/resources/shell-enhancements/powerlevel10k/internal/p10k.zsh"
  git -C "$1" add -A
  git -C "$1" commit --quiet -m "base"
}

check() { # check <label> <dir> <expected: pass|fail>
  local label="$1" dir="$2" expect="$3" rc=0 out=""
  out="$(bash "$GATE" "$dir" 2>&1)" || rc=$?
  if [ "$expect" = pass ] && [ "$rc" -ne 0 ]; then
    echo "FAIL: $label — expected exit 0, got $rc:"; printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
  elif [ "$expect" = fail ] && [ "$rc" -eq 0 ]; then
    echo "FAIL: $label — expected a NON-ZERO exit, got 0."
    fails=$((fails + 1))
  else
    echo "ok: $label"
  fi
}

# (i) a clean repo passes.
new_repo "$tmp/clean"
check "a repo with no .zwc passes" "$tmp/clean" pass

# (ii) a TRACKED .zwc is refused — the acceptance criterion.
new_repo "$tmp/dirty"
printf '\x00zwc-fixture' > "$tmp/dirty/resources/shell-enhancements/powerlevel10k/internal/p10k.zsh.zwc"
git -C "$tmp/dirty" add resources/shell-enhancements/powerlevel10k/internal/p10k.zsh.zwc
check "a TRACKED .zwc is REFUSED" "$tmp/dirty" fail

# (iii) an UNTRACKED .zwc is invisible to the gate — pinned so nobody "fixes" case (ii) by planting
# an unstaged file and concluding the gate is broken. `git ls-files` is a tracked-file query by
# design; a build artefact nobody committed is not this gate's business.
new_repo "$tmp/untracked"
printf '\x00zwc-fixture' > "$tmp/untracked/resources/shell-enhancements/powerlevel10k/internal/p10k.zsh.zwc"
check "an UNTRACKED .zwc is ignored (git ls-files is tracked-only)" "$tmp/untracked" pass

if [ "$fails" -ne 0 ]; then
  echo "check-no-zwc.test: $fails case(s) failed." >&2
  exit 1
fi
echo "check-no-zwc.test: OK (3 cases)."
