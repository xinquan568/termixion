# Bundled terminal fonts (trmx-204)

Five fixed-advance ("Nerd Font Mono") families, Regular + Bold, served to the webview via
`@font-face` (`app/src/fonts.css`) so the terminal has glyph-complete fonts with no OS-level
font installation. The CSS-facing family names are declared by `fonts.css` / `fontCatalog.ts`
and intentionally differ from some archives' internal name-table entries (nerd-fonts v3 uses
abbreviated "NFM" names internally).

| Directory | CSS family | Upstream source | License |
| --- | --- | --- | --- |
| `sauce-code-pro/` | SauceCodePro Nerd Font Mono | nerd-fonts v3.4.0 `SourceCodePro.tar.xz` | SIL OFL 1.1 |
| `jetbrains-mono/` | JetBrainsMono Nerd Font Mono | nerd-fonts v3.4.0 `JetBrainsMono.tar.xz` | SIL OFL 1.1 |
| `meslo-lgs/` | MesloLGS NF | romkatv/powerlevel10k-media (master, 2026-07-21) | Apache 2.0 (Meslo LG) |
| `hack/` | Hack Nerd Font Mono | nerd-fonts v3.4.0 `Hack.tar.xz` | MIT + Bitstream Vera |
| `fira-code/` | FiraCode Nerd Font Mono | nerd-fonts v3.4.0 `FiraCode.tar.xz` | SIL OFL 1.1 |

Conversion: upstream `.ttf` → `.woff2` with `fonttools ttLib.woff2 compress`
(fonttools via `uvx --from "fonttools[woff]"`, 2026-07-21). Each directory carries its family's
license file as shipped upstream (Meslo: canonical Apache-2.0 text; the Meslo LG project does not
ship a standalone license file alongside the MesloLGS NF binaries).

Committed size: ~11 MB total (~1.0–1.2 MB per weight; Nerd Font patching adds ~9k icon glyphs
per face). Accepted trade-off recorded in the trmx-204 run (operator decision, 2026-07-21).

Note: FiraCode's programming ligatures are NOT rendered by the terminal — xterm.js's WebGL
renderer has no ligature support; the face renders as a normal monospace font.
