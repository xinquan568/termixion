#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# trmx-99 (FR-7b): source-and-assert tests for the shell-integration snippets. Proves the load-bearing
# properties without a PTY: idempotency, existing-hook preservation, $?-capture, the arm-at-end C detector
# (no spurious C during the prompt chain — review finding 1), robust DEBUG-trap chaining (review finding 2),
# and the bash-preexec integration path. Run from the repo root:
#   bash resources/shell-integration/integration_test.sh
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- bash: standalone (no prior DEBUG trap), armed-C logic + PROMPT_COMMAND preservation --------------
bash --noprofile --norc -c '
  set -u
  fail=0
  tmp="$(mktemp)"
  PROMPT_COMMAND="__user_hook"
  __user_hook() { :; }
  source "'"$DIR"'/termixion.bash"
  source "'"$DIR"'/termixion.bash"    # second source must be inert (guard)

  # precmd PREPENDED + arm APPENDED + the existing PROMPT_COMMAND preserved in the middle.
  [ "$PROMPT_COMMAND" = "__termixion_precmd; __user_hook; __termixion_arm" ] \
    || { echo "FAIL preserve: $PROMPT_COMMAND"; fail=1; }

  # Remove the DEBUG trap so it does not fire (and clear the C detector) during the direct calls below.
  trap - DEBUG

  # $? survives (precmd captures it first).
  out="$( (exit 1); __termixion_precmd )"
  case "$out" in *"133;D;1"*) : ;; *) echo "FAIL exit-status"; fail=1 ;; esac

  # The C detector fires ONLY when armed, exactly once, and never during completion.
  __termixion_armed=""; __termixion_debug > "$tmp"; [ -s "$tmp" ] && { echo "FAIL C-when-unarmed"; fail=1; }
  __termixion_armed=1;  __termixion_debug > "$tmp"; grep -q "133;C" "$tmp" || { echo "FAIL C-armed"; fail=1; }
  __termixion_debug > "$tmp"; [ -s "$tmp" ] && { echo "FAIL C-refire (armed not cleared)"; fail=1; }
  __termixion_armed=1; COMP_LINE=x __termixion_debug > "$tmp"; [ -s "$tmp" ] && { echo "FAIL C-during-completion"; fail=1; }

  rm -f "$tmp"
  [ "$fail" = 0 ] && echo "PASS bash-standalone"
' || exit 1

# ---- bash: chains an EXISTING DEBUG trap (review finding 2) -------------------------------------------
# `set -T` (functrace) makes the existing DEBUG trap visible to the sourced snippet's `trap -p DEBUG` —
# the condition that holds when the snippet is sourced from an interactive rc file. Without it a
# non-interactive `bash -c` hides the trap from a sourced scope (a harness artifact, not a snippet bug).
bash --noprofile --norc -c '
  set -u -T
  __prior_ran=0
  trap "__prior_ran=1" DEBUG
  source "'"$DIR"'/termixion.bash"
  d="$(trap -p DEBUG)"
  trap - DEBUG          # stop it firing during the direct checks below
  fail=0
  case "$d" in *"__termixion_debug"*) : ;; *) echo "FAIL chain-missing-ours"; fail=1 ;; esac
  case "$d" in *"__prior_ran=1"*) : ;; *) echo "FAIL chain-dropped-prior"; fail=1 ;; esac
  # Prove BEHAVIOUR, not just trap text: invoke the composed trap body while armed → the prior body runs
  # AND our detector emits C (the review-finding-2 gap). sq is a single quote (built via printf so no
  # literal quote appears inside this single-quoted here-string).
  sq="$(printf "\x27")"
  body="${d#trap -- "$sq"}"; body="${body%"$sq" DEBUG}"
  cf="$(mktemp)"; __prior_ran=0; __termixion_armed=1
  eval "$body" > "$cf"
  grep -q "133;C" "$cf" || { echo "FAIL chain-no-C-emitted"; fail=1; }
  [ "$__prior_ran" = 1 ] || { echo "FAIL chain-prior-body-not-run"; fail=1; }
  rm -f "$cf"
  [ "$fail" = 0 ] && echo "PASS bash-debug-chain"
' || exit 1

# ---- bash: integrates with bash-preexec when present (no PROMPT_COMMAND / DEBUG takeover) -------------
bash --noprofile --norc -c '
  set -u
  bash_preexec_imported=1
  declare -ag precmd_functions=() preexec_functions=()
  pc_before="${PROMPT_COMMAND:-}"
  trap ": BP_TRAP" DEBUG
  source "'"$DIR"'/termixion.bash"
  fail=0
  [[ " ${precmd_functions[*]} " == *" __termixion_precmd "* ]]  || { echo "FAIL bp-precmd"; fail=1; }
  [[ " ${preexec_functions[*]} " == *" __termixion_preexec "* ]] || { echo "FAIL bp-preexec"; fail=1; }
  [ "${PROMPT_COMMAND:-}" = "$pc_before" ] || { echo "FAIL bp-prompt-touched: ${PROMPT_COMMAND:-}"; fail=1; }
  case "$(trap -p DEBUG)" in *"BP_TRAP"*) : ;; *) echo "FAIL bp-trap-touched"; fail=1 ;; esac
  [ "$fail" = 0 ] && echo "PASS bash-preexec"
' || exit 1

# ---- zsh (skip if unavailable) -----------------------------------------------------------------------
if command -v zsh >/dev/null 2>&1; then
  zsh -f -c '
    fail=0
    typeset -ag precmd_functions
    __user_precmd() { : }
    precmd_functions=(__user_precmd)
    source "'"$DIR"'/termixion.zsh"
    source "'"$DIR"'/termixion.zsh"   # inert (guard)
    [[ "${precmd_functions[1]}" == "__termixion_precmd" ]] || { echo "FAIL zsh prepend"; fail=1 }
    (( ${precmd_functions[(I)__user_precmd]} )) || { echo "FAIL zsh preserve"; fail=1 }
    out="$( (exit 1); __termixion_precmd )"
    case "$out" in *"133;D;1"*) : ;; *) echo "FAIL zsh exit-status"; fail=1 ;; esac
    (( fail == 0 )) && echo "PASS zsh"
  ' || exit 1
else
  echo "skip zsh (not installed)"
fi
