// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-201: Gruvbox — dark, MEDIUM contrast (the pinned variant). Palette copied verbatim from
// morhetz/gruvbox @ 5d15b2765f59 (dark-mode neutral + bright color ladders; bg0 #282828 medium).
// ANSI mapping is gruvbox's canonical terminal layout: normal = the neutral colors, bright = the
// bright colors, white/brightWhite = fg4/fg1, brightBlack = gray #928374. UI tiers ride the bg/fg
// ladders (bg0/bg1/bg2, fg1/fg2/fg4); accent = bright orange (gruvbox's signature).
import type { ThemeTokens } from "../tokens";

export const gruvbox: ThemeTokens = {
  isDark: true,
  color: {
    bg: { primary: "#282828", secondary: "#3c3836", tertiary: "#504945" },
    text: { primary: "#ebdbb2", secondary: "#d5c4a1", tertiary: "#a89984" },
    accent: { primary: "#fe8019", bg: "rgba(254, 128, 25, 0.12)" },
    border: "#504945",
    selection: "rgba(254, 128, 25, 0.20)",
    semantic: { error: "#fb4934", errorBg: "rgba(251, 73, 52, 0.15)", success: "#b8bb26" },
  },
  terminal: {
    // trmx-87 (FR-3.6): Kitty pane borders — active = accent (outlines the focused pane), inactive = the theme border line.
    pane: { activeBorder: "#fe8019", inactiveBorder: "#504945" },
    ansi: {
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
    cursor: "#ebdbb2",
    cursorAccent: "#282828",
    selectionBackground: "rgba(254, 128, 25, 0.20)",
    // trmx-90: per-pane badge watermark. trmx-149: translucent pink #ff8da180 (50% alpha; Termixion's
    // chosen badge color, a deliberate deviation from iTerm2's default red) replaces the faint text tint.
    badge: "#ff8da180",
    scrollbar: {
      idle: "rgba(255, 255, 255, 0.12)",
      hover: "rgba(255, 255, 255, 0.20)",
      active: "rgba(255, 255, 255, 0.30)",
    },
    // trmx-98: find-bar highlights — warm gruvbox tints (bright yellow match, orange active) kept
    // low-alpha so fg1 stays legible (G6).
    search: { match: "rgba(250, 189, 47, 0.15)", activeMatch: "rgba(254, 128, 25, 0.30)" },
  },
};
