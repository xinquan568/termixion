# Per-pane badges (trmx-90, FR-4)

A **badge** is a large, translucent watermark label floating in a pane's top-right corner — so a
glance tells you what each pane is for (a database name, an environment, a host). Badges are
**per-pane**: every pane (including a tab's single pane) carries its own. They are ephemeral
(session-lifetime, not persisted) and die with their pane.

## Setting a badge

Two ways, sharing one slot (last write wins; clearing from either path clears it):

### From the UI — ⇧⌘B

**Shell → Set Badge…** (or press **⇧⌘B**) opens a small inline editor on the focused pane:

- Type the badge text and press **Enter** to commit.
- An **empty** value clears the badge.
- **Esc** cancels.

Re-opening the editor on a pane that already has a badge seeds the input with it, so you can edit in
place.

### From a script — OSC 1337 `SetBadgeFormat` (iTerm2-compatible)

Termixion understands iTerm2's `SetBadgeFormat` escape sequence, so scripts and SSH sessions can
label their pane exactly as they do in iTerm2. The value is **base64-encoded**:

```sh
# Badge the current pane "DB PROD"
printf '\e]1337;SetBadgeFormat=%s\a' "$(printf 'DB PROD' | base64)"

# Clear it (empty payload)
printf '\e]1337;SetBadgeFormat=\a'
```

This round-trips over SSH / tmux passthrough. The sequence badges the pane it is printed in — run it
in a background pane and *that* pane gets the badge. Only `SetBadgeFormat` is implemented; every other
`OSC 1337` subcommand is silently ignored (compatible with iTerm2's large 1337 family).

**Deviation from iTerm2 — no format-variable interpolation.** iTerm2 interpolates variables like
`\(session.name)` inside a badge format. Termixion sets the **literal** text you provide (after
base64-decoding); it does not interpolate. Multi-line badges work (`\n`, up to two lines); other
control characters are stripped, and the text is capped at 256 characters.

## Appearance

The badge's color is the **`terminal.badge`** theme token — a translucent watermark that reads
without harming text legibility. Every built-in theme sets one; a user theme
(`~/.config/termixion/themes/<id>.toml`, see [themes.md](themes.md)) may set `terminal.badge`, and one
that omits it derives a subtle translucent tint of the theme's text color. The overlay is
non-interactive (it never intercepts terminal mouse events) and hides itself on very small panes.
