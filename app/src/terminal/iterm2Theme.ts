// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-44: Termixion's terminal should look like a fresh iTerm2 install. iTerm2's out-of-box appearance is
// its shipped default profile (codes/iTerm2/plists/DefaultBookmark.plist, loaded over the profile by
// ITAddressBookMgr.m): 12 pt, vertical/horizontal cell spacing 1.0, a solid non-blinking block cursor,
// anti-aliasing on, and an ADAPTIVE light/dark color theme (it ships "Use Separate Colors for Light and Dark
// Mode" and follows the system appearance). The 16 ANSI colors are identical across modes; only the
// primaries flip. trmx-46: the font intentionally diverges from that profile — Termixion uses the current
// macOS system monospaced font (SF Mono) instead of iTerm2's Monaco (see ITERM2_FONT_FAMILY below); size,
// spacing, cursor, and colors still mirror the iTerm2 default. This module is the pure RECORD of those
// profile facts — no xterm/React/DOM runtime import, unit-testable headless.
// trmx-53: runtime COLORS no longer come from here — the theme catalog (src/theme/) is the single color
// source, and live OS-appearance following is superseded by an explicit persisted theme (the OS is
// consulted once, via initialAppearanceFromWindow below, to derive the first-run default: dark → Night,
// light → White; see src/theme/defaultTheme.ts). TerminalView still takes the NON-COLOR option set
// (font/spacing/cursor shape) from here at the `realDeps.createTerminal` chokepoint; the theme slice is
// overridden there by the catalog's xterm theme.
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

// trmx-46: the default font is the current macOS system monospaced font (SF Mono) at 12 pt, rather than
// iTerm2's own default of Monaco 12 (DefaultBookmark.plist "Normal Font" = "Monaco 12"). `ui-monospace` is
// the CSS generic that resolves to the platform's system monospaced font — SF Mono on macOS in WKWebView —
// so it tracks whatever the OS ships; "SF Mono", Menlo, and monospace are explicit fallbacks. Only the font
// diverges from the iTerm2 default; the size, spacing, cursor, and colors below still mirror that profile.
// trmx-80 (FR-13): these two are now the DEFAULTS behind the user settings terminal.fontFamily (empty =
// this stack) / terminal.fontSize — fontSettings.ts overlays the persisted values at the chokepoint.
export const ITERM2_FONT_FAMILY = 'ui-monospace, "SF Mono", Menlo, monospace';
export const ITERM2_FONT_SIZE = 12;

/**
 * The full xterm option set that reproduces iTerm2's default display for `mode`. This is the single value
 * fed to `new Terminal(...)` at the chokepoint. Spacing 1.0×1.0 maps to `lineHeight: 1` / `letterSpacing: 0`;
 * the solid non-blinking block cursor and "Use Bright Bold" map to `cursorStyle`/`cursorBlink`/
 * `drawBoldTextInBrightColors`. Emulation-semantics options (e.g. `convertEol`) are NOT display
 * facts and live in emulationOptions.ts (trmx-64) — this module records the iTerm2 LOOK only.
 */
export function iterm2TerminalOptions(mode: Appearance): ITerminalOptions {
  return {
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
