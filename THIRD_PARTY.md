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

### Vendored zsh enhancement plugins (trmx-206/trmx-207 — code copied verbatim)

Four upstream plugins are vendored under `resources/shell-enhancements/` and embedded in the app
binary, materialized per-version at spawn time. Unlike the theme palettes above, this is **third-party
code**, executed in the user's shell.

| Plugin | Upstream | Tag | Release archive sha256 | License |
|---|---|---|---|---|
| `zsh-autosuggestions/` | [zsh-users/zsh-autosuggestions](https://github.com/zsh-users/zsh-autosuggestions) | `v0.7.1` | `0df7affff21cd87ed298e6a3970ed08a1dd66a6efa676454ee5b091ad503badf` | MIT |
| `zsh-syntax-highlighting/` | [zsh-users/zsh-syntax-highlighting](https://github.com/zsh-users/zsh-syntax-highlighting) | `0.8.0` | `5981c19ebaab027e356fe1ee5284f7a021b89d4405cc53dc84b476c3aee9cc32` | BSD-3-Clause |
| `powerlevel10k/` | [romkatv/powerlevel10k](https://github.com/romkatv/powerlevel10k) | `v1.20.0` | `d8187d44b697b3a37a8c4896678b4380e717cbf2850179529358348780a2d3d7` | MIT |
| `pure/` | [sindresorhus/pure](https://github.com/sindresorhus/pure) | `v1.23.0` | `b316fe5aa25be2c2ef895dcad150248a43e12c4ac1476500e1539e2d67877921` | MIT |

**What the hash does and does not establish** (trmx-240). It is the sha256 of the upstream release
archive (`codeload.github.com/<repo>/tar.gz/refs/tags/<tag>`) and identifies **which release** each
subtree was taken from. It does **not** verify the vendored bytes: every tree here is a deliberate
subset — powerlevel10k in particular ships no gitstatusd binaries, no configuration wizard and no
installer scripts — so no single hash can both name the release and match what is committed.
Reproducible subset extraction would be a separate mechanism; it does not exist today. **The tag is
the durable identifier**: GitHub's auto-generated archives are not guaranteed byte-stable forever.

**No compiled wordcode is vendored** (trmx-240, grill L14). The tree previously carried eight `.zwc`
files (996 KB) under `powerlevel10k/`. zsh loads a `.zwc` in preference to the `.zsh` beside it, so
the opaque blob — not the reviewable source — was what executed. powerlevel10k compiles its own on
first load; `scripts/check-no-zwc.sh` (CI) keeps them out.

## Record format (use when something is copied)

- **Copied ClauDepot file (ISC):** record the source path, the **commit hash** it was taken at, and
  **preserve its ISC copyright/license notice** verbatim in the copied file.
- **P1 theme palette (ClauDepot, ISC — Q-d/Q-f):** record the **ClauDepot release version** and the
  **actual color values** taken (no commit-hash pin required). Kitty is a *visual reference only*
  (GPL — clean-room; never copy its theme source).
- **MIT/BSD/Apache-2.0 code:** permitted with attribution recorded here.
- **GPL code (iTerm2, Kitty, …):** never copied — re-implement from spec (clean-room).
