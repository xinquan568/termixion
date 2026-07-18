# Termixion

A terminal suitable for personal use — a desktop terminal emulator for **macOS (Apple silicon)**,
built with Tauri 2 and a React + xterm.js front end on a pure-Rust core.

Tabs and split panes, six built-in themes (plus your own as TOML files), per-pane badges, an iTerm2-style
activity indicator, named scripts, a command palette (`⇧⌘P`), in-pane search (`⌘F`), and an opt-in
scriptable remote-control socket.

> **Status: alpha (0.0.x).** Builds are unsigned personal-alpha artifacts; features and defaults still
> move quickly. The user-facing history lives in the [changelog](CHANGELOG.md).

## Install

Download the artifacts for the latest release from the
[Releases page](https://github.com/xinquan568/termixion/releases). Details beyond this quickstart
(artifact verification, signing modes, the update manifest) are in the
[release runbook](docs/RELEASE.md).

### macOS (Apple silicon)

1. Download `Termixion_<version>_aarch64.dmg`, open it, and copy `Termixion.app` to `/Applications`.
2. Alpha builds are **not Apple-signed**, so Gatekeeper blocks the first launch. Approve it once,
   either way:
   - launch it, then allow it under **System Settings → Privacy & Security → "Open Anyway"**, or
   - clear the quarantine flag from a terminal:

     ```sh
     xattr -d com.apple.quarantine /Applications/Termixion.app
     ```

> **Linux:** Termixion is **macOS-only since v0.1.1** (trmx-187). v0.1.0 and earlier keep their
> Linux artifacts on the Releases page, but Linux installs no longer receive updates.

### Updates

Termixion updates itself in-app; every update artifact is signature-verified against the project's
updater key — even though the alpha app itself is unsigned. Details in the
[release runbook](docs/RELEASE.md).

## First run — going further

| Doc | What it covers |
| --- | -------------- |
| [Configuration](docs/config.md) | the single schema-validated TOML settings file |
| [Commands & keybindings](docs/commands.md) | every action by id, the `⇧⌘P` palette, rebinding chords |
| [Themes](docs/themes.md) | the six built-ins and writing your own theme files |
| [Remote control](docs/remote-control.md) | the opt-in `ctl` socket for scripting the running terminal |
| [Scripts](docs/scripts.md) | named shell scripts run into tabs/panes, startup sourcing |
| [Badges](docs/badges.md) | per-pane watermark labels |
| [Activity indicator](docs/activity-indicator.md) | the running-command indicator line |

## Contributing

Toolchain pins, build gates, and workflow live in the
[contributing guide](docs/CONTRIBUTING.md); architecture rules are under `.claude/rules/`.

## License

[ISC](LICENSE). Third-party notices: [THIRD_PARTY.md](THIRD_PARTY.md).
