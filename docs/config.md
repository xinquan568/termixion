# Termixion configuration reference (trmx-80, FR-13)

Termixion's settings live in **one schema-validated TOML file**:

```
$XDG_CONFIG_HOME/termixion/termixion.toml      # when XDG_CONFIG_HOME is set and non-empty
~/.config/termixion/termixion.toml             # otherwise
```

This is the location terminal users expect (Kitty precedent) — deliberately **not** the Tauri
app-data directory. The file is created lazily on the first write (first launch materializes the
OS-derived theme; any Settings-window change also creates it) from a fully-commented template whose
header links back to this document.

The file is the **single source of truth** for every user-visible setting:

- **Hand edits apply live.** A watcher (250 ms debounce, rename-safe) re-parses the file on change
  and applies each changed key to the running app immediately — same plumbing as flipping the
  control in Settings.
- **The Settings window writes through.** UI changes are written back into the file, preserving
  your comments and key order.
- **Last write wins.** The file and the UI write the same file; there is no second "profiles"
  layer.

## Keys

Every key is optional; a missing key keeps its built-in default. TOML keys are `snake_case` inside
tables; internally each maps 1:1 to a camelCase registry key (the mapping is owned by
`termixion-core::config` — `toml_path_for`).

| TOML key | Registry key | Type | Default | Allowed | Live-apply |
| -------- | ------------ | ---- | ------- | ------- | ---------- |
| `update.auto_check` | `update.autoCheck` | bool | `true` | — | next check cycle |
| `update.check_frequency` | `update.checkFrequency` | string | `"on-startup"` | `on-startup` · `daily` · `weekly` · `manual` | next check cycle |
| `update.auto_download` | `update.autoDownload` | bool | `true` | — | next check cycle |
| `terminal.cursor_style` | `terminal.cursorStyle` | string | `"underline"` | `bar` · `block` · `underline` | immediate |
| `terminal.cursor_blink` | `terminal.cursorBlink` | bool | `false` | — | immediate |
| `terminal.activity_indicator` | `terminal.activityIndicator` | bool | `true` | — | immediate⁴ |
| `terminal.copy_on_select` | `terminal.copyOnSelect` | bool | `true` | — | immediate (attaches/detaches per pane)⁶ |
| `terminal.scrollback_lines` | `terminal.scrollbackLines` | integer | `10000` | `0`–`200000` (clamped) | immediate¹ |
| `terminal.font_family` | `terminal.fontFamily` | string | `""` | any font stack; `""` = platform default² | immediate (re-measure + refit) |
| `terminal.font_size` | `terminal.fontSize` | integer | `12` | `6`–`72` (clamped) | immediate (re-measure + refit) |
| `appearance.theme` | `appearance.theme` | string | derived³ | a theme id from the built-in catalog | immediate |
| `tabs.bar_position` | `tabs.barPosition` | string | `"bottom"` | `top` · `bottom` · `left` · `right` | immediate (the tab bar repositions live; terminals keep running) |
| `tabs.side_label_orientation` | `tabs.sideLabelOrientation` | string | `"horizontal"` | `horizontal` · `vertical` | immediate (applies only when the bar is `left`/`right`; the value persists across moves and re-applies) |
| `scripts.startup` | `scripts.startup` | string | `""` | a script path relative to the scripts root, e.g. `"work/proj-x.sh"`; `""` = none⁵ | next launch (sourced in the first tab) |

¹ Shrinking `scrollback_lines` truncates the existing scrollback buffer (xterm behavior) — history
beyond the new cap is discarded at apply time.

² The platform default stack is `ui-monospace, "SF Mono", Menlo, monospace` (the current macOS
system monospaced font at the front).

³ First launch derives the theme from the OS appearance (dark → `night`, light → `white`) and
writes it into the file ("derive once, then persist"). After that, the file value wins.

