#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion file line-budget ratchet (trmx-243, grill Add-on 5 / metric 8).
#
# trmx-243 split a 1969-line `main.rs` into five modules. Nothing stopped it growing to 1969 in the
# first place, and nothing would stop it happening again: every new handler lands in `main.rs` by
# default, and `App.tsx` grew the same way. The grill report asked for "a CI check that fails on
# growth of these two files"; this is it.
#
# It is a RATCHET, not a wall. Two responses to a failure are equally legitimate: split the file, or
# RAISE ITS BUDGET IN THE SAME PR with a one-line reason. A deliberate, visible, reviewed raise is
# the point — see docs/CONTRIBUTING.md. What the gate prevents is the silent drift that got us here.
#
# Budgets are the post-change ACTUAL plus a little headroom, never a round number: a budget far above
# the truth never fires, and one set at the truth fires on the next honest line. Lower them as the
# files shrink (trmx-248 / trmx-254 will lower App.tsx's).
#
# Only NON-TEST lines count, so a test-heavy PR is never punished. For a `.rs` file that means the
# body before the inline `#[cfg(test)]` module; for `App.tsx`, whose tests live in sibling
# `*.test.tsx` files, it is the whole file.
#
# Scope is deliberately these two files. A repo-wide line limit would be noise.
#
# Usage: check-file-budgets.sh [repo-dir]   (defaults to this script's repository)
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

# WATCHED: "<path>:<budget>". Keep the reason for each number next to it.
WATCHED=(
  # 439 non-test lines after the trmx-243 split (was 1969). +~9% headroom.
  "crates/termixion-tauri/src/main.rs:480"
  # 2597 lines after trmx-248 collapsed the fifteen per-pane ref containers (14 Maps + 1 Set) into
  # one PaneRuntime record. The file is 15 lines LONGER than the 2582 it started at: consolidating
  # the containers saved lines, but the two distinct writers (update-only vs create-then-write) and
  # the comment explaining why they are separate cost more. The budget still tightens, 2640 -> 2632,
  # because the point of a ratchet is that headroom only ever shrinks: 58 lines of slack become 35.
  # trmx-254 is where the number really falls, when the record moves out of App.tsx entirely.
  "app/src/App.tsx:2632"
)

# Non-test line count. For `.rs` this SKIPS each top-level `#[cfg(test)] mod … { … }` block and
# counts everything else; anything else counts every line.
#
# Not "stop at the first #[cfg(test)]": Rust permits ordinary items AFTER an inline test module, so
# a stop-at-first counter freezes at the pre-test count and every handler added below the test module
# is invisible. That is a gate going green because it stopped looking — the exact failure this whole
# script exists to prevent, one level up. Case (vi) of the self-test pins it.
#
# A `#[cfg(test)]` that is NOT followed by a `mod` line (e.g. a cfg-gated `use` or `fn`) is counted
# as ordinary content rather than opening a skip region: over-counting can only make the gate fire
# early, which a human then reads; under-counting hides growth silently.
nontest_lines() { # nontest_lines <file>
  case "$1" in
    *.rs)
      awk '
        # A top-level test module opens a skip region; brace-matching closes it.
        /^#\[cfg\(test\)\]/ { pending = 1; next }
        pending && /^mod / { pending = 0; intest = 1; depth = 0; opened = 0 }
        pending          { pending = 0 }            # cfg(test) on something else: count normally
        intest {
          o = gsub(/\{/, "{"); c = gsub(/\}/, "}")
          depth += o - c
          if (o > 0) opened = 1
          if (opened && depth <= 0) intest = 0
          next
        }
        { count++ }
        END { print count + 0 }
      ' "$1"
      ;;
    *) awk 'END { print NR }' "$1" ;;
  esac
}

fail=0
for entry in "${WATCHED[@]}"; do
  path="${entry%:*}"
  budget="${entry##*:}"

  # NOT a skip: a watched file the gate cannot read must fail closed. A rename or a move that drops
  # a file out of the gate's sight is exactly how a ratchet stops ratcheting.
  if [ ! -r "$path" ]; then
    echo "check-file-budgets: cannot read watched file '$path' in $ROOT — failing closed." >&2
    echo "    If the file moved, update the WATCHED table in this script in the same PR." >&2
    fail=1
    continue
  fi

  actual="$(nontest_lines "$path")"
  if [ "$actual" -gt "$budget" ]; then
    echo "check-file-budgets: OVER BUDGET — $path" >&2
    echo "    budget: $budget non-test lines" >&2
    echo "    actual: $actual non-test lines (+$((actual - budget)))" >&2
    cat >&2 <<'WHY'
    Two responses are legitimate, and the second is not a defeat:
      1. split the file — move a cohesive concern into its own module (trmx-243 is the worked
         example: main.rs went 1969 -> 439 across four new modules);
      2. raise the budget IN THIS PR, with a one-line reason beside the number in
         scripts/check-file-budgets.sh. A deliberate, reviewed raise is the point of a ratchet.
    What this gate stops is neither of those: growth nobody decided on.
WHY
    fail=1
  else
    echo "check-file-budgets: OK — $path at $actual/$budget non-test lines."
  fi
done

exit "$fail"
