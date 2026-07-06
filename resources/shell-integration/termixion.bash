# SPDX-License-Identifier: ISC
# Termixion shell integration for bash (trmx-99, FR-7b).
#
# Emits OSC 7 (cwd reporting) + OSC 133 / FTCS prompt markers so Termixion shows an ACCURATE activity
# line (exact command windows) with an exit-code failure flash — no process polling.
#
#   Install:  add  `source ~/.config/termixion/shell-integration/termixion.bash`  near the END of ~/.bashrc
#             (after other prompt tools, so it wraps them).
#
# Idempotent (safe to source repeatedly) and preserves your existing PROMPT_COMMAND and DEBUG trap. If
# bash-preexec is already loaded, we hook its arrays instead of touching PROMPT_COMMAND / the DEBUG trap.

# Re-source guard.
[[ -n "${__termixion_shell_integration:-}" ]] && return
__termixion_shell_integration=1

# Emit one OSC sequence terminated by ST (ESC \). \134 is octal for backslash.
__termixion_osc() { printf '\033]%s\033\134' "$1"; }

# Runs after each command, before the prompt. Capture $? FIRST so the D marker reports the real exit code.
__termixion_precmd() {
  local __ec=$?
  __termixion_osc "133;D;${__ec}"           # previous command finished (with exit code)
  __termixion_osc "7;file://${HOSTNAME}${PWD}"   # report cwd (OSC 7)
  __termixion_osc "133;A"                   # prompt start
  __termixion_osc "133;B"                   # command-input start
}

# Runs just before a user command executes → the command is now RUNNING.
__termixion_preexec() { __termixion_osc "133;C"; }

if [[ -n "${bash_preexec_imported:-}${__bp_imported:-}" ]]; then
  # bash-preexec is present — reuse its hook arrays. It owns all the DEBUG/PROMPT_COMMAND subtlety
  # (fire preexec exactly once per command, skip completion, restore $? for precmd), so we just append.
  precmd_functions+=(__termixion_precmd)
  preexec_functions+=(__termixion_preexec)
else
  # Standalone. The C detector is ARMED only at the very END of the prompt-command chain, so the DEBUG
  # trap never fires C while the prompt (our precmd + any existing PROMPT_COMMAND) is rendering — it fires
  # exactly once, for the next real command the user runs.
  __termixion_arm() { __termixion_armed=1; }
  __termixion_debug() {
    [[ -n "${COMP_LINE:-}" ]] && return       # skip tab-completion (DEBUG fires there too)
    [[ -n "${__termixion_armed:-}" ]] || return  # unset → inside the prompt chain / already fired
    __termixion_armed=""                      # fire once per command
    __termixion_preexec
  }
  # precmd runs FIRST (captures $?); __termixion_arm runs LAST (after any existing PROMPT_COMMAND).
  PROMPT_COMMAND="__termixion_precmd${PROMPT_COMMAND:+; ${PROMPT_COMMAND}}; __termixion_arm"

  # Chain any existing DEBUG trap (preserve its body), else install ours. `trap -p DEBUG` prints
  # `trap -- '<body>' DEBUG`; grep isolates that line from any output the prior trap emits, and the
  # `#*trap -- '` strip tolerates a leading noise line. When sourced from an interactive rc file the
  # existing trap is visible here (the same assumption bash-preexec makes); if none is found we install
  # ours cleanly.
  __termixion_prev_debug="$(trap -p DEBUG 2>/dev/null | grep -F 'trap -- ' | head -n1)"
  if [[ -n "${__termixion_prev_debug}" ]]; then
    __termixion_prev_debug="${__termixion_prev_debug#*trap -- \'}"
    __termixion_prev_debug="${__termixion_prev_debug%\' DEBUG}"
    # Intentional: expand the prior trap body NOW so it is embedded before ours (SC2064 is expected).
    # shellcheck disable=SC2064
    trap "${__termixion_prev_debug}; __termixion_debug" DEBUG
  else
    trap '__termixion_debug' DEBUG
  fi
fi
