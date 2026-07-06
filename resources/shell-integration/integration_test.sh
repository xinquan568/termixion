#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# trmx-99 (FR-7b): source-and-assert tests for the shell-integration snippets. Proves the load-bearing
# properties without a PTY: idempotency (re-source guard), existing-hook preservation, and — the review
# finding-4 case — that a command's exit status survives an existing PROMPT_COMMAND (captured $? first).
# Every OSC-emitting call is captured into a variable so nothing leaks to the real terminal.
# Run from the repo root: `bash resources/shell-integration/integration_test.sh`.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- bash ----------------------------------------------------------------------------------------
bash --noprofile --norc -c '
  set -u
  fail=0
  PROMPT_COMMAND="__user_hook"
  __user_hook() { __user_ran=1; }
  source "'"$DIR"'/termixion.bash"
  source "'"$DIR"'/termixion.bash"    # second source must be inert (the guard short-circuits)

  # (1) our precmd is PREPENDED and the existing PROMPT_COMMAND is preserved (never clobbered).
  [ "$PROMPT_COMMAND" = "__termixion_precmd; __user_hook" ] || { echo "FAIL bash preserve: $PROMPT_COMMAND"; fail=1; }

  # (2) the DEBUG trap is installed (a C-emitting preexec hook exists), then REMOVE it so it does not
  #     emit C on every subsequent test command (which would pollute the captured output).
  trap -p DEBUG | grep -q "__termixion_preexec" || { echo "FAIL bash debug-trap"; fail=1; }
  trap - DEBUG

  # (3) a command exit status survives (precmd captures $? FIRST) — capture the OSC so nothing leaks.
  out="$( (exit 1); __termixion_precmd )"
  case "$out" in *"133;D;1"*) : ;; *) echo "FAIL bash exit-status"; fail=1 ;; esac
  # a zero exit reports D;0 (no failure)
  out="$( (exit 0); __termixion_precmd )"
  case "$out" in *"133;D;0"*) : ;; *) echo "FAIL bash exit-zero"; fail=1 ;; esac

  [ "$fail" = 0 ] && echo "PASS bash"
' || exit 1

# ---- zsh (skip if unavailable) -------------------------------------------------------------------
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
