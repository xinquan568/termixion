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

The process-group method **cannot see** (the **Fixed by FR-7b** column = with OSC 133 shell integration
installed, §"FR-7b" below):

| Case | Why | Result | Fixed by FR-7b |
| --- | --- | --- | --- |
| Shell **builtins that don't fork** (`while :; do :; done`, a builtin `sleep` on shells that have one, pure-shell loops) | No child process becomes the foreground leader — the shell stays the leader | **No line** even though the shell is working | ✅ — `C`→`D` marks the exact command window regardless of forking |

And it **misreads**:

| Case | Why | Result | Fixed by FR-7b |
| --- | --- | --- | --- |
| **Interactive foreground programs** (`vim`, `less`, a REPL) sitting idle | An open editor *is* a running foreground process | **Line stays on** while you sit in `vim` — matches iTerm2's method; arguably correct | ✅ — the line clears at `D` when the program exits (the prompt returns) |
| **Pipelines** (`a \| b \| c`) | The group leader may not be the process actually doing the work | Busy is reported (correct that *something* runs), but "which command" is not known | ✅ — one `C`→`D` window per whole command line (exact busy span) |
| **Remote work over `ssh`** | `ssh` is the foreground process the whole session | **Line stays on** for the whole SSH session — arguably correct (you *are* running something) | ⚠️ — only if the REMOTE shell also has the integration installed; otherwise stays on the poll source |
| **Commands shorter than the ~250 ms poll tick** (also below the 150 ms show floor) | The flip is never sampled / is debounced away | **No line** — deliberate, avoids flicker | ➖ — still debounced by the 150 ms show floor (by design, avoids flicker) |

These are inherent to detecting activity without the shell's help. They are not bugs. With OSC 133 installed
per session, the ones above marked ✅ are fixed; a failed command additionally **flashes** the line in the
theme's error color for ~600 ms (a subtle non-zero-exit cue the poll method could never provide).

## FR-7b — the accurate successor (v0.0.9)

FR-7b adds **OSC 133** shell-integration support: when the shell emits prompt/command markers, Termixion
knows exactly when a command starts and ends (and its exit status). FR-7b fixes the class of errors
that shell cooperation can fix (non-forking builtins, "which command", precise timing) and **takes over
per-session** the instant ANY valid OSC 133 marker is seen — falling back to the process-group method for
sessions without integration. The indicator itself (the line, the debounce, the setting) is unchanged;
only the detection *source* swaps (`poll` → `osc133`) per session — plus the new **exit-code flash**.

### Installing the shell integration (manual, per the conservative decision)

Termixion **does not edit your rc files**. Install it yourself in two steps:

1. **Settings → Terminal → Shell integration → "Reveal snippets"** — this writes `termixion.zsh` and
   `termixion.bash` to `~/.config/termixion/shell-integration/` and opens the folder.
2. Add ONE line near the **end** of your rc file (after other prompt tools like Starship / oh-my-zsh, so
   it wraps them):
   - `~/.zshrc`: `source ~/.config/termixion/shell-integration/termixion.zsh`
   - `~/.bashrc`: `source ~/.config/termixion/shell-integration/termixion.bash`

The snippets emit OSC 7 (cwd) + OSC 133 (prompt markers), are idempotent (safe to re-source), and preserve
your existing `precmd`/`preexec` (zsh) and `PROMPT_COMMAND`/`DEBUG` trap (bash) — they chain, never clobber.
Open a new shell and run `false` — the activity line should flash red briefly. (Only `zsh` and `bash` ship
snippets today; fish and others can come later.)

Automatic per-session injection (no manual `source`) is a possible post-Beta enhancement, not built now.
