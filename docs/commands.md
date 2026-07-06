# Command reference (FR-9)

Every user-facing action is a named internal command (trmx-94). Open the **command palette** with
`⇧⌘P` to fuzzy-find and run any of them by keyboard, or rebind any chord in the `[keys]` table of
`termixion.toml` (see [config.md](config.md); `= "none"` unbinds a default). Commands ending in `…`
open a second picker (a theme / a script).

> This file is generated from the command registry — do not edit by hand. It is regenerated and
> diffed by `app/src/commands/commandDocs.test.ts` (run `WRITE_COMMAND_DOCS=1` on that test to update).

| Command ID | Title | Category | Default binding |
| ---------- | ----- | -------- | --------------- |
| `tab.new` | New Tab | Tabs | `cmd+t` |
| `tab.close` | Close Tab | Tabs | `cmd+w` |
| `tab.next` | Next Tab | Tabs | `cmd+shift+]` |
| `tab.prev` | Previous Tab | Tabs | `cmd+shift+[` |
| `tab.rename` | Rename Tab… | Tabs | — |
| `tab.new-with-script` | New Tab with Script… | Tabs | `cmd+shift+t` |
| `tab.select-1` | Select Tab 1 | Tabs | `cmd+1` |
| `tab.select-2` | Select Tab 2 | Tabs | `cmd+2` |
| `tab.select-3` | Select Tab 3 | Tabs | `cmd+3` |
| `tab.select-4` | Select Tab 4 | Tabs | `cmd+4` |
| `tab.select-5` | Select Tab 5 | Tabs | `cmd+5` |
| `tab.select-6` | Select Tab 6 | Tabs | `cmd+6` |
| `tab.select-7` | Select Tab 7 | Tabs | `cmd+7` |
| `tab.select-8` | Select Tab 8 | Tabs | `cmd+8` |
| `tab.select-9` | Select Tab 9 | Tabs | `cmd+9` |
| `pane.split-right` | Split Right | Panes | `cmd+d` |
| `pane.split-below` | Split Below | Panes | `cmd+shift+d` |
| `pane.split-right-with-script` | Split Right with Script… | Panes | — |
| `pane.split-below-with-script` | Split Below with Script… | Panes | — |
| `pane.close` | Close Pane | Panes | — |
| `pane.next` | Next Pane | Panes | `cmd+]` |
| `pane.prev` | Previous Pane | Panes | `cmd+[` |
| `pane.set-badge` | Set Badge… | Panes | `cmd+shift+b` |
| `pane.focus-left` | Focus Pane Left | Panes | `cmd+alt+left` |
| `pane.focus-right` | Focus Pane Right | Panes | `cmd+alt+right` |
| `pane.focus-up` | Focus Pane Up | Panes | `cmd+alt+up` |
| `pane.focus-down` | Focus Pane Down | Panes | `cmd+alt+down` |
| `pane.grow-left` | Grow Pane Left | Panes | — |
| `pane.grow-right` | Grow Pane Right | Panes | — |
| `pane.grow-up` | Grow Pane Up | Panes | — |
| `pane.grow-down` | Grow Pane Down | Panes | — |
| `terminal.clear-scrollback` | Clear Scrollback | Terminal | — |
| `theme.select` | Change Theme… | Appearance | — |
| `script.run` | Run Script… | Scripts | — |
| `app.command-palette` | Command Palette… | App | `cmd+shift+p` |
| `app.settings` | Settings… | App | `cmd+,` |
| `app.check-updates` | Check for Updates… | App | — |
| `window.close` | Close Window | App | `cmd+shift+w` |
