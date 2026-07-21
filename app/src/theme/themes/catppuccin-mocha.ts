// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-201: Catppuccin Mocha — the darkest Catppuccin flavor. Palette copied verbatim from
// catppuccin/catppuccin @ 3376efaebc3e (docs/palette.md, Mocha); ANSI mapping per the project's
// terminal style guide (black/brightBlack = Surface1/Surface2, white/brightWhite =
// Subtext1/Subtext0, bright hues repeat the normal hues). UI tiers from the flavor's surface
// ladder: base/mantle/surface0 backgrounds, text/subtext0/overlay1 text, blue accent, surface1
// border, rosewater cursor (the Catppuccin cursor convention).
// trmx-201 audited deviation (G2, the trmx-77 precedent): ansi.brightBlack Surface2 #585b70
// measured 2.46:1 on base (gate ≥2.5) → Overlay0 #6c7086 (3.36:1), one step up the same
// flavor ladder. See docs/design/visual-baseline.md §4.
import type { ThemeTokens } from "../tokens";

export const catppuccinMocha: ThemeTokens = {
  isDark: true,
  color: {
    bg: { primary: "#1e1e2e", secondary: "#181825", tertiary: "#313244" },
    text: { primary: "#cdd6f4", secondary: "#a6adc8", tertiary: "#7f849c" },
    accent: { primary: "#89b4fa", bg: "rgba(137, 180, 250, 0.12)" },
    border: "#45475a",
    selection: "rgba(137, 180, 250, 0.22)",
    semantic: { error: "#f38ba8", errorBg: "rgba(243, 139, 168, 0.15)", success: "#a6e3a1" },
  },
  terminal: {
    // trmx-87 (FR-3.6): Kitty pane borders — active = accent (outlines the focused pane), inactive = the theme border line.
    pane: { activeBorder: "#89b4fa", inactiveBorder: "#45475a" },
    ansi: {
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#6c7086",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
    cursor: "#f5e0dc",
    cursorAccent: "#1e1e2e",
    selectionBackground: "rgba(137, 180, 250, 0.22)",
    // trmx-90: per-pane badge watermark. trmx-149: translucent pink #ff8da180 (50% alpha; Termixion's
    // chosen badge color, a deliberate deviation from iTerm2's default red) replaces the faint text tint.
    badge: "#ff8da180",
    scrollbar: {
      idle: "rgba(255, 255, 255, 0.12)",
      hover: "rgba(255, 255, 255, 0.20)",
      active: "rgba(255, 255, 255, 0.30)",
    },
    // trmx-98: find-bar highlights — low-luminance accent tint (the dark-theme pattern; a bright warm
    // highlight would fight the pastel palette).
    search: { match: "rgba(137, 180, 250, 0.16)", activeMatch: "rgba(137, 180, 250, 0.24)" },
  },
};
