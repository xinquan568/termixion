// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53 (test-first): the catalog → xterm ITheme mapping. The terminal slice must land on the
// exact ITheme fields — including the scrollbarSlider* triple the Kitty overlay consumes (D3) —
// for a light and a dark theme, value-exactly.
import { describe, expect, it } from "vitest";
import { buildXtermTheme } from "./buildXtermTheme";
import { THEME_IDS, themes } from "./themes";

describe("buildXtermTheme", () => {
  it("maps the White theme onto the full ITheme shape, value-exactly", () => {
    expect(buildXtermTheme("white")).toEqual({
      background: "#FFFFFF",
      foreground: "#1a1a1a",
      cursor: "#1a1a1a",
      cursorAccent: "#FFFFFF",
      selectionBackground: "rgba(0,102,204,0.25)",
      black: "#2e3436",
      red: "#cc0000",
      green: "#3d7a04",
      yellow: "#8a7000",
      blue: "#3465a4",
      magenta: "#75507b",
      cyan: "#047a7c",
      white: "#767676",
      brightBlack: "#555753",
      brightRed: "#d42020",
      brightGreen: "#3a8000",
      brightYellow: "#8a7000",
      brightBlue: "#3a6faa",
      brightMagenta: "#885088",
      brightCyan: "#047878",
      brightWhite: "#767676",
      scrollbarSliderBackground: "rgba(0,0,0,0.10)",
      scrollbarSliderHoverBackground: "rgba(0,0,0,0.18)",
      scrollbarSliderActiveBackground: "rgba(0,0,0,0.25)",
    });
  });

  it("maps the Night theme onto the full ITheme shape, value-exactly", () => {
    expect(buildXtermTheme("night")).toEqual({
      background: "#23262b",
      foreground: "#d6d9de",
      cursor: "#d6d9de",
      cursorAccent: "#23262b",
      selectionBackground: "rgba(90, 168, 255, 0.22)",
      black: "#1a1d22",
      red: "#f85149",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681", // trmx-77 audited deviation (G2); see themes.acceptance.test.ts
      brightRed: "#ff7b72",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.12)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.20)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.30)",
    });
  });

  it("builds a complete theme for every catalog entry (background/foreground from the UI tiers)", () => {
    for (const id of THEME_IDS) {
      const theme = buildXtermTheme(id);
      expect(theme.background).toBe(themes[id].color.bg.primary);
      expect(theme.foreground).toBe(themes[id].color.text.primary);
      expect(theme.scrollbarSliderBackground).toBe(themes[id].terminal.scrollbar.idle);
    }
  });

  it("falls back safely on a junk id (defense-in-depth behind the registry's parse)", () => {
    // trmx-89 (D): buildXtermTheme now takes a plain string; resolveTheme supplies the White fallback.
    expect(buildXtermTheme("__proto__")).toEqual(buildXtermTheme("white"));
    expect(buildXtermTheme("hotdog-stand")).toEqual(buildXtermTheme("white"));
  });
});
