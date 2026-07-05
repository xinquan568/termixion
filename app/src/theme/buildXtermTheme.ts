// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: compose an xterm.js theme from a catalog theme — the one place that knows how the
// token schema maps onto xterm's flat shape (vmark's buildXtermTheme, origin/main @ d7e70e3f).
// background/foreground come from the UI tiers (bg.primary/text.primary); the terminal slice
// supplies the cursor tints, selection, the 16 ANSI colors, and the scrollbar triple. The
// scrollbar fields are a Termixion EXTENSION of xterm 5.5's `ITheme` (`TerminalTheme` below —
// the VS Code-style `scrollbarSlider*` names; xterm itself ignores unknown theme keys): they
// ride `terminal.options.theme` purely so the Kitty-style overlay (trmx-41) can read its colors
// off the live terminal with no extra plumbing (plan D3). Pure module: type-only xterm import.
import type { ITheme } from "@xterm/xterm";
import { resolveTheme } from "./registry";

/** xterm's `ITheme` plus Termixion's scrollbar-token transport (consumed by scrollbar.ts). */
export interface TerminalTheme extends ITheme {
  scrollbarSliderBackground: string;
  scrollbarSliderHoverBackground: string;
  scrollbarSliderActiveBackground: string;
}

/**
 * Build the complete xterm theme for any theme id (built-in or `user:<stem>`). trmx-89 (D):
 * resolution + the White fallback for junk ids (corrupted storage past the registry's parse,
 * `"__proto__"`, an unregistered user id) live in `resolveTheme` now — one hasOwnProperty-guarded
 * White fallback shared with every other consumer.
 */
export function buildXtermTheme(id: string): TerminalTheme {
  const theme = resolveTheme(id);
  const { color, terminal } = theme;
  const { ansi } = terminal;

  return {
    background: color.bg.primary,
    foreground: color.text.primary,
    cursor: terminal.cursor,
    cursorAccent: terminal.cursorAccent,
    selectionBackground: terminal.selectionBackground,

    black: ansi.black,
    red: ansi.red,
    green: ansi.green,
    yellow: ansi.yellow,
    blue: ansi.blue,
    magenta: ansi.magenta,
    cyan: ansi.cyan,
    white: ansi.white,

    brightBlack: ansi.brightBlack,
    brightRed: ansi.brightRed,
    brightGreen: ansi.brightGreen,
    brightYellow: ansi.brightYellow,
    brightBlue: ansi.brightBlue,
    brightMagenta: ansi.brightMagenta,
    brightCyan: ansi.brightCyan,
    brightWhite: ansi.brightWhite,

    scrollbarSliderBackground: terminal.scrollbar.idle,
    scrollbarSliderHoverBackground: terminal.scrollbar.hover,
    scrollbarSliderActiveBackground: terminal.scrollbar.active,
  };
}