⁴ The activity indicator (the green line shown while a command runs) — see
[activity-indicator.md](activity-indicator.md) for how detection works and its documented limits. For an
**accurate** indicator (exact command windows + an exit-code failure flash), install the optional OSC 133
shell integration (Settings → Terminal → Shell integration → "Reveal snippets"; trmx-99/FR-7b) — no config
key, it upgrades per session automatically when the shell emits the markers.

⁵ The startup script is **sourced** in the first tab on launch (a `cd`/alias/env it sets persists in
that shell). A missing or unmatched value warns and starts a plain shell — never a blocked launch;
never runs on the `--smoke`/`--perf` deterministic launches. See [scripts.md](scripts.md).

⁶ Copy-on-select (trmx-95, FR-8): a completed mouse selection is copied to the clipboard on release,
iTerm2-style — no ⌘C needed, byte-identical to ⌘C. An empty/collapsed selection never overwrites the
clipboard. With it on, ⌘C still works and an app's OSC 52 write can land in between — **last write
wins**, matching iTerm2. Toggling it live attaches/detaches the listeners per pane (no restart).

## `[keys]` — keybindings (trmx-94, FR-9)

Unlike the tables above, `[keys]` is an **open map** of chord → command id, so you can rebind (or
unbind) any shortcut. It applies **live** (the file watcher rebuilds the effective keymap without a
restart; native menu accelerators update on next launch).

```toml
[keys]
"cmd+shift+enter" = "pane.split-below"   # rebind a command to a new chord
"cmd+9" = "none"                          # unbind a default ("none")
```

- The **command ids** and their **default bindings** are listed in [commands.md](commands.md) (generated
  from the registry). Open the **command palette** with `⇧⌘P` to run any command by keyboard.
- **Chord syntax**: `cmd`/`meta`, `ctrl`, `alt`/`option`, `shift` + a key (letter, digit, or a named
  key like `left`/`enter`/`space`), modifier-order-insensitive — e.g. `"shift+cmd+p"` ≡ `"cmd+shift+p"`.
- **Rules** (each warns, never fails): a binding must include `cmd` (terminal keys stay the PTY's);
  `⌘C`/`⌘V` are reserved for copy/paste and cannot be rebound; an invalid chord or a duplicate (last
  wins) surfaces a warning.

## Tolerant parsing & warnings

The parser **never fails hard**:

- A TOML **syntax error** keeps all defaults and reports one warning.
- An **unknown key or table** is ignored (forward/backward compatibility across versions) and
  reported.
- A **wrong-typed or unknown enum value** falls back to that key's default and is reported with
  what was found and what was expected.
- An **out-of-range number** (`scrollback_lines`, `font_size`) is clamped into range and reported.
- Numbers are **integers only** — a fractional value (e.g. `12.5`) is invalid at every layer and is
  **strictly rejected**, never rounded: the file parser treats it as a wrong-typed value (default +
  warning), the settings UI's number fields refuse to commit it, and a programmatic write with a
  fractional value is dropped whole (no file write, no live broadcast).
- An **unknown theme id** falls back to the derived default (the theme catalog is validated by the
  app, not the core parser, so future user themes stay possible).

Warnings surface as a banner in the Settings window — a typo'd hand edit degrades loudly to a
default, never silently loses a setting and never crashes the app.

## Notes

- **`update.lastCheckAt` is not a setting.** The timestamp of the last update check is internal
  bookkeeping and intentionally stays out of the hand-editable config file (it remains in
  webview-local storage). Everything user-visible lives in the file.
- **Migration.** A pre-v0.0.5 profile (settings in browser localStorage) is migrated on the first
  launch where no config file exists: values are written into the file, then the legacy keys are
  removed. If a config file already exists, it wins and the legacy keys are left alone.
- **Concurrent writers.** Writes are atomic (same-directory temp file + rename), so the file never
  tears; simultaneous writers resolve as last-write-wins.
- **Open the file from the app**: Settings → About → Configuration → "Open config file".
