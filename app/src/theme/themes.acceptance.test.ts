// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: per-theme acceptance tests (modeled on vmark's `__acceptance__` suite). The fixtures
// below pin every theme's core UI tokens (the issue's table) and its COMPLETE terminal slice —
// all 16 ANSI colors, cursor, cursorAccent, selectionBackground, and the scrollbar triple —
// value-exactly to vmark origin/main @ d7e70e3f9eef21789e9f9974cbb7d2b90fa5b076. The catalog is
// the single runtime color source; if these drift, the app no longer renders vmark's themes.
import { describe, expect, it } from "vitest";
import { THEME_IDS, themeLabel, themes, type ThemeId } from "./themes";
import type { ThemeTokens } from "./tokens";

/** The issue's core-token table (bg.primary / bg.secondary / text.primary / accent / border / dark). */
const CORE: Record<ThemeId, { bg: string; bg2: string; text: string; accent: string; border: string; dark: boolean }> = {
  white: { bg: "#FFFFFF", bg2: "#f8f8f8", text: "#1a1a1a", accent: "#0066cc", border: "#eeeeee", dark: false },
  paper: { bg: "#EEEDED", bg2: "#e5e4e4", text: "#1a1a1a", accent: "#0066cc", border: "#d5d4d4", dark: false },
  mint: { bg: "#CCE6D0", bg2: "#b8d9bd", text: "#2d3a35", accent: "#1a6b4a", border: "#a8c9ad", dark: false },
  sepia: { bg: "#F9F0DB", bg2: "#f0e5cc", text: "#5c4b37", accent: "#8b4513", border: "#e0d5bc", dark: false },
  night: { bg: "#23262b", bg2: "#2a2e34", text: "#d6d9de", accent: "#58a6ff", border: "#3a3f46", dark: true },
  solarized: { bg: "#002b36", bg2: "#073642", text: "#93a1a1", accent: "#268bd2", border: "#0e4753", dark: true },
};

/** Full terminal slices, verbatim from vmark origin/main @ d7e70e3f (per-theme files). */
const TERMINAL: Record<ThemeId, ThemeTokens["terminal"]> = {
  white: {
    ansi: {
      black: "#2e3436", red: "#cc0000", green: "#3d7a04", yellow: "#8a7000",
      blue: "#3465a4", magenta: "#75507b", cyan: "#047a7c", white: "#767676",
      brightBlack: "#555753", brightRed: "#d42020", brightGreen: "#3a8000", brightYellow: "#8a7000",
      brightBlue: "#3a6faa", brightMagenta: "#885088", brightCyan: "#047878", brightWhite: "#767676",
    },
    cursor: "#1a1a1a",
    cursorAccent: "#FFFFFF",
    selectionBackground: "rgba(0,102,204,0.25)",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
  },
  paper: {
    ansi: {
      black: "#2e3436", red: "#c33820", green: "#387204", yellow: "#806800",
      blue: "#2f5a92", magenta: "#7b4d82", cyan: "#086e6e", white: "#595959",
      brightBlack: "#5c5c5a", brightRed: "#c03820", brightGreen: "#367004", brightYellow: "#806800",
      brightBlue: "#3a6494", brightMagenta: "#7d4d84", brightCyan: "#086c6c", brightWhite: "#595959",
    },
    cursor: "#1a1a1a",
    cursorAccent: "#EEEDED",
    selectionBackground: "rgba(0,102,204,0.25)",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
  },
  mint: {
    ansi: {
      black: "#2a3832", red: "#9e3020", green: "#246428", yellow: "#7a5c00",
      blue: "#155878", magenta: "#7b4a8a", cyan: "#0a6571", white: "#3d5240",
      brightBlack: "#4d6054", brightRed: "#a83828", brightGreen: "#2a6a2e", brightYellow: "#7a5c00",
      brightBlue: "#1a6896", brightMagenta: "#7a4490", brightCyan: "#0e6b7a", brightWhite: "#3d5240",
    },
    cursor: "#2d3a35",
    cursorAccent: "#CCE6D0",
    selectionBackground: "rgba(0,102,204,0.25)",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
  },
  sepia: {
    ansi: {
      black: "#3e3328", red: "#b5421a", green: "#4a6818", yellow: "#7a5c00",
      blue: "#4a6a8a", magenta: "#8a5470", cyan: "#1e645e", white: "#5e5345",
      brightBlack: "#6b5d4f", brightRed: "#b04828", brightGreen: "#4e7018", brightYellow: "#886200",
      brightBlue: "#3e6490", brightMagenta: "#8a5470", brightCyan: "#267a6e", brightWhite: "#5e5345",
    },
    cursor: "#5c4b37",
    cursorAccent: "#F9F0DB",
    selectionBackground: "rgba(0,102,204,0.25)",
    scrollbar: { idle: "rgba(0,0,0,0.10)", hover: "rgba(0,0,0,0.18)", active: "rgba(0,0,0,0.25)" },
  },
  night: {
    ansi: {
      black: "#1a1d22", red: "#f85149", green: "#3fb950", yellow: "#d29922",
      blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
      brightBlack: "#484f58", brightRed: "#ff7b72", brightGreen: "#56d364", brightYellow: "#e3b341",
      brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
    },
    cursor: "#d6d9de",
    cursorAccent: "#23262b",
    selectionBackground: "rgba(90, 168, 255, 0.22)",
    scrollbar: { idle: "rgba(255, 255, 255, 0.12)", hover: "rgba(255, 255, 255, 0.20)", active: "rgba(255, 255, 255, 0.30)" },
  },
  solarized: {
    ansi: {
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
      brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
    cursor: "#93a1a1",
    cursorAccent: "#002b36",
    selectionBackground: "rgba(38, 139, 210, 0.22)",
    scrollbar: { idle: "rgba(255, 255, 255, 0.12)", hover: "rgba(255, 255, 255, 0.20)", active: "rgba(255, 255, 255, 0.30)" },
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
