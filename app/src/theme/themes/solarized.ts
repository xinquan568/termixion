// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: Solarized theme — Ethan Schoonover's Solarized Dark (base03/base02 backgrounds,
// base0/base1 text, blue #268bd2 accent; canonical ANSI mapping: normal = accent/base tones,
// bright = base monotones + orange/violet). Values copied verbatim from
// vmark origin/main:src/theme/themes/solarized.ts @ d7e70e3f (pruned to Termixion's token schema).
import type { ThemeTokens } from "../tokens";

export const solarized: ThemeTokens = {
  isDark: true,
  color: {
    bg: { primary: "#002b36", secondary: "#073642", tertiary: "#0a3a47" },
    text: { primary: "#93a1a1", secondary: "#839496", tertiary: "#586e75" },
    accent: { primary: "#268bd2", bg: "rgba(38, 139, 210, 0.14)" },
    border: "#0e4753",
    selection: "rgba(38, 139, 210, 0.22)",
    semantic: { error: "#dc322f", errorBg: "rgba(220, 50, 47, 0.15)", success: "#859900" },
  },
  terminal: {
    ansi: {
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
    cursor: "#93a1a1",
    cursorAccent: "#002b36",
    selectionBackground: "rgba(38, 139, 210, 0.22)",
    scrollbar: {
      idle: "rgba(255, 255, 255, 0.12)",
      hover: "rgba(255, 255, 255, 0.20)",
      active: "rgba(255, 255, 255, 0.30)",
    },
  },
};
