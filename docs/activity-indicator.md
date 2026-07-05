# Activity indicator (trmx-91, FR-7a)

While a command is running in a pane, Termixion draws a subtle **animated green line across the top
edge of that pane** (iTerm2's activity indicator). Every pane shows its own line, so three panes
compiling at once show three lines. A busy **background** tab also shows a small dot in the tab strip.

Toggle it in **Settings → Terminal → Activity Indicator** (default **on**), or set
`terminal.activity_indicator` in `~/.config/termixion/termixion.toml` (see [config.md](config.md)).

## How detection works (the process-group method)

A pane is considered **busy** when its terminal's **foreground process-group leader is not the shell
itself** — i.e. the shell has handed the terminal to a child command. The backend polls this every
**250 ms** (so the line appears and clears almost instantly) and emits a change-only event; the
frontend debounces it: the line only appears after a command has run for **≥ 150 ms** (so an instant
`ls` never flashes) and, once shown, stays for **≥ 300 ms** (so rapid short jobs don't strobe).

This is a **cheap, universal** signal — it needs no shell cooperation and works over SSH, in any
shell — but it is **approximate by design**. It ships now (FR-7a); the accurate version (FR-7b, below)
supersedes it per-session later.

## Documented limits

The process-group method **cannot see**:

| Case | Why | Result |
| --- | --- | --- |
| Shell **builtins that don't fork** (`while :; do :; done`, a builtin `sleep` on shells that have one, pure-shell loops) | No child process becomes the foreground leader — the shell stays the leader | **No line** even though the shell is working |

And it **misreads**:

| Case | Why | Result |
| --- | --- | --- |
| **Interactive foreground programs** (`vim`, `less`, a REPL) sitting idle | An open editor *is* a running foreground process | **Line stays on** while you sit in `vim` — matches iTerm2's method; arguably correct |
| **Pipelines** (`a \| b \| c`) | The group leader may not be the process actually doing the work | Busy is reported (correct that *something* runs), but "which command" is not known |
| **Remote work over `ssh`** | `ssh` is the foreground process the whole session | **Line stays on** for the whole SSH session — arguably correct (you *are* running something) |
| **Commands shorter than the ~250 ms poll tick** (also below the 150 ms show floor) | The flip is never sampled / is debounced away | **No line** — deliberate, avoids flicker |

These are inherent to detecting activity without the shell's help. They are not bugs.

## FR-7b — the accurate successor (v0.0.9)

FR-7b adds **OSC 133** shell-integration support: when the shell emits prompt/command markers, Termixion
knows exactly when a command starts and ends (and its exit status). FR-7b fixes the class of errors
that shell cooperation can fix (non-forking builtins, "which command", precise timing) and **takes over
per-session** whenever OSC 133 markers are present — falling back to this process-group method
otherwise. The indicator itself (the line, the debounce, the setting) is unchanged; only the detection
*source* swaps (`poll` → `osc133`) per session.
