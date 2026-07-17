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
import { compositeOver, contrastRatio, toOpaqueHex } from "./contrast";
import { THEME_IDS, themeLabel, themes, type BuiltinThemeId } from "./themes";
import type { ThemeTokens } from "./tokens";

// trmx-89 (D): ThemeId widened to `string`; these fixtures are keyed by the closed BUILT-IN catalog
// exactly, so they use `BuiltinThemeId` — TypeScript still errors if a built-in is missing (the
// exhaustiveness the catalog acceptance suite depends on) even though ThemeId no longer would.

/** The issue's core-token table (bg.primary / bg.secondary / text.primary / accent / border / dark). */
const CORE: Record<BuiltinThemeId, { bg: string; bg2: string; text: string; accent: string; border: string; dark: boolean }> = {
  white: { bg: "#FFFFFF", bg2: "#f8f8f8", text: "#1a1a1a", accent: "#0066cc", border: "#eeeeee", dark: false },
  paper: { bg: "#EEEDED", bg2: "#e5e4e4", text: "#1a1a1a", accent: "#0066cc", border: "#d5d4d4", dark: false },
  mint: { bg: "#CCE6D0", bg2: "#b8d9bd", text: "#2d3a35", accent: "#1a6b4a", border: "#a8c9ad", dark: false },
  sepia: { bg: "#F9F0DB", bg2: "#f0e5cc", text: "#5c4b37", accent: "#8b4513", border: "#e0d5bc", dark: false },
  night: { bg: "#000000", bg2: "#0a0a0a", text: "#d6d9de", accent: "#58a6ff", border: "#3a3f46", dark: true },
  solarized: { bg: "#002b36", bg2: "#073642", text: "#93a1a1", accent: "#268bd2", border: "#0e4753", dark: true },
};

/** Full terminal slices — vmark origin/main @ d7e70e3f plus the two trmx-77 audited deviations
 *  (night.brightBlack, solarized.selectionBackground); see the header comment.
 *  trmx-149: every theme's `badge` is Termixion's default badge — translucent pink #ff8da180 (50%
 *  alpha; a deliberate deviation from iTerm2's default red rgba(255,0,0,0.5) @ iTermProfilePreferences.m:890
 *  that keeps the pink hue while matching iTerm2's watermark translucency),
 *  replacing the trmx-90 faint per-theme text tints. */
const TERMINAL: Record<BuiltinThemeId, ThemeTokens["terminal"]> = {
  white: {
    pane: { activeBorder: "#0066cc", inactiveBorder: "#eeeeee" },
    ansi: {
      black: "#2e3436", red: "#cc0000", green: "#3d7a04", yellow: "#8a7000",
      blue: "#3465a4", magenta: "#75507b", cyan: "#047a7c", white: "#767676",
      brightBlack: "#555753", brightRed: "#d42020", brightGreen: "#3a8000", brightYellow: "#8a7000",
      brightBlue: "#3a6faa", brightMagenta: "#885088", brightCyan: "#047878", brightWhite: "#767676",
    },
    cursor: "#1a1a1a",
    cursorAccent: "#FFFFFF",
    selectionBackground: "rgba(0,102,204,0.25)",
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
    search: { match: "rgba(250, 204, 21, 0.30)", activeMatch: "rgba(255, 138, 0, 0.48)" },
  },
  paper: {
    pane: { activeBorder: "#0066cc", inactiveBorder: "#d5d4d4" },
    ansi: {
      black: "#2e3436", red: "#c33820", green: "#387204", yellow: "#806800",
      blue: "#2f5a92", magenta: "#7b4d82", cyan: "#086e6e", white: "#595959",
      brightBlack: "#5c5c5a", brightRed: "#c03820", brightGreen: "#367004", brightYellow: "#806800",
      brightBlue: "#3a6494", brightMagenta: "#7d4d84", brightCyan: "#086c6c", brightWhite: "#595959",
    },
    cursor: "#1a1a1a",
    cursorAccent: "#EEEDED",
    selectionBackground: "rgba(0,102,204,0.25)",
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
    search: { match: "rgba(250, 204, 21, 0.30)", activeMatch: "rgba(255, 138, 0, 0.48)" },
  },
  mint: {
    pane: { activeBorder: "#1a6b4a", inactiveBorder: "#a8c9ad" },
    ansi: {
      black: "#2a3832", red: "#9e3020", green: "#246428", yellow: "#7a5c00",
      blue: "#155878", magenta: "#7b4a8a", cyan: "#0a6571", white: "#3d5240",
      brightBlack: "#4d6054", brightRed: "#a83828", brightGreen: "#2a6a2e", brightYellow: "#7a5c00",
      brightBlue: "#1a6896", brightMagenta: "#7a4490", brightCyan: "#0e6b7a", brightWhite: "#3d5240",
    },
    cursor: "#2d3a35",
    cursorAccent: "#CCE6D0",
    selectionBackground: "rgba(0,102,204,0.25)",
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
    search: { match: "rgba(250, 204, 21, 0.30)", activeMatch: "rgba(255, 138, 0, 0.48)" },
  },
  sepia: {
    pane: { activeBorder: "#8b4513", inactiveBorder: "#e0d5bc" },
    ansi: {
      black: "#3e3328", red: "#b5421a", green: "#4a6818", yellow: "#7a5c00",
      blue: "#4a6a8a", magenta: "#8a5470", cyan: "#1e645e", white: "#5e5345",
      brightBlack: "#6b5d4f", brightRed: "#b04828", brightGreen: "#4e7018", brightYellow: "#886200",
      brightBlue: "#3e6490", brightMagenta: "#8a5470", brightCyan: "#267a6e", brightWhite: "#5e5345",
    },
    cursor: "#5c4b37",
    cursorAccent: "#F9F0DB",
    selectionBackground: "rgba(0,102,204,0.25)",
    badge: "#ff8da180",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
    search: { match: "rgba(250, 204, 21, 0.30)", activeMatch: "rgba(255, 138, 0, 0.48)" },
  },
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
};

describe("theme catalog", () => {
  it("registers exactly the six themes, in the issue's order", () => {
    expect(THEME_IDS).toEqual(["white", "paper", "mint", "sepia", "night", "solarized"]);
    expect(Object.keys(themes)).toEqual(THEME_IDS);
  });

  it("marks exactly night and solarized as dark", () => {
    const dark = THEME_IDS.filter((id) => themes[id].isDark);
    expect(dark).toEqual(["night", "solarized"]);
  });

  it("derives display labels from the ids", () => {
    expect(THEME_IDS.map(themeLabel)).toEqual([
      "White",
      "Paper",
      "Mint",
      "Sepia",
      "Night",
      "Solarized",
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
