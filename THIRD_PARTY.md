# Third-party notices

Termixion is licensed **ISC** (see `LICENSE`). This file records any third-party code or assets
incorporated into the repo, per the authority plan §7.5.

## Status

### Theme palettes (trmx-201 — color values only, no code copied)

Six community color palettes are incorporated as built-in themes under
`app/src/theme/themes/` (color values transcribed into Termixion's `ThemeTokens` shape; each
module's header pins the upstream commit and lists any audited legibility deviation per
`docs/design/visual-baseline.md` §4):

| Theme(s) | Upstream | Commit | License |
|---|---|---|---|
| Catppuccin Mocha, Catppuccin Latte | [catppuccin/catppuccin](https://github.com/catppuccin/catppuccin) | `3376efaebc3e` | MIT |
| Dracula | [dracula/dracula-theme](https://github.com/dracula/dracula-theme) | `c988d3d1c9e4` | MIT |
| Gruvbox (dark, medium) | [morhetz/gruvbox](https://github.com/morhetz/gruvbox) | `5d15b2765f59` | MIT/X11 |
| Nord | [nordtheme/nord](https://github.com/nordtheme/nord) | `1cef71605416` | MIT |
| Tokyo Night (night style) | [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) | `cdc07ac78467` | Apache-2.0 |

## Record format (use when something is copied)

- **Copied ClauDepot file (ISC):** record the source path, the **commit hash** it was taken at, and
  **preserve its ISC copyright/license notice** verbatim in the copied file.
- **P1 theme palette (ClauDepot, ISC — Q-d/Q-f):** record the **ClauDepot release version** and the
  **actual color values** taken (no commit-hash pin required). Kitty is a *visual reference only*
  (GPL — clean-room; never copy its theme source).
- **MIT/BSD/Apache-2.0 code:** permitted with attribution recorded here.
- **GPL code (iTerm2, Kitty, …):** never copied — re-implement from spec (clean-room).
