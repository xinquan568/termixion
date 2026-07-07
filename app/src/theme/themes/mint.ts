// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: Mint theme — green-tinted background. Values copied verbatim from
// vmark origin/main:src/theme/themes/mint.ts @ d7e70e3f (pruned to Termixion's token schema).
import { semanticLight, type ThemeTokens } from "../tokens";

export const mint: ThemeTokens = {
  isDark: false,
  color: {
    bg: { primary: "#CCE6D0", secondary: "#b8d9bd", tertiary: "#a8c9ad" },
    text: { primary: "#2d3a35", secondary: "#666666", tertiary: "#999999" },
    accent: { primary: "#1a6b4a", bg: "rgba(26, 107, 74, 0.1)" },
    border: "#a8c9ad",
    selection: "rgba(26, 107, 74, 0.2)",
    semantic: semanticLight,
  },
  terminal: {
    // trmx-87 (FR-3.6): Kitty pane borders — active = accent (outlines the focused pane), inactive = the theme border line.
    pane: { activeBorder: "#1a6b4a", inactiveBorder: "#a8c9ad" },
    // vmark: cyan H~187, between green (124) and blue (202) — pure teal reads as green on mint.
    ansi: {
      black: "#2a3832",
      red: "#9e3020",
      green: "#246428",
      yellow: "#7a5c00",
      blue: "#155878",
      magenta: "#7b4a8a",
      cyan: "#0a6571",
      white: "#3d5240",
      brightBlack: "#4d6054",
      brightRed: "#a83828",
      brightGreen: "#2a6a2e",
      brightYellow: "#7a5c00",
      brightBlue: "#1a6896",
      brightMagenta: "#7a4490",
      brightCyan: "#0e6b7a",
      brightWhite: "#3d5240",
    },
    cursor: "#2d3a35",
    cursorAccent: "#CCE6D0",
    selectionBackground: "rgba(0,102,204,0.25)",
    // trmx-90: per-pane badge watermark. trmx-149: iTerm2's default badge red (KEY_BADGE_COLOR,
    // red 1.0/0/0 @ 0.5 alpha) replaces the faint text tint — exact iTerm2 parity.
    badge: "rgba(255, 0, 0, 0.5)",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
    // trmx-98: find-bar highlights — translucent yellow match / warmer active (legible over every theme bg).
    search: { match: "rgba(250, 204, 21, 0.30)", activeMatch: "rgba(255, 138, 0, 0.48)" },
  },
};
