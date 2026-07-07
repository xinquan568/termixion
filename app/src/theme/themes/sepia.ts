// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: Sepia theme — warm beige background. Values copied verbatim from
// vmark origin/main:src/theme/themes/sepia.ts @ d7e70e3f (pruned to Termixion's token schema).
import { semanticLight, type ThemeTokens } from "../tokens";

export const sepia: ThemeTokens = {
  isDark: false,
  color: {
    bg: { primary: "#F9F0DB", secondary: "#f0e5cc", tertiary: "#e0d5bc" },
    text: { primary: "#5c4b37", secondary: "#666666", tertiary: "#999999" },
    accent: { primary: "#8b4513", bg: "rgba(139, 69, 19, 0.1)" },
    border: "#e0d5bc",
    selection: "rgba(139, 69, 19, 0.2)",
    semantic: semanticLight,
  },
  terminal: {
    // trmx-87 (FR-3.6): Kitty pane borders — active = accent (outlines the focused pane), inactive = the theme border line.
    pane: { activeBorder: "#8b4513", inactiveBorder: "#e0d5bc" },
    ansi: {
      black: "#3e3328",
      red: "#b5421a",
      green: "#4a6818",
      yellow: "#7a5c00",
      blue: "#4a6a8a",
      magenta: "#8a5470",
      cyan: "#1e645e",
      white: "#5e5345",
      brightBlack: "#6b5d4f",
      brightRed: "#b04828",
      brightGreen: "#4e7018",
      brightYellow: "#886200",
      brightBlue: "#3e6490",
      brightMagenta: "#8a5470",
      brightCyan: "#267a6e",
      brightWhite: "#5e5345",
    },
    cursor: "#5c4b37",
    cursorAccent: "#F9F0DB",
    selectionBackground: "rgba(0,102,204,0.25)",
    // trmx-90: per-pane badge watermark. trmx-149: iTerm2's default badge red (KEY_BADGE_COLOR,
    // red 1.0/0/0 @ 0.5 alpha) replaces the faint text tint — exact iTerm2 parity.
    badge: "rgba(255, 0, 0, 0.5)",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
    // trmx-98: find-bar highlights — translucent yellow match / warmer active (legible over every theme bg).
    search: { match: "rgba(250, 204, 21, 0.30)", activeMatch: "rgba(255, 138, 0, 0.48)" },
  },
};
