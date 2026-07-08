// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: Paper theme — soft warm background (vmark's default). Values copied verbatim from
// vmark origin/main:src/theme/themes/paper.ts @ d7e70e3f (pruned to Termixion's token schema).
import { semanticLight, type ThemeTokens } from "../tokens";

export const paper: ThemeTokens = {
  isDark: false,
  color: {
    bg: { primary: "#EEEDED", secondary: "#e5e4e4", tertiary: "#f0f0f0" },
    text: { primary: "#1a1a1a", secondary: "#666666", tertiary: "#999999" },
    accent: { primary: "#0066cc", bg: "rgba(0, 102, 204, 0.1)" },
    border: "#d5d4d4",
    selection: "rgba(0, 102, 204, 0.2)",
    semantic: semanticLight,
  },
  terminal: {
    // trmx-87 (FR-3.6): Kitty pane borders — active = accent (outlines the focused pane), inactive = the theme border line.
    pane: { activeBorder: "#0066cc", inactiveBorder: "#d5d4d4" },
    ansi: {
      black: "#2e3436",
      red: "#c33820",
      green: "#387204",
      yellow: "#806800",
      blue: "#2f5a92",
      magenta: "#7b4d82",
      cyan: "#086e6e",
      white: "#595959",
      brightBlack: "#5c5c5a",
      brightRed: "#c03820",
      brightGreen: "#367004",
      brightYellow: "#806800",
      brightBlue: "#3a6494",
      brightMagenta: "#7d4d84",
      brightCyan: "#086c6c",
      brightWhite: "#595959",
    },
    cursor: "#1a1a1a",
    cursorAccent: "#EEEDED",
    selectionBackground: "rgba(0,102,204,0.25)",
    // trmx-90: per-pane badge watermark. trmx-149: translucent pink #ff8da180 (50% alpha; Termixion's
    // chosen badge color, a deliberate deviation from iTerm2's default red) replaces the faint text tint.
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
    // trmx-98: find-bar highlights — translucent yellow match / warmer active (legible over every theme bg).
    search: { match: "rgba(250, 204, 21, 0.30)", activeMatch: "rgba(255, 138, 0, 0.48)" },
  },
};
