# The Termixion visual baseline (FR-3.6, locked at v0.0.4 — trmx-77)

This document is the **locked visual reference** for Termixion's single-pane look. Every later
surface builds on it: split panes (v0.0.6) consume the same tokens; the theming system (v0.0.7)
extends the catalog **without touching the contract below**. Changes to anything this document
pins require a new issue that amends this document in the same PR.

## 1. What the baseline IS

The canonical baseline is the **iTerm2 default profile** (a fresh install's out-of-box look),
carried by the non-color option set at the single `new Terminal(...)` chokepoint
(`app/src/terminal/TerminalView.tsx` → `realDeps.createTerminal`), plus Termixion's six-theme
color catalog:

| Fact | Value | Source | Pinned by |
|---|---|---|---|
| Font family | macOS system monospace (`ui-monospace` → SF Mono), fallbacks "SF Mono", Menlo, monospace | `iterm2Theme.ts` (trmx-46) | `iterm2Theme.test.ts`, `realDeps.test.ts` |
| Font size | 12 pt | iTerm2 DefaultBookmark (trmx-44) | same |
| Cell spacing | 1.0 × 1.0 (`lineHeight: 1`, `letterSpacing: 0`) | iTerm2 DefaultBookmark | same |
| Bold rendering | bright-bold on (`drawBoldTextInBrightColors: true`) | iTerm2 "Use Bright Bold" | same |
| Effective cursor | **underline, non-blinking** (`terminal.cursorStyle`/`cursorBlink` settings defaults) | trmx-51 (style) + trmx-55 (blink) | `realDeps.test.ts` ("keeps … the trmx-51 cursor at the chokepoint") |
| Colors | the six-theme catalog (`app/src/theme/themes/`), first-run default derived from OS appearance (dark → Night, light → White) | trmx-53 | `themes.acceptance.test.ts` (value-exact fixtures + legibility gates) |
| Scrollback/emulation | NOT display facts — see `scrollbackSettings.ts` / `emulationOptions.ts` | trmx-64/65 | their own suites |

## 2. The token contract

Each theme is ONE `ThemeTokens` value (`app/src/theme/tokens.ts`) — the single color source for
the whole app (the vmark ADR-014 invariant: adding a theme = one new file + one catalog entry).
What each slice drives:

| Token field | Surface it drives | Delivery |
|---|---|---|
| `color.bg.*`, `color.text.*`, `color.accent.*`, `color.border`, `color.selection`, `color.semantic.*` | settings window (`--tx-*` vars), window/body background | `txCssVars.ts` → inline vars on `documentElement` |
| `terminal.ansi` (16 colors) | xterm ANSI palette | `buildXtermTheme.ts` |
| `color.bg.primary` / `color.text.primary` | terminal background / foreground | `buildXtermTheme.ts` |
| `terminal.cursor` / `cursorAccent` | cursor block/underline + text under cursor | `buildXtermTheme.ts` |
| `terminal.selectionBackground` | terminal selection tint (composited over bg) | `buildXtermTheme.ts` |
| `terminal.scrollbar` triple | Kitty-style overlay scrollbar idle/hover/active | rides `ITheme`'s `scrollbarSlider*` extension (trmx-41) |
| derived `--tx-on-accent/-success/-error` | text on accent/success/error control surfaces | `txCssVars.ts` via `contrast.pickReadableOn` (trmx-77, G5) |

**Consistency rule:** no component hardcodes a theme color. The audited inventory of color
literals outside the catalog (grep `#[0-9a-fA-F]{3,8}\b|rgba?\(` over `app/src`, excluding
`app/src/theme/` and tests):

1. **iTerm2 reference record** — `iterm2Theme.ts` (a pure record of the DefaultBookmark profile;
   not a runtime color source since trmx-53). Intentional.
2. **Pre-theme static fallbacks** — `index.css` first-paint background (dark → Night `#000000`
   since trmx-183, light → White `#ffffff`) and `settings.css`'s pre-JS `:root` fallback block.
   Intentional —
   they prevent a flash before the persisted theme applies; values mirror the first-run defaults.
3. **Physical affordances** — the toggle knob (`background: #fff` on the accent/border track)
   and `scrollbar.ts`'s theme-less defensive foreground fallback. Intentional.
4. **Everything else routes through tokens.** Guarded by tests: settings.css declares `--tx-*`
   under `:root` only, no hardcoded data-URI glyph colors, and — since trmx-77 — **no `color: #fff`
   text declarations** (`txCssVars.test.ts`).

## 3. Intentional deviations from iTerm2's default profile

| Deviation | iTerm2 default | Termixion | Why | Decided |
|---|---|---|---|---|
| Font | Monaco 12 | SF Mono (system monospace) 12 | track what macOS ships; crisper on retina | trmx-46 |
| Default cursor style | solid block | **underline** | Termixion's chosen default; users can pick block in Settings | trmx-51 |
| Cursor blink | off | off (parity) | iTerm2-default parity | trmx-55 |
| Colors | one adaptive light/dark theme (16 ANSI shared; primaries flip with OS) | six-theme catalog (vmark-derived), explicit persisted choice; OS consulted only for the first-run default | theme catalog is a product feature (v0.0.7 grows it) | trmx-53 |
| Chrome | native tabs/scrollbars | Termixion tab strip (trmx-74) + Kitty-style overlay scrollbar (trmx-41), themed via tokens | product identity | trmx-41/74 |
| Catalog values vs vmark | — | two audited legibility deltas (trmx-77) + the pure-black Night window deltas (bg tiers + cursorAccent, trmx-183) — both below §4 | legibility gates; product ask | trmx-77/183 |

Everything else at the chokepoint mirrors the iTerm2 default profile (§1 table). The side-by-side
audit protocol to re-verify: fresh iTerm2 default profile vs packaged Termixion, same window size,
same content (`scripts/visual-review.sh content`, `ls -la`, cursor-shape cycle, a selection, and a
full-screen TUI such as `htop`); compare font rendering/weight, cell width/line height, content
insets, cursor and selection rendering.

## 4. Legibility gates (the machine-checkable floor)

Implemented in `themes.acceptance.test.ts` (`CONTRAST_GATES`, gates G1–G4) and
`txCssVars.test.ts` (G5). WCAG 2.x relative-luminance ratios; alpha colors composited over
`bg.primary` first (`app/src/theme/contrast.ts`). **Floors, not targets** — chosen (a) anchored
to WCAG AA / UI-component levels, (b) currently achievable by every canonical palette, (c) tight
enough that the audited failures were real legibility defects:

| Gate | Pair | Floor | Post-audit minimum |
|---|---|---|---|
| G1 | `text.primary` vs `bg.primary` | ≥ 4.5:1 (AA normal text) | Solarized 5.61 |
| G2 | each ANSI color vs `bg.primary` (**`black` exempt**) | ≥ 2.5:1 | Solarized brightBlack 2.79 (Night's, the audit fix, is 4.57 on the trmx-183 pure-black bg — was 1.83 on the vmark bg) |
| G3 | `text.primary` vs composited `selectionBackground` | ≥ 4.5:1 | Solarized 4.62 (was 4.17) |
| G4 | `terminal.cursor` vs `bg.primary` | ≥ 3:1 (UI component) | Solarized 5.61 |
| G5 | `--tx-on-*` text vs its accent/success/error surface | ≥ 3:1 (UI component) | light-theme on-success 3.30 (white on `#16a34a`) |

**The `black` exemption (G2):** ANSI black doubles as the TUI *background* color; every canonical
dark theme keeps it ≈ its own background (iTerm2's black on its dark bg ≈ 1.0; Night 1.24 —
`#1a1d22` now sits just *above* the trmx-183 pure-black bg instead of below the old gray-blue one;
Solarized 1.15). Failing it would "fix" every canonical dark palette into something else.

**Selected-text definition (G3):** the token schema deliberately has no `selectionForeground`
(xterm keeps each glyph's own color under selection), so the gate checks the *theme foreground*
over the composited tint — the principled floor. Per-ANSI-color-under-selection fails everywhere
by construction and is explicitly not a gate.

**Why G1 is 4.5 and not 7 (AAA):** canonical Solarized base1-on-base03 measures 5.61 — its
identity, not a defect. The floor is AA; actuals (5.61–17.40) are recorded here.

**The vmark fork (trmx-77, extended by trmx-183):** the catalog was ported value-exact from vmark
@ d7e70e3f (trmx-53). The trmx-77 audit changed exactly two values; trmx-183 (the pure-black Night
window) changed four more. The ratios in the trmx-77 rows were measured on the then-current
`#23262b` Night bg:

| Token | vmark | Termixion | Gate |
|---|---|---|---|
| `night.terminal.ansi.brightBlack` | `#484f58` (1.83:1) | `#6e7681` (3.30:1 — GitHub Dark's canonical bright black, same hue family) | G2 |
| `solarized.terminal.selectionBackground` | `rgba(38,139,210,0.22)` (4.17:1) | `rgba(38,139,210,0.15)` (4.62:1; tint stays visible) | G3 |
| `night.color.bg.primary/secondary/tertiary` | `#23262b`/`#2a2e34`/`#32363d` | `#000000`/`#0a0a0a`/`#141414` (pure-black window; tiers re-derived via themeDerive's dark-theme `shade(+4)/(+8)`) | trmx-183 product ask |
| `night.terminal.cursorAccent` | `#23262b` | `#000000` (tracks `bg.primary`) | trmx-183, follows the bg |

**The trmx-201 additions:** six community palettes joined the catalog (Catppuccin Mocha & Latte,
Dracula, Gruvbox dark-medium, Nord, Tokyo Night "night" — upstream repo@commit pinned in each
module header). **Dracula and Gruvbox pass every gate canonically — zero deviations.** The audited
deviations (measured with `contrast.ts` on each theme's own `bg.primary`; canonical ratio → new):

| Token | Canonical | Termixion | Gate |
|---|---|---|---|
| `catppuccin-mocha.ansi.brightBlack` | Surface2 `#585b70` (2.46) | Overlay0 `#6c7086` (3.36) — one step up the flavor ladder | G2 |
| `catppuccin-latte.ansi.brightBlack` | Surface2 `#acb0be` (1.91) | Overlay1 `#8c8fa1` (2.83) — minimal ladder step; Overlay0 still fails at 2.30 | G2 |
| `catppuccin-latte.ansi.yellow`+`brightYellow` | `#df8e1d` (2.31) | `#c17d18` (2.99) — same hue, darkened | G2 |
| `catppuccin-latte.ansi.magenta`+`brightMagenta` | Pink `#ea76cb` (2.34) | `#d64ca8` (3.40) — same hue, darkened | G2 |
| `catppuccin-latte.terminal.cursor` | Rosewater `#dc8a78` (2.34) | flavor text `#4c4f69` (7.06) — the light-theme cursor convention (white/paper/mint/sepia) | G4 |
| `nord.ansi.brightBlack` | nord3 `#4c566a` (1.69) | `#66738f` (2.63) — Nord's documented comment tone `#616e88` still fails at 2.44; minimal in-family brighten | G2 |
| `tokyo-night.ansi.brightBlack` | terminal `#414868` (1.91) | the style's comment color `#565f89` (2.76) | G2 |

Full post-audit matrix (fg / selected-text / cursor vs `bg.primary`): White 17.40 / 11.95 / 17.40 ·
Paper 14.89 / 10.42 / 14.89 · Mint 8.93 / 6.41 / 8.93 · Sepia 7.36 / 5.13 / 7.36 ·
Night 14.84 / 10.98 / 14.84 (re-measured on the trmx-183 pure-black bg) · Solarized 5.61 / 4.62 /
5.61. All 6 themes × 15 gated ANSI colors pass G2 (catalog minimum: Solarized brightBlack 2.79;
Night brightBlack, the audit fix, is 4.57).

**G5 picks** (derived by `pickReadableOn(surface, [#fff, bg.primary])`, never hardcoded): light
themes keep white text on all three surfaces — on-accent 5.57–7.10, on-success 3.30 (white on
`#16a34a`, the G5 catalog minimum), on-error 5.35; Night uses its own pure-black bg `#000000` on
all three (6.26–12.05); Solarized splits — dark `#002b36` on accent (4.08) and success (4.69), white
on error (4.63). The split is the proof the derivation is per-surface. The `:root` static
fallback in `settings.css` mirrors Night's full mapping including the three on-* vars (guarded
var-for-var by `txCssVars.test.ts`).

## 5. Screenshot set + capture protocol

The review evidence is a six-shot set (one per theme, same window size, showing the
`visual-review.sh content` checklist) captured on the reference Mac (M1 Pro) from the **packaged**
debug app:

```
(cd crates/termixion-tauri && cargo tauri build --debug)
bash scripts/visual-review.sh capture        # opens the app; → docs/design/visual-baseline/<theme>.png
# inside Termixion, before capturing:  bash scripts/visual-review.sh content
```

Theme switching is manual in v0.0.4 (Settings → Appearance; a scriptable hook would be a config
surface, which FR-13/v0.0.5 owns), and window selection is by CLICK (`screencapture -w`) — the
Tauri app is not AppleScript-scriptable, so there is no reliable CGWindowID for `-l`. **The
reference window size is 1280×800 logical points** (2560×1600 px at the M1 Pro's 2× backing
scale): resize once before the first shot and keep it fixed — the script hard-fails a set whose
shot dimensions drift mid-run. The set is committed
under `docs/design/visual-baseline/` when size allows, else linked from the locking PR.
**No pixel-diff CI gate** — font rendering makes it flaky; the gate is this protocol + the PR
screenshot review (the issue's explicit call).

### Tab-bar positions (trmx-81)

FR-2.2 makes the tab bar's window edge configurable (`tabs.barPosition`: top / bottom / left /
right; bottom stays the vision default, so the §5 six-shot set is unchanged). The strip consumes
the same `--tx-*` tokens on every edge (no new color literals — the §2 consistency rule holds);
the vertical left/right rails are a new *layout*, not a new palette. Their review evidence is a
**six-theme side-bar screenshot set (bottom + left minimum, same 1280×800 window, same §5
protocol)** captured by the **operator's visual-review pass** (`scripts/visual-review.sh`) from
the packaged app — deliberately NOT a CI artifact, per the no-pixel-diff rule above. Functional
coverage (edge class, rail geometry, tab flows per position) is CI-gated instead, in
`app/e2e/tab-position.spec.ts` and the tabState/barLayout/TabStrip unit suites.

**Side-rail label orientation (trmx-82).** FR-2.3 adds `tabs.sideLabelOrientation`
(horizontal / vertical; horizontal stays the default, so the shots above are unchanged).
Vertical-label mode restyles the side rail into a slim 44px column of tall tabs — rotated
`writing-mode` labels, an end-anchored close ×, the fixed rename overlay — again a new *layout*
over the same `--tx-*` tokens (no new color literals; the §2 consistency rule holds). Its review
evidence extends this set with a **left-bar-VERTICAL six-theme row (same 1280×800 window, same
§5 protocol)** captured by the **operator's visual-review pass** from the packaged app —
deliberately NOT a CI artifact, per the no-pixel-diff rule. Functional coverage (the modifier
classes, the 44px rail token, rotated labels, tab flows, the scrolled-rail rename overlay, and
the Settings-page gating) is CI-gated instead, in `app/e2e/label-orientation.spec.ts` plus the
barLayout/TabStrip/AppearanceSettings/SettingsApp unit suites.

**iTerm2-style tab layout + shortcut hints (trmx-151).** The strip adopts iTerm2's layout
conventions — centered prefix+title content, a left-edge hover/focus-revealed close ×, the
activity dot staying right — and the first nine tabs gain a dimmed `⌘1`–`⌘9` prefix (the live
`tab.select-N` binding, `tabs.showShortcutHints`, default on). Layout only: the same `--tx-*`
tokens on every surface, zero new color literals (the §2 consistency rule holds); the active-tab
treatment (raised `--tx-bg` + accent line) is unchanged. Review evidence: the operator's §5
six-shot pass picks up the new layout on its existing bottom/left rows — no new screenshot row is
required (same window, same protocol). Functional coverage is CI-gated in the tabState /
registry / chordGlyphs / tabHints / barLayout / TabStrip unit suites and the tabs / tab-position /
label-orientation e2e specs (hint presence per position, the narrow-tab whole-prefix drop, the
upright chip on the vertical rail, and the scrolled-rail rename overlay staying un-recontained).

## 6. The forward rule (v0.0.6 / v0.0.7)

- **Splits (v0.0.6):** pane chrome (dividers, focus dim, indicators) consumes existing tokens
  (`border`, `bg` tiers, `accent`) — no new color literals, no per-component values. New chrome
  that genuinely needs a new role adds a **token** (+ gates if text-bearing), not a hex.
- **Theming system (v0.0.7):** user themes enter through the same `ThemeTokens` shape and MUST
  pass the same `CONTRAST_GATES` (tolerant validation may downgrade a failing user theme to a
  warning — decided there — but built-ins never regress). The contract fields and gate floors in
  this doc only move via an issue that updates doc + gates together.
- **Re-audit trigger:** any change to `iterm2Theme.ts`, the catalog, `buildXtermTheme.ts`,
  `txCssVars.ts`, or terminal-adjacent chrome re-runs §3's protocol and §5's capture.

## 6. Multi-pane look (FR-3.6, trmx-87)

The split-pane layout (trmx-84/85/86) gets the Kitty "internal windows" look, an extension of the
locked baseline — the single-pane look is **unchanged** (a lone pane has no divider and is never
dimmed), so everything here applies only once you split.

### 6.1 Pane border tokens (contract)

`ThemeTokens.terminal.pane = { activeBorder, inactiveBorder }` — the two Kitty window-border colors.
In our flat-rect model the **divider IS the border**. Emitted as `--tx-pane-active-border` /
`--tx-pane-inactive-border` (`txCssVars.ts`); no color literals in the chrome (§4 rule).

| token | source | gate |
| ----- | ------ | ---- |
| `pane.activeBorder` | the theme's **accent** (per theme) | **G5**: ≥ `CONTRAST_GATES.cursor` (3:1) vs `bg.primary` — the focused pane must read as focused in every theme |
| `pane.inactiveBorder` | the theme's **border** | presence + distinct from active (subtle line) |

### 6.2 Focus indication (active dividers)

`paneChrome.activeDividerSegments` (pure) returns, for each divider that borders the focused pane, the
**segment** where it does — the perpendicular overlap between the focused pane's rect and the divider
(edge-adjacent + the overlap interval). App renders every divider's base line `pane-divider--inactive` and,
over each active segment, a `pane-divider__active` overlay (`--tx-pane-active-border`, `pointer-events:
none`) sized to that span. So a full-height divider next to a bottom pane is colored **only over the bottom
half**; a fully-adjacent divider (e.g. the sole divider of a 2-pane split) is colored end to end.
`activeDividerKeys` remains as the set of dividers that have a segment. A focus change is a **style flip
only** — no re-layout, no terminal touch (pinned by `App.test.tsx`: survivor `recorder.unmounts === 0`).
**trmx-175** replaced the earlier whole-divider approximation — which colored a divider along its *entire*
length whenever any part of it bordered the focused pane, so the span between two unfocused panes was
wrongly active — with true Kitty-style per-segment borders.

### 6.3 Unfocused dim (Kitty `inactive_text_alpha`)

**Decision:** dim unfocused panes' **text** to `opacity: 0.85` via `.pane-host:not(.pane-host--focused)
.xterm-screen` — compositor-side, no xterm API, instant restore on focus. The selection layer is a
sibling of `.xterm-screen`, so a selection in a dimmed pane stays visible. **WebGL outcome:** opacity is
applied to the screen host container (compositor-side), so the WebGL canvas composites normally — no
blending artifacts observed; the documented fallback (borders-only, skip the dim) was **not** needed.

### 6.4 Screenshot rows (operator-captured)

`scripts/visual-review.sh split` opens a 2×2 grid; capture one row per theme (six rows), each showing the
focused pane obvious at a glance, a selection visible in a dimmed pane, and a single-pane tab
byte-identical to §1's baseline. The headless gate (token contrast + `paneChrome` geometry + the
style-only-flip component test) runs in CI; **this image set + the visual sign-off is the operator step**,
recorded here alongside §5's single-pane captures.
