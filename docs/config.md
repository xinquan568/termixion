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
| `terminal.scrollback_lines` | `terminal.scrollbackLines` | integer | `10000` | `0`–`200000` (clamped) | immediate¹ |
| `terminal.font_family` | `terminal.fontFamily` | string | `""` | any font stack; `""` = platform default² | immediate (re-measure + refit) |
| `terminal.font_size` | `terminal.fontSize` | integer | `12` | `6`–`72` (clamped) | immediate (re-measure + refit) |
| `appearance.theme` | `appearance.theme` | string | derived³ | a theme id from the built-in catalog | immediate |
| `tabs.bar_position` | `tabs.barPosition` | string | `"bottom"` | `top` · `bottom` · `left` · `right` | immediate (the tab bar repositions live; terminals keep running) |

¹ Shrinking `scrollback_lines` truncates the existing scrollback buffer (xterm behavior) — history
beyond the new cap is discarded at apply time.

² The platform default stack is `ui-monospace, "SF Mono", Menlo, monospace` (the current macOS
system monospaced font at the front).

³ First launch derives the theme from the OS appearance (dark → `night`, light → `white`) and
writes it into the file ("derive once, then persist"). After that, the file value wins.

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
