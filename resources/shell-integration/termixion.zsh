# SPDX-License-Identifier: ISC
# Termixion shell integration for zsh (trmx-99, FR-7b).
#
# Emits OSC 7 (cwd reporting) + OSC 133 / FTCS prompt markers so Termixion shows an ACCURATE activity
# line (exact command windows) with an exit-code failure flash — no process polling.
#
#   Install:  add  `source ~/.config/termixion/shell-integration/termixion.zsh`  near the END of ~/.zshrc
#             (after other prompt tools such as Starship / oh-my-zsh, so it wraps them).
#
# Idempotent (safe to source repeatedly) and preserves your existing precmd/preexec hooks.

# Re-source guard.
[[ -n "${__termixion_shell_integration:-}" ]] && return
__termixion_shell_integration=1

# Emit one OSC sequence terminated by ST (ESC \).
__termixion_osc() { printf '\033]%s\033\\' "$1"; }

# precmd runs after each command, before the prompt. Capture $? FIRST (before anything clobbers it) so the
# D marker reports the real command exit code (which drives Termixion's failure flash).
__termixion_precmd() {
  local __ec=$?
  __termixion_osc "133;D;${__ec}"       # previous command finished (with exit code)
  __termixion_osc "7;file://${HOST}${PWD}"  # report cwd (OSC 7)
  __termixion_osc "133;A"               # prompt start
  __termixion_osc "133;B"               # command-input start
}

# preexec runs just before a command executes → the command is now RUNNING.
__termixion_preexec() { __termixion_osc "133;C"; }

# PREPEND to the hook arrays so our precmd sees the command's real $? before other hooks run, while
# preserving (never clobbering) any existing precmd/preexec functions — they still run, just after ours.
typeset -ag precmd_functions preexec_functions
precmd_functions=(__termixion_precmd ${precmd_functions[@]})
preexec_functions=(__termixion_preexec ${preexec_functions[@]})
