// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: Solarized theme — Ethan Schoonover's Solarized Dark (base03/base02 backgrounds,
// base0/base1 text, blue #268bd2 accent; canonical ANSI mapping: normal = accent/base tones,
// bright = base monotones + orange/violet). Values copied verbatim from
// vmark origin/main:src/theme/themes/solarized.ts @ d7e70e3f (pruned to Termixion's token schema).
// trmx-77: one audited deviation from vmark — terminal.selectionBackground alpha 0.22 → 0.15:
// base1 text over the 0.22 composite measured 4.17:1, failing the G3 selected-text gate (≥4.5:1);
// at 0.15 it measures ≈4.61:1 and the tint stays visible. The UI selection tint (color.selection)
// keeps vmark's 0.22 — it highlights settings-window text, not terminal glyphs. See
// docs/design/visual-baseline.md §4.
import type { ThemeTokens } from "../tokens";

export const solarized: ThemeTokens = {
  isDark: true,
  color: {
    bg: { primary: "#002b36", secondary: "#073642", tertiary: "#0a3a47" },
    text: { primary: "#93a1a1", secondary: "#839496", tertiary: "#586e75" },
    accent: { primary: "#268bd2", bg: "rgba(38, 139, 210, 0.09)" },
    border: "#0e4753",
    selection: "rgba(38, 139, 210, 0.22)",
    semantic: { error: "#dc322f", errorBg: "rgba(220, 50, 47, 0.15)", success: "#859900" },
  },
  terminal: {
    // trmx-87 (FR-3.6): Kitty pane borders — active = accent (outlines the focused pane), inactive = the theme border line.
    pane: { activeBorder: "#268bd2", inactiveBorder: "#0e4753" },
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
    selectionBackground: "rgba(38, 139, 210, 0.15)",
    // trmx-90: per-pane badge watermark — translucent base1 (text #93a1a1) on the dark teal background.
    badge: "rgba(147, 161, 161, 0.10)",
    scrollbar: {
      idle: "rgba(255, 255, 255, 0.12)",
      hover: "rgba(255, 255, 255, 0.20)",
      active: "rgba(255, 255, 255, 0.30)",
    },
    // trmx-98: find-bar highlights — low-luminance accent tint (a bright warm highlight is illegible on this low-contrast dark bg).
    search: { match: "rgba(38, 139, 210, 0.09)", activeMatch: "rgba(38, 139, 210, 0.12)" },
  },
};
