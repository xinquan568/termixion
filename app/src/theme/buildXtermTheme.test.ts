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
  it("maps the Catppuccin Latte theme onto the full ITheme shape, value-exactly", () => {
    expect(buildXtermTheme("catppuccin-latte")).toEqual({
      background: "#eff1f5",
      foreground: "#4c4f69",
      cursor: "#4c4f69",
      cursorAccent: "#eff1f5",
      selectionBackground: "rgba(30, 102, 245, 0.22)",
      black: "#bcc0cc",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#c17d18",
      blue: "#1e66f5",
      magenta: "#d64ca8",
      cyan: "#179299",
      white: "#5c5f77",
      brightBlack: "#8c8fa1",
      brightRed: "#d20f39",
      brightGreen: "#40a02b",
      brightYellow: "#c17d18",
      brightBlue: "#1e66f5",
      brightMagenta: "#d64ca8",
      brightCyan: "#179299",
      brightWhite: "#6c6f85",
      scrollbarSliderBackground: "rgba(0,0,0,0.10)",
      scrollbarSliderHoverBackground: "rgba(0,0,0,0.18)",
      scrollbarSliderActiveBackground: "rgba(0,0,0,0.25)",
    });
  });

  it("maps the Night theme onto the full ITheme shape, value-exactly", () => {
    expect(buildXtermTheme("night")).toEqual({
      background: "#000000",
      foreground: "#d6d9de",
      cursor: "#d6d9de",
      cursorAccent: "#000000",
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
    // trmx-89 (D) / trmx-202: resolveTheme supplies the derived-default fallback (jsdom -> night).
    expect(buildXtermTheme("__proto__")).toEqual(buildXtermTheme("night"));
    expect(buildXtermTheme("hotdog-stand")).toEqual(buildXtermTheme("night"));
  });
});
