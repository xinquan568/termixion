# Termixion themes — user theme files (trmx-89, FR-6)

Termixion ships six built-in themes (White, Paper, Mint, Sepia, Night, Solarized). You can also add
**your own themes** as TOML files — validated tolerantly, listed in Settings → Appearance, applied
live, and hot-reloaded while you edit them.

## Where theme files live

```
~/.config/termixion/themes/<id>.toml
```

(Or `$XDG_CONFIG_HOME/termixion/themes/` when `XDG_CONFIG_HOME` is set.) One file per theme. The
**file stem is the theme id**, namespaced internally as `user:<stem>` — so a file named `night.toml`
becomes `user:night` and coexists with the built-in **Night** without collision. Built-in themes can
never be shadowed by a user file.

The quickest way to get a working file: open **Settings → Appearance** and click **Duplicate** on any
built-in theme. That writes a complete `<builtin>-copy.toml` with every field spelled out and selects
it — edit it and watch the colors change live. **Open themes folder** (same page) reveals the
directory in your file manager, creating it on first use.

## The file format

A theme file mirrors Termixion's token schema. **Colors** are CSS strings: `#rgb`, `#rrggbb`,
`#rgba`, `#rrggbbaa`, `rgb(r, g, b)`, or `rgba(r, g, b, a)` (r/g/b are 0–255, a is 0–1).

### Required minimum

A valid theme MUST provide these — everything else is derived from them if omitted:

| Key | Meaning |
| --- | --- |
| `is_dark` | `true` for a dark theme, `false` for light (drives derivation direction and dark/light classification). |
| `color.bg.primary` | The window / terminal background. |
| `color.text.primary` | The primary foreground text. |
| `terminal.ansi.*` | All 16 ANSI colors: `black red green yellow blue magenta cyan white bright_black bright_red bright_green bright_yellow bright_blue bright_magenta bright_cyan bright_white`. |

A file missing any required field (or with an unparseable required color) is **listed but marked
invalid** in Settings — it is never applied, and never crashes the app.

### Optional fields (derived when omitted)

Provide any of these to override the derived default; omit them and Termixion fills them in from the
required set:

| Key | Derived from (when omitted) |
| --- | --- |
| `color.bg.secondary` / `color.bg.tertiary` | shaded from `bg.primary` (lighter if dark, darker if light) |
| `color.text.secondary` / `color.text.tertiary` | `text.primary` mixed toward `bg.primary` |
| `color.accent.primary` | `terminal.ansi.blue` |
| `color.accent.bg` | `accent.primary` at 12% alpha |
| `color.border` | `bg.primary` mixed toward `text.primary` |
| `color.selection` | `accent.primary` at 22% alpha |
| `color.semantic.error` / `error_bg` / `success` | `ansi.red` / `ansi.red` at 15% / `ansi.green` |
| `terminal.cursor` / `terminal.cursor_accent` | `text.primary` / `bg.primary` |
| `terminal.selection_background` | `accent.primary` at 22% alpha |
| `terminal.scrollbar.idle` / `hover` / `active` | white (dark) or black (light) at 12% / 20% / 30% |
| `terminal.pane.active_border` / `inactive_border` | `accent.primary` / `border` |
| `terminal.badge` | Termixion's badge pink `#ff8da1` (the per-pane [badge](badges.md) watermark, trmx-149) |

So a minimal ~20-line file (the required set only) is already a complete, working theme.

### A minimal example

See [`examples/mytheme.toml`](examples/mytheme.toml) — a commented, minimal file you can copy into
your themes folder. It provides only the required minimum; every other color is derived.

## Validation, warnings, and contrast

Validation is **tolerant** (the same philosophy as `termixion.toml`, trmx-80):

- An **unknown key** is ignored (a warning, not a failure) — forward-compatible with newer fields.
- A **bad optional color** is dropped (that field falls back to its derived value) with a warning.
- A **missing/invalid required field** makes the theme **invalid**: it is listed with an "invalid"
  badge (hover for the reason) and is not selectable until you fix the file.
- A **low-contrast** theme (body text hard to read against the background) still applies, but shows a
  non-blocking **warning** badge — your machine, your choice.

## Hot reload (the theme-designer loop)

While Termixion is running, changes to your themes folder apply immediately:

- **Edit the active theme's file** → colors update live (terminal, UI, scrollbar, pane borders).
- **Introduce an error** in the active file → the previous (last-good) colors stay and the "invalid"
  badge appears — you never get stuck looking at a broken theme.
- **Delete the active theme's file** → Termixion falls back to the OS-derived default and warns.
- **Drop a new valid file in** → it appears in Settings → Appearance without a restart.

Your selection persists across relaunches (stored as `appearance.theme = "user:<stem>"`); a selected
user theme survives a restart as long as its file is still present and valid.

## Scope

No theme marketplace or iTerm2 import (a possible future addition); no per-pane or per-tab themes.
A user theme changes the **palette**, not the app layout.
