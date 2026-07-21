// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-201: Nord — arctic blue-gray. Palette copied verbatim from nordtheme/nord @ 1cef71605416
// (Polar Night nord0–nord3, Snow Storm nord4–nord6, Frost nord7–nord10, Aurora nord11–nord15).
// ANSI mapping per the official Nord terminal ports (black/brightBlack = nord1/nord3, white =
// nord5, brightWhite = nord6, brights repeat the normal hues except brightCyan = nord7). UI
// tiers: nord0/nord1/nord2 backgrounds, nord6/nord4 text with the documented comment tone
// #616e88 as tertiary; nord8 accent (Nord's primary UI accent).
// trmx-201 audited deviation (G2, the trmx-77 precedent): ansi.brightBlack nord3 #4c566a
// measured 1.69:1 on nord0 (gate ≥2.5); Nord's documented comment tone #616e88 still fails at
// 2.44 → #66738f (2.63), the minimal brighten inside the same polar-night blue-gray family.
// See docs/design/visual-baseline.md §4.
import type { ThemeTokens } from "../tokens";

export const nord: ThemeTokens = {
  isDark: true,
  color: {
    bg: { primary: "#2e3440", secondary: "#3b4252", tertiary: "#434c5e" },
    text: { primary: "#eceff4", secondary: "#d8dee9", tertiary: "#616e88" },
    accent: { primary: "#88c0d0", bg: "rgba(136, 192, 208, 0.12)" },
    border: "#434c5e",
    selection: "rgba(136, 192, 208, 0.22)",
    semantic: { error: "#bf616a", errorBg: "rgba(191, 97, 106, 0.15)", success: "#a3be8c" },
  },
  terminal: {
    // trmx-87 (FR-3.6): Kitty pane borders — active = accent (outlines the focused pane), inactive = the theme border line.
    pane: { activeBorder: "#88c0d0", inactiveBorder: "#434c5e" },
    ansi: {
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#66738f",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
    cursor: "#d8dee9",
    cursorAccent: "#2e3440",
    selectionBackground: "rgba(136, 192, 208, 0.22)",
    // trmx-90: per-pane badge watermark. trmx-149: translucent pink #ff8da180 (50% alpha; Termixion's
    // chosen badge color, a deliberate deviation from iTerm2's default red) replaces the faint text tint.
    badge: "#ff8da180",
    scrollbar: {
      idle: "rgba(255, 255, 255, 0.12)",
      hover: "rgba(255, 255, 255, 0.20)",
      active: "rgba(255, 255, 255, 0.30)",
    },
    // trmx-98: find-bar highlights — low-luminance frost tint (the dark-theme pattern; Nord is
    // deliberately low-saturation, so the accent tint stays subtle).
    search: { match: "rgba(136, 192, 208, 0.16)", activeMatch: "rgba(136, 192, 208, 0.24)" },
  },
};
