// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-44: Termixion's terminal should look like a fresh iTerm2 install. iTerm2's out-of-box appearance is
// its shipped default profile (codes/iTerm2/plists/DefaultBookmark.plist, loaded over the profile by
// ITAddressBookMgr.m): Monaco 12 pt, vertical/horizontal cell spacing 1.0, a solid non-blinking block
// cursor, anti-aliasing on, and an ADAPTIVE light/dark color theme (it ships "Use Separate Colors for Light
// and Dark Mode" and follows the system appearance). The 16 ANSI colors are identical across modes; only the
// primaries flip. This module is the pure source of those values — no xterm/React/DOM runtime import — so it
// is unit-testable headless and is the single place the palette is defined. TerminalView consumes it at the
// `realDeps.createTerminal` chokepoint and on live appearance changes.
import type { ITheme, ITerminalOptions } from "@xterm/xterm";

/** Which iTerm2 color mode to render — selected from the system appearance. */
export type Appearance = "dark" | "light";

// iTerm2's 16 ANSI colors (DefaultBookmark.plist "Ansi N Color"), identical in dark and light mode.
export const ITERM2_ANSI = {
  black: "#14191E",
  red: "#B43C2A",
  green: "#00C200",
  yellow: "#C7C400",
  blue: "#2744C7",
  magenta: "#C040BE",
  cyan: "#00C5C7",
  white: "#C7C7C7",
  brightBlack: "#686868",
  brightRed: "#DD7975",
  brightGreen: "#58E790",
  brightYellow: "#ECE100",
  brightBlue: "#A7ABF2",
  brightMagenta: "#E17EE1",
  brightCyan: "#60FDFF",
  brightWhite: "#FFFFFF",
} as const;

// The mode-specific primaries (foreground/background/cursor/selection). iTerm2's selection is the same light
// blue with black text in both modes; the cursor and its text colour invert with the background.
const ITERM2_PRIMARIES: Record<Appearance, Omit<ITheme, keyof typeof ITERM2_ANSI>> = {
  dark: {
    foreground: "#DCDCDC",
    background: "#15191F",
    cursor: "#FFFFFF",
    cursorAccent: "#000000",
    selectionBackground: "#B3D7FF",
    selectionForeground: "#000000",
  },
  light: {
    foreground: "#101010",
    background: "#FAFAFA",
    cursor: "#000000",
    cursorAccent: "#FFFFFF",
    selectionBackground: "#B3D7FF",
    selectionForeground: "#000000",
  },
};

/** The xterm theme matching iTerm2's default profile for the given mode. */
export function iterm2Theme(mode: Appearance): ITheme {
  return { ...ITERM2_PRIMARIES[mode], ...ITERM2_ANSI };
}

/** Map the OS `prefers-color-scheme: dark` boolean to an iTerm2 mode. */
export function prefersDarkToMode(prefersDark: boolean): Appearance {
  return prefersDark ? "dark" : "light";
}

/**
 * Read the current system appearance from a window-like object. Defensive: if `matchMedia` is unavailable
 * (e.g. a non-DOM/headless context), default to dark — Termixion's historical look.
 */
export function initialAppearanceFromWindow(
  win: Pick<Window, "matchMedia"> | undefined = typeof window !== "undefined" ? window : undefined,
): Appearance {
  if (!win || typeof win.matchMedia !== "function") return "dark";
  return prefersDarkToMode(win.matchMedia("(prefers-color-scheme: dark)").matches);
}

// iTerm2's default font is Monaco 12 (DefaultBookmark.plist "Normal Font" = "Monaco 12"). Monaco is a macOS
// system font available in WKWebView; Menlo/monospace are safe fallbacks.
export const ITERM2_FONT_FAMILY = "Monaco, Menlo, monospace";
export const ITERM2_FONT_SIZE = 12;

/**
 * The full xterm option set that reproduces iTerm2's default display for `mode`. This is the single value
 * fed to `new Terminal(...)` at the chokepoint. Spacing 1.0×1.0 maps to `lineHeight: 1` / `letterSpacing: 0`;
 * the solid non-blinking block cursor and "Use Bright Bold" map to `cursorStyle`/`cursorBlink`/
 * `drawBoldTextInBrightColors`. `convertEol` is preserved from Termixion's prior config.
 */
export function iterm2TerminalOptions(mode: Appearance): ITerminalOptions {
  return {
    convertEol: true,
    fontFamily: ITERM2_FONT_FAMILY,
    fontSize: ITERM2_FONT_SIZE,
    fontWeight: "normal",
    fontWeightBold: "bold",
    lineHeight: 1,
    letterSpacing: 0,
    cursorStyle: "block",
    cursorBlink: false,
    drawBoldTextInBrightColors: true,
    theme: iterm2Theme(mode),
  };
}
