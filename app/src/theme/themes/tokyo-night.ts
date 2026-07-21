// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-201: Tokyo Night — the "night" style (the pinned variant; not storm/moon/day). Palette
// copied verbatim from folke/tokyonight.nvim @ cdc07ac78467 (the night style's core colors and
// the extras/ terminal export: dedicated bright variants, terminal black #15161e). UI tiers:
// bg/bg_dark/bg_highlight backgrounds, fg/fg_dark/comment text, blue accent, fg_gutter border,
// fg cursor.
// trmx-201 audited deviation (G2, the trmx-77 precedent): ansi.brightBlack terminal
// #414868 measured 1.91:1 on bg (gate ≥2.5) → the style's own comment color #565f89 (2.76),
// same indigo family. See docs/design/visual-baseline.md §4.
import type { ThemeTokens } from "../tokens";

export const tokyoNight: ThemeTokens = {
  isDark: true,
  color: {
    bg: { primary: "#1a1b26", secondary: "#16161e", tertiary: "#292e42" },
    text: { primary: "#c0caf5", secondary: "#a9b1d6", tertiary: "#565f89" },
    accent: { primary: "#7aa2f7", bg: "rgba(122, 162, 247, 0.12)" },
    border: "#3b4261",
    selection: "rgba(122, 162, 247, 0.22)",
    semantic: { error: "#f7768e", errorBg: "rgba(247, 118, 142, 0.15)", success: "#9ece6a" },
  },
  terminal: {
    // trmx-87 (FR-3.6): Kitty pane borders — active = accent (outlines the focused pane), inactive = the theme border line.
    pane: { activeBorder: "#7aa2f7", inactiveBorder: "#3b4261" },
    ansi: {
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#565f89",
      brightRed: "#ff899d",
      brightGreen: "#9fe044",
      brightYellow: "#faba4a",
      brightBlue: "#8db0ff",
      brightMagenta: "#c7a9ff",
      brightCyan: "#a4daff",
      brightWhite: "#c0caf5",
    },
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selectionBackground: "rgba(122, 162, 247, 0.22)",
    // trmx-90: per-pane badge watermark. trmx-149: translucent pink #ff8da180 (50% alpha; Termixion's
    // chosen badge color, a deliberate deviation from iTerm2's default red) replaces the faint text tint.
    badge: "#ff8da180",
    scrollbar: {
      idle: "rgba(255, 255, 255, 0.12)",
      hover: "rgba(255, 255, 255, 0.20)",
      active: "rgba(255, 255, 255, 0.30)",
    },
    // trmx-98: find-bar highlights — low-luminance accent tint (the dark-theme pattern).
    search: { match: "rgba(122, 162, 247, 0.16)", activeMatch: "rgba(122, 162, 247, 0.24)" },
  },
};
