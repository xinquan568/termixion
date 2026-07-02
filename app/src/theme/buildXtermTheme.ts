// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: compose an xterm.js `ITheme` from a catalog theme — the one place that knows how the
// token schema maps onto xterm's flat shape (vmark's buildXtermTheme, origin/main @ d7e70e3f).
// background/foreground come from the UI tiers (bg.primary/text.primary); the terminal slice
// supplies the cursor tints, selection, the 16 ANSI colors, and the scrollbar triple — the
// latter rides the standard `scrollbarSlider*` fields so the Kitty-style overlay (trmx-41) can
// read its colors straight off `terminal.options.theme` (plan D3). Pure module: type-only xterm
// import, no runtime dependency.
import type { ITheme } from "@xterm/xterm";
import { themes, type ThemeId } from "./themes";

/**
 * Build the complete xterm theme for a catalog id. Junk ids (corrupted storage reaching past the
 * registry's parse, `"__proto__"`, …) fall back to White — `hasOwnProperty`, not `themes[id] ??`,
 * so prototype keys cannot skip the guard (vmark's defense).
 */
export function buildXtermTheme(id: ThemeId): ITheme {
  const theme = Object.prototype.hasOwnProperty.call(themes, id) ? themes[id] : themes.white;
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
