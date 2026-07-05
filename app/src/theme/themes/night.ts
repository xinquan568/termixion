// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: Night theme — the dark theme (the dark-OS first-run default). Values copied verbatim
// from vmark origin/main:src/theme/themes/night.ts @ d7e70e3f (pruned to Termixion's token schema).
// trmx-77: one audited deviation from vmark — ansi.brightBlack #484f58 → #6e7681 (GitHub Dark's
// canonical bright black, same hue family): 1.83:1 on bg failed the G2 legibility gate (≥2.5:1);
// brightBlack renders dim/comment text, so it carries real legibility stakes. See
// docs/design/visual-baseline.md §4.
import type { ThemeTokens } from "../tokens";

export const night: ThemeTokens = {
  isDark: true,
  color: {
    bg: { primary: "#23262b", secondary: "#2a2e34", tertiary: "#32363d" },
    text: { primary: "#d6d9de", secondary: "#9aa0a6", tertiary: "#6b7078" },
    accent: { primary: "#58a6ff", bg: "rgba(88, 166, 255, 0.12)" },
    border: "#3a3f46",
    selection: "rgba(90, 168, 255, 0.22)",
    semantic: { error: "#f85149", errorBg: "rgba(248, 81, 73, 0.15)", success: "#4ade80" },
  },
  terminal: {
    // trmx-87 (FR-3.6): Kitty pane borders — active = accent (outlines the focused pane), inactive = the theme border line.
    pane: { activeBorder: "#58a6ff", inactiveBorder: "#3a3f46" },
    ansi: {
      black: "#1a1d22",
      red: "#f85149",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ff7b72",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
    cursor: "#d6d9de",
    cursorAccent: "#23262b",
    selectionBackground: "rgba(90, 168, 255, 0.22)",
    scrollbar: {
      idle: "rgba(255, 255, 255, 0.12)",
      hover: "rgba(255, 255, 255, 0.20)",
      active: "rgba(255, 255, 255, 0.30)",
    },
  },
};
