# SPDX-License-Identifier: ISC
# Termixion shell integration for bash (trmx-99, FR-7b).
#
# Emits OSC 7 (cwd reporting) + OSC 133 / FTCS prompt markers so Termixion shows an ACCURATE activity
# line (exact command windows) with an exit-code failure flash — no process polling.
#
#   Install:  add  `source ~/.config/termixion/shell-integration/termixion.bash`  near the END of ~/.bashrc
#             (after other prompt tools, so it wraps them).
#
# Idempotent (safe to source repeatedly) and preserves your existing PROMPT_COMMAND and DEBUG trap.

# Re-source guard.
[[ -n "${__termixion_shell_integration:-}" ]] && return
__termixion_shell_integration=1

# Emit one OSC sequence terminated by ST (ESC \).
__termixion_osc() { printf '\033]%s\033\\' "$1"; }

# PROMPT_COMMAND runs after each command, before the prompt. Capture $? FIRST (this function is PREPENDED
# so it runs before any existing PROMPT_COMMAND) so the D marker reports the real command exit code.
__termixion_precmd() {
  local __ec=$?
  __termixion_osc "133;D;${__ec}"           # previous command finished (with exit code)
  __termixion_osc "7;file://${HOSTNAME}${PWD}"   # report cwd (OSC 7)
  __termixion_osc "133;A"                   # prompt start
  __termixion_osc "133;B"                   # command-input start
  __termixion_preexec_done=""               # re-arm the once-per-prompt C guard
}

# The DEBUG trap fires before EVERY simple command — including PROMPT_COMMAND's own body. Emit C exactly
# once per user command line, and never for the prompt hook itself.
__termixion_preexec() {
  # Skip while the prompt command runs, and during completion.
  [[ -n "${COMP_LINE:-}" ]] && return
  [[ "${BASH_COMMAND}" == "__termixion_precmd"* ]] && return
  [[ "${BASH_COMMAND}" == "${PROMPT_COMMAND}" ]] && return
  [[ -n "${__termixion_preexec_done:-}" ]] && return
  __termixion_preexec_done=1
  __termixion_osc "133;C"                   # command output start (running)
}

# PREPEND to PROMPT_COMMAND (capture $? first), preserving any existing value (it runs after ours).
PROMPT_COMMAND="__termixion_precmd${PROMPT_COMMAND:+; ${PROMPT_COMMAND}}"

# Chain the DEBUG trap: preserve the user's prior trap command (if any), then run ours.
__termixion_prev_debug="$(trap -p DEBUG)"
if [[ -n "${__termixion_prev_debug}" ]]; then
  # Extract the prior command from `trap -- '<cmd>' DEBUG` and chain it before ours.
  __termixion_prev_debug="${__termixion_prev_debug#trap -- \'}"
  __termixion_prev_debug="${__termixion_prev_debug%\' DEBUG}"
  trap "${__termixion_prev_debug}; __termixion_preexec" DEBUG
else
  trap '__termixion_preexec' DEBUG
fi
