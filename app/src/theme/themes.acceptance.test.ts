// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: per-theme acceptance tests (modeled on vmark's `__acceptance__` suite). The fixtures
// below pin every theme's core UI tokens (the issue's table) and its COMPLETE terminal slice —
// all 16 ANSI colors, cursor, cursorAccent, selectionBackground, and the scrollbar triple.
// trmx-53 pinned them value-exactly to vmark origin/main @ d7e70e3f9eef21789e9f9974cbb7d2b90fa5b076.
// trmx-77 FORKED the pin: the fixtures now record Termixion's AUDITED visual baseline
// (docs/design/visual-baseline.md), which deviates from vmark in exactly two values that failed
// the legibility gates below — night.ansi.brightBlack #484f58 → #6e7681 (G2) and
// solarized.selectionBackground alpha 0.22 → 0.15 (G3).
// trmx-183 widened the Night deviation set: the command-line window background is pure black —
// night.bg #23262b → #000000, its tiers re-derived via shade(+4)/(+8) (#0a0a0a/#141414), and
// cursorAccent tracks the bg (#000000). Every other value remains vmark-exact;
// any future drift must pass the CONTRAST_GATES and update docs/design/visual-baseline.md.
import { describe, expect, it } from "vitest";
import { compositeOver, contrastRatio, relativeLuminance, toOpaqueHex } from "./contrast";
import { THEME_IDS, themeLabel, themes, type BuiltinThemeId } from "./themes";
import type { ThemeTokens } from "./tokens";

// trmx-89 (D): ThemeId widened to `string`; these fixtures are keyed by the closed BUILT-IN catalog
// exactly, so they use `BuiltinThemeId` — TypeScript still errors if a built-in is missing (the
// exhaustiveness the catalog acceptance suite depends on) even though ThemeId no longer would.

/** The issue's core-token table (bg.primary / bg.secondary / text.primary / accent / border / dark). */
const CORE: Record<BuiltinThemeId, { bg: string; bg2: string; text: string; accent: string; border: string; dark: boolean }> = {
  night: { bg: "#000000", bg2: "#0a0a0a", text: "#d6d9de", accent: "#58a6ff", border: "#3a3f46", dark: true },
  solarized: { bg: "#002b36", bg2: "#073642", text: "#93a1a1", accent: "#268bd2", border: "#0e4753", dark: true },
  // trmx-201: the six community themes (issue-table order; upstream citations in each module).
  "catppuccin-mocha": { bg: "#1e1e2e", bg2: "#181825", text: "#cdd6f4", accent: "#89b4fa", border: "#45475a", dark: true },
  "catppuccin-latte": { bg: "#eff1f5", bg2: "#e6e9ef", text: "#4c4f69", accent: "#1e66f5", border: "#ccd0da", dark: false },
  dracula: { bg: "#282a36", bg2: "#21222c", text: "#f8f8f2", accent: "#bd93f9", border: "#44475a", dark: true },
  gruvbox: { bg: "#282828", bg2: "#3c3836", text: "#ebdbb2", accent: "#fe8019", border: "#504945", dark: true },
  nord: { bg: "#2e3440", bg2: "#3b4252", text: "#eceff4", accent: "#88c0d0", border: "#434c5e", dark: true },
  "tokyo-night": { bg: "#1a1b26", bg2: "#16161e", text: "#c0caf5", accent: "#7aa2f7", border: "#3b4261", dark: true },
};

/** Full terminal slices — vmark origin/main @ d7e70e3f plus the two trmx-77 audited deviations
 *  (night.brightBlack, solarized.selectionBackground); see the header comment.
 *  trmx-149: every theme's `badge` is Termixion's default badge — translucent pink #ff8da180 (50%
 *  alpha; a deliberate deviation from iTerm2's default red rgba(255,0,0,0.5) @ iTermProfilePreferences.m:890
 *  that keeps the pink hue while matching iTerm2's watermark translucency),
 *  replacing the trmx-90 faint per-theme text tints. */
