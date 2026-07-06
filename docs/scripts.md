# Scripts (FR-5)

Termixion can keep a set of named shell scripts and run them into a fresh tab or split pane, or
source one automatically at startup. This is the *scripting & startup* feature (trmx-93).

## Where scripts live

Scripts are plain shell files under:

```
~/.config/termixion/scripts/
```

The **on-disk folder tree is the list** — there is no separate manifest to keep in sync. Group
scripts by putting them in subfolders; a script's identity is its path relative to the scripts root,
e.g. `work/proj-x.sh`. Open the folder from **Settings → Scripts → "Open scripts folder"**.

- The `.sh` extension is **optional** (recommended for clarity); any plain file is listed.
- **Nested folders** are the grouping mechanism and are discovered recursively.
- **Hidden entries** (names starting with `.`) and **non-file** entries are skipped.
- **Symlinks are not followed**, and discovery is bounded to a depth of **8** folders — a safety
  guardrail, not a limit you should ever hit in practice.

Edits to the folder are picked up live: dropping in, renaming, or deleting a script refreshes any
open picker and the Settings dropdown (a directory watcher emits `scripts:changed`).

## How a script "runs"

Running a script means: Termixion creates the surface (tab or pane) with your **normal login
shell** — all the usual cwd inheritance, titles, and OSC handling — waits for the session to open,
then sends, exactly as if you had typed it:

```sh
source '/absolute/path/to/your-script.sh'
```

It **sources** the script (rather than executing it as a subprocess) on purpose: the canonical use
case is "navigate somewhere and run a command", e.g.

```sh
cd ~/code/proj-x && git status
```

A `cd` (or an alias, a function, an exported variable) set by a sourced script **persists in the
interactive shell you keep using** — which would not happen if the script ran in a subshell. What
ran is visible in your scrollback (nothing is hidden), and the script path is single-quote-escaped,
so spaces, quotes, and unicode in filenames are safe.

There is no argument/templating support in this iteration (out of scope).

### Shell caveat (fish)

Sourcing uses POSIX `source`/`.`, which **zsh and bash** honor (the supported shells). If you have
changed your login shell to **fish**, `source` semantics differ and a bash/zsh-syntax script may not
behave as written — this is a documented limitation, not a bug.

## Running a script in a new surface

From the **Shell** menu:

- **New Tab with Script…** (⇧⌘T) — opens the script picker, then runs the chosen script in a new tab.
- **Split → Right with Script…** / **Split → Below with Script…** — run the chosen script in a new
  split pane (the new pane inherits the invoking pane's cwd *before* the script runs, so a script
  with no `cd` starts where you were).

The picker is keyboard-first: type to fuzzy-filter, ↑/↓ to move, **Enter** to run the highlighted
script, **Esc** (or a click outside) to cancel. (The FR-9 command palette will offer the same list.)

## Startup script

Set one script to run automatically in the **first tab** on a normal launch:

- **Settings → Scripts → "Run on launch"**, or the config key:

```toml
[scripts]
startup = "work/proj-x.sh"   # a path relative to ~/.config/termixion/scripts/; "" = none
```

Behavior:

- Runs **once**, in the first tab, on a normal app launch — **not** on later new tabs.
- **Fail-soft**: if the configured script is missing or does not match a discovered script, Termixion
  logs a warning and starts a plain shell — a bad value never blocks startup, and the value is only
  ever resolved through the same scripts-root discovery as the picker (it can't run a file outside
  the scripts tree).
- **Never** runs on the deterministic `--smoke` / `--perf` launches, so those stay reproducible.

See also [config.md](config.md) for the `[scripts]` key.
