// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-201: Catppuccin Latte — the light Catppuccin flavor (the catalog's light-side entry after
// trmx-202). Palette copied verbatim from catppuccin/catppuccin @ 3376efaebc3e (docs/palette.md,
// Latte); ANSI mapping per the project's terminal style guide (black/brightBlack =
// Surface1/Surface2, white/brightWhite = Subtext1/Subtext0, bright hues repeat the normal hues).
// UI tiers: base/mantle/crust backgrounds, text/subtext0/overlay1 text, blue accent, surface0
// border. Light-theme terminal furniture (scrollbar/search) follows the white/paper pattern.
// trmx-201 audited deviations (G2/G4, the trmx-77 precedent; measured on base #eff1f5, gates
// ansi ≥2.5 / cursor ≥3): brightBlack Surface2 #acb0be 1.91 → Overlay1 #8c8fa1 (2.83, minimal
// ladder step — Overlay0 still fails at 2.30); yellow+brightYellow #df8e1d 2.31 → #c17d18
// (2.99, same hue darkened); magenta+brightMagenta Pink #ea76cb 2.34 → #d64ca8 (3.40, same
// hue darkened); cursor Rosewater #dc8a78 2.34 → the flavor text #4c4f69 (7.06 — the light-theme
// cursor convention white/paper/mint/sepia already follow). See docs/design/visual-baseline.md §4.
import type { ThemeTokens } from "../tokens";

export const catppuccinLatte: ThemeTokens = {
  isDark: false,
  color: {
    bg: { primary: "#eff1f5", secondary: "#e6e9ef", tertiary: "#dce0e8" },
    text: { primary: "#4c4f69", secondary: "#6c6f85", tertiary: "#8c8fa1" },
    accent: { primary: "#1e66f5", bg: "rgba(30, 102, 245, 0.1)" },
    border: "#ccd0da",
    selection: "rgba(30, 102, 245, 0.2)",
    semantic: { error: "#d20f39", errorBg: "rgba(210, 15, 57, 0.12)", success: "#40a02b" },
  },
  terminal: {
    // trmx-87 (FR-3.6): Kitty pane borders — active = accent (outlines the focused pane), inactive = the theme border line.
    pane: { activeBorder: "#1e66f5", inactiveBorder: "#ccd0da" },
    ansi: {
      black: "#bcc0cc",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#c17d18",
      blue: "#1e66f5",
      magenta: "#d64ca8",
      cyan: "#179299",
      white: "#5c5f77",
      brightBlack: "#8c8fa1",
      brightRed: "#d20f39",
      brightGreen: "#40a02b",
      brightYellow: "#c17d18",
      brightBlue: "#1e66f5",
      brightMagenta: "#d64ca8",
      brightCyan: "#179299",
      brightWhite: "#6c6f85",
    },
    cursor: "#4c4f69",
    cursorAccent: "#eff1f5",
    selectionBackground: "rgba(30, 102, 245, 0.22)",
    // trmx-90: per-pane badge watermark. trmx-149: translucent pink #ff8da180 (50% alpha; Termixion's
    // chosen badge color, a deliberate deviation from iTerm2's default red) replaces the faint text tint.
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
    // trmx-98: find-bar highlights — translucent yellow match / warmer active (the light-theme pattern).
    search: { match: "rgba(250, 204, 21, 0.30)", activeMatch: "rgba(255, 138, 0, 0.48)" },
  },
};