const TERMINAL: Record<BuiltinThemeId, ThemeTokens["terminal"]> = {
  night: {
    pane: { activeBorder: "#58a6ff", inactiveBorder: "#3a3f46" },
    ansi: {
      black: "#1a1d22", red: "#f85149", green: "#3fb950", yellow: "#d29922",
      blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
      brightBlack: "#6e7681", brightRed: "#ff7b72", brightGreen: "#56d364", brightYellow: "#e3b341",
      brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
    },
    cursor: "#d6d9de",
    cursorAccent: "#000000",
    selectionBackground: "rgba(90, 168, 255, 0.22)",
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(255, 255, 255, 0.12)", hover: "rgba(255, 255, 255, 0.20)", active: "rgba(255, 255, 255, 0.30)" },
    search: { match: "rgba(88, 166, 255, 0.16)", activeMatch: "rgba(88, 166, 255, 0.24)" },
  },
  solarized: {
    pane: { activeBorder: "#268bd2", inactiveBorder: "#0e4753" },
    ansi: {
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
      brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
    cursor: "#93a1a1",
    cursorAccent: "#002b36",
    selectionBackground: "rgba(38, 139, 210, 0.15)",
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(255, 255, 255, 0.12)", hover: "rgba(255, 255, 255, 0.20)", active: "rgba(255, 255, 255, 0.30)" },
    search: { match: "rgba(38, 139, 210, 0.09)", activeMatch: "rgba(38, 139, 210, 0.12)" },
  },
  // trmx-201: the six community themes — palettes from the upstreams pinned in each module's
  // header; audited G-gate deviations (if any) are documented there + visual-baseline §4.
  "catppuccin-mocha": {
    pane: { activeBorder: "#89b4fa", inactiveBorder: "#45475a" },
    ansi: {
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
      brightBlack: "#6c7086", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af",
      brightBlue: "#89b4fa", brightMagenta: "#f5c2e7", brightCyan: "#94e2d5", brightWhite: "#a6adc8",
    },
    cursor: "#f5e0dc",
    cursorAccent: "#1e1e2e",
    selectionBackground: "rgba(137, 180, 250, 0.22)",
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(255, 255, 255, 0.12)", hover: "rgba(255, 255, 255, 0.20)", active: "rgba(255, 255, 255, 0.30)" },
    search: { match: "rgba(137, 180, 250, 0.16)", activeMatch: "rgba(137, 180, 250, 0.24)" },
  },
  "catppuccin-latte": {
    pane: { activeBorder: "#1e66f5", inactiveBorder: "#ccd0da" },
    ansi: {
      black: "#bcc0cc", red: "#d20f39", green: "#40a02b", yellow: "#c17d18",
      blue: "#1e66f5", magenta: "#d64ca8", cyan: "#179299", white: "#5c5f77",
      brightBlack: "#8c8fa1", brightRed: "#d20f39", brightGreen: "#40a02b", brightYellow: "#c17d18",
      brightBlue: "#1e66f5", brightMagenta: "#d64ca8", brightCyan: "#179299", brightWhite: "#6c6f85",
    },
    cursor: "#4c4f69",
    cursorAccent: "#eff1f5",
    selectionBackground: "rgba(30, 102, 245, 0.22)",
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
    search: { match: "rgba(250, 204, 21, 0.30)", activeMatch: "rgba(255, 138, 0, 0.48)" },
  },
  dracula: {
    pane: { activeBorder: "#bd93f9", inactiveBorder: "#44475a" },
    ansi: {
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
      brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "rgba(189, 147, 249, 0.22)",
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(255, 255, 255, 0.12)", hover: "rgba(255, 255, 255, 0.20)", active: "rgba(255, 255, 255, 0.30)" },
    search: { match: "rgba(189, 147, 249, 0.16)", activeMatch: "rgba(189, 147, 249, 0.24)" },
  },
  gruvbox: {
    pane: { activeBorder: "#fe8019", inactiveBorder: "#504945" },
    ansi: {
      black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921",
      blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
      brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26", brightYellow: "#fabd2f",
      brightBlue: "#83a598", brightMagenta: "#d3869b", brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
    },
    cursor: "#ebdbb2",
    cursorAccent: "#282828",
    selectionBackground: "rgba(254, 128, 25, 0.20)",
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(255, 255, 255, 0.12)", hover: "rgba(255, 255, 255, 0.20)", active: "rgba(255, 255, 255, 0.30)" },
    search: { match: "rgba(250, 189, 47, 0.15)", activeMatch: "rgba(254, 128, 25, 0.30)" },
  },
  nord: {
    pane: { activeBorder: "#88c0d0", inactiveBorder: "#434c5e" },
    ansi: {
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#66738f", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
    cursor: "#d8dee9",
    cursorAccent: "#2e3440",
    selectionBackground: "rgba(136, 192, 208, 0.22)",
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(255, 255, 255, 0.12)", hover: "rgba(255, 255, 255, 0.20)", active: "rgba(255, 255, 255, 0.30)" },
    search: { match: "rgba(136, 192, 208, 0.16)", activeMatch: "rgba(136, 192, 208, 0.24)" },
  },
  "tokyo-night": {
    pane: { activeBorder: "#7aa2f7", inactiveBorder: "#3b4261" },
    ansi: {
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#565f89", brightRed: "#ff899d", brightGreen: "#9fe044", brightYellow: "#faba4a",
      brightBlue: "#8db0ff", brightMagenta: "#c7a9ff", brightCyan: "#a4daff", brightWhite: "#c0caf5",
    },
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selectionBackground: "rgba(122, 162, 247, 0.22)",
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(255, 255, 255, 0.12)", hover: "rgba(255, 255, 255, 0.20)", active: "rgba(255, 255, 255, 0.30)" },
    search: { match: "rgba(122, 162, 247, 0.16)", activeMatch: "rgba(122, 162, 247, 0.24)" },
  },
};

describe("theme catalog", () => {
  // trmx-202: the light novelty themes are gone; the catalog is the eight community/core themes
  // displayed lightest -> darkest (the luminance-derived order below, not declaration order).
  it("registers exactly the eight themes, lightest to darkest", () => {
    expect(THEME_IDS).toEqual([
      "catppuccin-latte", "nord", "dracula", "gruvbox", "solarized",
      "catppuccin-mocha", "tokyo-night", "night",
    ]);
    expect([...Object.keys(themes)].sort()).toEqual([...THEME_IDS].sort());
  });

  // trmx-202: the order is COMPUTED — bg.primary relative luminance desc, tie-break ascending id —
  // so a future theme slots in with zero ordering upkeep and this test cannot drift from the impl.
  it("derives the display order from bg.primary luminance", () => {
    const computed = (Object.keys(themes) as BuiltinThemeId[]).sort((a, b) => {
      const d =
        relativeLuminance(themes[b].color.bg.primary) -
        relativeLuminance(themes[a].color.bg.primary);
      return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
    });
    expect(THEME_IDS).toEqual(computed);
  });

  it("marks all but catppuccin-latte as dark", () => {
    const dark = THEME_IDS.filter((id) => themes[id].isDark);
    expect(dark).toEqual([
      "nord", "dracula", "gruvbox", "solarized", "catppuccin-mocha", "tokyo-night", "night",
    ]);
  });

  it("derives display labels from the ids", () => {
    expect(THEME_IDS.map(themeLabel)).toEqual([
      "Catppuccin Latte",
      "Nord",
      "Dracula",
      "Gruvbox",
      "Solarized",
      "Catppuccin Mocha",
      "Tokyo Night",
      "Night",
    ]);
  });
});

describe.each(THEME_IDS)("theme %s", (id) => {
  const theme = themes[id];

  it("matches the issue's core-token table exactly", () => {
    const core = CORE[id];
    expect(theme.color.bg.primary).toBe(core.bg);
    expect(theme.color.bg.secondary).toBe(core.bg2);
    expect(theme.color.text.primary).toBe(core.text);
    expect(theme.color.accent.primary).toBe(core.accent);
    expect(theme.color.border).toBe(core.border);
    expect(theme.isDark).toBe(core.dark);
  });

  it("carries vmark's complete terminal slice, value-exact", () => {
    expect(theme.terminal).toEqual(TERMINAL[id]);
  });

  // trmx-90 (sub-task B): every built-in ships a per-pane badge watermark — non-empty and a valid
  // color the contrast math can composite over the terminal background (never throws).
  // trmx-149: the value is Termixion's translucent pink #ff8da180 (50% alpha), pinned in TERMINAL
  // above. Because it now carries alpha, resolve it via toOpaqueHex (the tolerant compositor that
  // accepts #rrggbbaa) rather than compositeOver (whose strict hex branch is #rgb/#rrggbb only).
  it("has a non-empty, valid translucent badge watermark", () => {
    const badge = theme.terminal.badge;
    expect(badge).not.toBe("");
    expect(badge).toMatch(/^(#[0-9a-f]{3,8}|rgba?\([\d.,\s]+\))$/i);
    expect(() => toOpaqueHex(badge, theme.color.bg.primary)).not.toThrow();
  });

  it("has a fully-populated color set (no empty strings)", () => {
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        expect(value).not.toBe("");
      } else if (typeof value === "object" && value !== null) {
        Object.values(value).forEach(walk);
      }
    };
    walk(theme.color);
    walk(theme.terminal);
  });
});

// trmx-77: the FR-3.6 legibility gates (G1–G4) — the catalog-wide regression floor locked by
// docs/design/visual-baseline.md §4, which records the thresholds' rationale and the measured
// matrix. Floors, not targets: WCAG-anchored and chosen so every audited token passes; a future
// theme (or token tweak) that regresses legibility fails here. G5 (settings-surface on-accent
// text) lives with its surface in txCssVars.test.ts.
export const CONTRAST_GATES = {
  /** G1: text.primary vs bg.primary — WCAG AA normal text. */
  foreground: 4.5,
  /** G2: each ANSI color vs bg.primary. `black` is exempt — it doubles as the TUI background
   *  color, and every canonical dark theme keeps it ≈ bg (iTerm2's is ≈1.0); see doc §4. */
  ansi: 2.5,
  /** G3: text.primary vs the selection tint composited over bg.primary (the token schema has no
   *  selectionForeground — xterm keeps per-glyph colors, so the theme foreground is the floor). */
  selectedText: 4.5,
  /** G4: cursor vs bg.primary — WCAG 1.4.11 UI-component contrast. */
  cursor: 3,
  /** G6 (trmx-98): text.primary vs each search-highlight tint composited over bg.primary. The GLYPH is
   *  drawn OVER the decoration, so this is body-text legibility (WCAG AA 4.5), not a UI-component state —
   *  match & activeMatch tints stay low-alpha (esp. the low-contrast dark themes) so text keeps 4.5:1. */
  searchText: 4.5,
} as const;

describe.each(THEME_IDS)("legibility gates (trmx-77) — %s", (id) => {
  const theme = themes[id];
  const bg = theme.color.bg.primary;

  it(`G1: foreground ≥ ${CONTRAST_GATES.foreground}:1 on the terminal background`, () => {
    expect(contrastRatio(theme.color.text.primary, bg)).toBeGreaterThanOrEqual(
      CONTRAST_GATES.foreground,
    );
  });

  it(`G2: every ANSI color except black ≥ ${CONTRAST_GATES.ansi}:1 on the terminal background`, () => {
    const failures: string[] = [];
    for (const [name, value] of Object.entries(theme.terminal.ansi)) {
      if (name === "black") continue; // exempt — TUI background role (doc §4)
      const ratio = contrastRatio(value, bg);
      if (ratio < CONTRAST_GATES.ansi) {
        failures.push(`${name} ${value} = ${ratio.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it(`G3: selected text ≥ ${CONTRAST_GATES.selectedText}:1 (foreground vs composited selection)`, () => {
    const selection = compositeOver(theme.terminal.selectionBackground, bg);
    expect(contrastRatio(theme.color.text.primary, selection)).toBeGreaterThanOrEqual(
      CONTRAST_GATES.selectedText,
    );
  });

  it(`G4: cursor ≥ ${CONTRAST_GATES.cursor}:1 on the terminal background`, () => {
    expect(contrastRatio(theme.terminal.cursor, bg)).toBeGreaterThanOrEqual(
      CONTRAST_GATES.cursor,
    );
  });

  // trmx-87 (FR-3.6): the FOCUSED pane's border must read as "focused" against the background — the same
  // UI-component contrast the cursor uses. (The inactive border is a subtle line — presence-only, below.)
  it(`G5: pane activeBorder ≥ ${CONTRAST_GATES.cursor}:1 on the terminal background`, () => {
    expect(contrastRatio(theme.terminal.pane.activeBorder, bg)).toBeGreaterThanOrEqual(
      CONTRAST_GATES.cursor,
    );
  });

  // trmx-98 (FR-1.5): a search-highlighted match must stay legible — text.primary vs each translucent
  // find tint composited over the background (both match and the distinct active-match tint).
  it(`G6: search highlights ≥ ${CONTRAST_GATES.searchText}:1 (foreground vs composited match & activeMatch)`, () => {
    const match = compositeOver(theme.terminal.search.match, bg);
    const activeMatch = compositeOver(theme.terminal.search.activeMatch, bg);
    expect(contrastRatio(theme.color.text.primary, match)).toBeGreaterThanOrEqual(
      CONTRAST_GATES.searchText,
    );
    expect(contrastRatio(theme.color.text.primary, activeMatch)).toBeGreaterThanOrEqual(
      CONTRAST_GATES.searchText,
    );
  });

  it("G5b: pane inactiveBorder is present and distinct from the active border", () => {
    expect(theme.terminal.pane.inactiveBorder).toMatch(/^#|rgb/);
    expect(theme.terminal.pane.inactiveBorder).not.toBe(theme.terminal.pane.activeBorder);
  });
});
