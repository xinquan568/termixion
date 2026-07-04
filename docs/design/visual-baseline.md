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
2. **Pre-theme static fallbacks** — `index.css` first-paint background (dark → Night `#23262b`,
   light → White `#ffffff`) and `settings.css`'s pre-JS `:root` fallback block. Intentional —
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
| Catalog values vs vmark | — | two audited token deltas (below §4) | legibility gates | trmx-77 |

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
| G2 | each ANSI color vs `bg.primary` (**`black` exempt**) | ≥ 2.5:1 | Solarized brightBlack 2.79 (Night's, the audit fix, is 3.30 — was 1.83) |
| G3 | `text.primary` vs composited `selectionBackground` | ≥ 4.5:1 | Solarized 4.62 (was 4.17) |
| G4 | `terminal.cursor` vs `bg.primary` | ≥ 3:1 (UI component) | Solarized 5.61 |
| G5 | `--tx-on-*` text vs its accent/success/error surface | ≥ 3:1 (UI component) | light-theme on-success 3.30 (white on `#16a34a`) |

**The `black` exemption (G2):** ANSI black doubles as the TUI *background* color; every canonical
dark theme keeps it ≈ its own background (iTerm2's black on its dark bg ≈ 1.0; Night 1.11,
Solarized 1.15). Failing it would "fix" every canonical dark palette into something else.

**Selected-text definition (G3):** the token schema deliberately has no `selectionForeground`
(xterm keeps each glyph's own color under selection), so the gate checks the *theme foreground*
over the composited tint — the principled floor. Per-ANSI-color-under-selection fails everywhere
by construction and is explicitly not a gate.

**Why G1 is 4.5 and not 7 (AAA):** canonical Solarized base1-on-base03 measures 5.61 — its
identity, not a defect. The floor is AA; actuals (5.61–17.40) are recorded here.

**The vmark fork (trmx-77):** the catalog was ported value-exact from vmark @ d7e70e3f (trmx-53).
The audit changed exactly two values, making the fixtures Termixion's own audited baseline:

| Token | vmark | Termixion | Gate |
|---|---|---|---|
| `night.terminal.ansi.brightBlack` | `#484f58` (1.83:1) | `#6e7681` (3.30:1 — GitHub Dark's canonical bright black, same hue family) | G2 |
| `solarized.terminal.selectionBackground` | `rgba(38,139,210,0.22)` (4.17:1) | `rgba(38,139,210,0.15)` (4.62:1; tint stays visible) | G3 |

Full post-audit matrix (fg / selected-text / cursor vs `bg.primary`): White 17.40 / 11.95 / 17.40 ·
Paper 14.89 / 10.42 / 14.89 · Mint 8.93 / 6.41 / 8.93 · Sepia 7.36 / 5.13 / 7.36 ·
Night 10.73 / 7.16 / 10.73 · Solarized 5.61 / 4.62 / 5.61. All 6 themes × 15 gated ANSI colors
pass G2 (catalog minimum: Solarized brightBlack 2.79; Night brightBlack, the audit fix, is 3.30).

**G5 picks** (derived by `pickReadableOn(surface, [#fff, bg.primary])`, never hardcoded): light
themes keep white text on all three surfaces — on-accent 5.57–7.10, on-success 3.30 (white on
`#16a34a`, the G5 catalog minimum), on-error 5.35; Night uses its own dark bg `#23262b` on all
three (4.70–9.05); Solarized splits — dark `#002b36` on accent (4.08) and success (4.69), white
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
