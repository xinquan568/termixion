// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: typed theme tokens — Termixion's port of vmark's post-theme-unification `ThemeTokens`
// (vmark origin/main src/theme/tokens.ts @ d7e70e3f), pruned to the fields Termixion's surfaces
// actually consume. Each theme file provides one `ThemeTokens` value: the UI color tiers that
// drive the settings window's `--tx-*` variables, plus a complete terminal slice (a hand-tuned
// 16-color ANSI palette per background, cursor tints, selection, and the scrollbar triple) that
// drives the xterm theme and the Kitty-style scrollbar. Pure data — no DOM/xterm/React runtime
// imports — so the catalog is unit-testable headless and is the single source of truth for every
// color in the app (the vmark ADR-014 invariant: adding a theme = one new file + one catalog
// entry). vmark fields Termixion has no surface for (alert/media tints, editor `legacy` vars,
// spacing/typography primitives) are deliberately not ported.

/** 16-color ANSI palette consumed by the xterm.js terminal. */
export interface AnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeTokens {
  /** Whether this theme is dark — the single source of dark/light classification. */
  isDark: boolean;
  color: {
    /** primary = window/content background; secondary = sidebar/sunken; tertiary = elevated. */
    bg: { primary: string; secondary: string; tertiary: string };
    text: { primary: string; secondary: string; tertiary: string };
    accent: { primary: string; bg: string };
    border: string;
    /** UI text-selection tint (the terminal has its own selectionBackground below). */
    selection: string;
    semantic: { error: string; errorBg: string; success: string };
  };
  /**
   * Terminal-specific colors. The ANSI palette, cursor tints, and selection flow to the xterm
   * `ITheme` via `buildXtermTheme()`; the scrollbar triple rides the same `ITheme`'s
   * `scrollbarSlider*` fields and is consumed by the Kitty-style overlay (trmx-41).
   */
  terminal: {
    ansi: AnsiPalette;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    scrollbar: { idle: string; hover: string; active: string };
    /**
     * trmx-87 (FR-3.6): the multi-pane "Kitty look" border colors. In our flat-rect model the divider
     * IS the pane border — `activeBorder` outlines the FOCUSED pane (accent-derived, must read clearly
     * against `bg.primary`), `inactiveBorder` is the subtle line between unfocused panes (border-derived).
     */
    pane: { activeBorder: string; inactiveBorder: string };
  };
}

/** Light-theme `color.semantic` block — identical across white/paper/mint/sepia (vmark's `semanticLight`, pruned). */
export const semanticLight: ThemeTokens["color"]["semantic"] = {
  error: "#cf222e",
  errorBg: "#ffebe9",
  success: "#16a34a",
};
