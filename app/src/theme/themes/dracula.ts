// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-201: Dracula — the canonical purple-on-dark theme. Palette copied verbatim from
// dracula/dracula-theme @ c988d3d1c9e4 (the ANSI spec — normal + dedicated bright variants — and
// the UI spec: Background #282a36, Current Line #44475a, Foreground #f8f8f2, Comment #6272a4).
// UI tiers: primary = Background, secondary = the ANSI-black panel shade #21222c, elevated =
// Current Line; text.secondary is DERIVED (fg dimmed toward Comment — Dracula defines no
// mid-tier text), tertiary = Comment; purple accent.
import type { ThemeTokens } from "../tokens";

export const dracula: ThemeTokens = {
  isDark: true,
  color: {
    bg: { primary: "#282a36", secondary: "#21222c", tertiary: "#44475a" },
    text: { primary: "#f8f8f2", secondary: "#b2b8cc", tertiary: "#6272a4" },
    accent: { primary: "#bd93f9", bg: "rgba(189, 147, 249, 0.12)" },
    border: "#44475a",
    selection: "rgba(189, 147, 249, 0.22)",
    semantic: { error: "#ff5555", errorBg: "rgba(255, 85, 85, 0.15)", success: "#50fa7b" },
  },
  terminal: {
    // trmx-87 (FR-3.6): Kitty pane borders — active = accent (outlines the focused pane), inactive = the theme border line.
    pane: { activeBorder: "#bd93f9", inactiveBorder: "#44475a" },
    ansi: {
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "rgba(189, 147, 249, 0.22)",
    // trmx-90: per-pane badge watermark. trmx-149: translucent pink #ff8da180 (50% alpha; Termixion's
    // chosen badge color, a deliberate deviation from iTerm2's default red) replaces the faint text tint.
    badge: "#ff8da180",
    scrollbar: {
      idle: "rgba(255, 255, 255, 0.12)",
      hover: "rgba(255, 255, 255, 0.20)",
      active: "rgba(255, 255, 255, 0.30)",
    },
    // trmx-98: find-bar highlights — low-luminance accent tint (the dark-theme pattern).
    search: { match: "rgba(189, 147, 249, 0.16)", activeMatch: "rgba(189, 147, 249, 0.24)" },
  },
};
