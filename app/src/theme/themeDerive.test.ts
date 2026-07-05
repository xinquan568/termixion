// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (test-first): deriveTheme expands a minimal user ThemeSpec into a complete ThemeTokens —
// every optional filled from the required set, every value a valid CSS color, pure/deterministic, and
// an author-provided optional wins over the formula. Plus unit pins for the ./colorMath helpers.
import { describe, expect, it } from "vitest";
import { deriveTheme, type ThemeSpec } from "./themeDerive";
import { hexToRgb, mix, withAlpha } from "./colorMath";
import type { AnsiPalette } from "./tokens";

/** A neutral, easy-to-hand-verify 16-color palette (matches the contract's minimal example). */
const ANSI: AnsiPalette = {
  black: "#000000",
  red: "#ff0000",
  green: "#00ff00",
  yellow: "#ffff00",
  blue: "#0000ff",
  magenta: "#ff00ff",
  cyan: "#00ffff",
  white: "#ffffff",
  brightBlack: "#808080",
  brightRed: "#ff8080",
  brightGreen: "#80ff80",
  brightYellow: "#ffff80",
  brightBlue: "#8080ff",
  brightMagenta: "#ff80ff",
  brightCyan: "#80ffff",
  brightWhite: "#f0f6fc",
};

/** A ThemeSpec carrying ONLY the required set — every optional omitted, sub-objects empty (`{}`). */
function minimalSpec(isDark: boolean, bgPrimary = "#808080", textPrimary = "#cccccc"): ThemeSpec {
  return {
    isDark,
    color: {
      bg: { primary: bgPrimary },
      text: { primary: textPrimary },
      accent: {},
      semantic: {},
    },
    terminal: { ansi: { ...ANSI }, scrollbar: {}, pane: {} },
  };
}

/** Accept the two CSS color forms deriveTheme emits: `#rgb…#rrggbbaa` and `rgb()/rgba()`. */
const CSS_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s]+\))$/i;

/** Every string leaf of a nested token object (booleans/numbers are skipped). */
function leafStrings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (node && typeof node === "object") return Object.values(node).flatMap(leafStrings);
  return [];
}

describe("deriveTheme", () => {
  it("fills every optional from a minimal spec (exact derived palette)", () => {
    // Hand-computed from bg #808080 / text #cccccc / ansi.blue #0000ff etc. — pins the whole formula
    // table and simultaneously proves every optional is filled and no key is missing.
    expect(deriveTheme(minimalSpec(true))).toEqual({
      isDark: true,
      color: {
        bg: { primary: "#808080", secondary: "#858585", tertiary: "#8a8a8a" },
        text: { primary: "#cccccc", secondary: "#b5b5b5", tertiary: "#a2a2a2" },
        accent: { primary: "#0000ff", bg: "rgba(0, 0, 255, 0.12)" },
        border: "#8e8e8e",
        selection: "rgba(0, 0, 255, 0.22)",
        semantic: { error: "#ff0000", errorBg: "rgba(255, 0, 0, 0.15)", success: "#00ff00" },
      },
      terminal: {
        ansi: { ...ANSI },
        cursor: "#cccccc",
        cursorAccent: "#808080",
        selectionBackground: "rgba(0, 0, 255, 0.22)",
        scrollbar: {
          idle: "rgba(255, 255, 255, 0.12)",
          hover: "rgba(255, 255, 255, 0.2)",
          active: "rgba(255, 255, 255, 0.3)",
        },
        pane: { activeBorder: "#0000ff", inactiveBorder: "#8e8e8e" },
      },
    });
  });

  it("produces every ThemeTokens key (nothing left undefined)", () => {
    const t = deriveTheme(minimalSpec(true));
    expect(new Set(Object.keys(t))).toEqual(new Set(["isDark", "color", "terminal"]));
    expect(new Set(Object.keys(t.color))).toEqual(
      new Set(["bg", "text", "accent", "border", "selection", "semantic"]),
    );
    expect(new Set(Object.keys(t.color.bg))).toEqual(new Set(["primary", "secondary", "tertiary"]));
    expect(new Set(Object.keys(t.color.text))).toEqual(
      new Set(["primary", "secondary", "tertiary"]),
    );
    expect(new Set(Object.keys(t.color.accent))).toEqual(new Set(["primary", "bg"]));
    expect(new Set(Object.keys(t.color.semantic))).toEqual(
      new Set(["error", "errorBg", "success"]),
    );
    expect(new Set(Object.keys(t.terminal))).toEqual(
      new Set(["ansi", "cursor", "cursorAccent", "selectionBackground", "scrollbar", "pane"]),
    );
    expect(Object.keys(t.terminal.ansi)).toHaveLength(16);
    expect(new Set(Object.keys(t.terminal.scrollbar))).toEqual(
      new Set(["idle", "hover", "active"]),
    );
    expect(new Set(Object.keys(t.terminal.pane))).toEqual(
      new Set(["activeBorder", "inactiveBorder"]),
    );
  });

  it("emits only valid CSS color strings (dark and light minimal specs)", () => {
    for (const isDark of [true, false]) {
      const strings = leafStrings(deriveTheme(minimalSpec(isDark)));
      expect(strings.length).toBeGreaterThan(0);
      for (const s of strings) expect(s).toMatch(CSS_COLOR);
    }
  });

  it("branches on isDark: dark vs light differ in bg.secondary and the scrollbar", () => {
    const dark = deriveTheme(minimalSpec(true, "#808080"));
    const light = deriveTheme(minimalSpec(false, "#808080")); // same bg.primary, only isDark flips
    expect(dark.color.bg.secondary).not.toBe(light.color.bg.secondary);
    expect(dark.terminal.scrollbar.idle).not.toBe(light.terminal.scrollbar.idle);
    // dark lightens over white, light darkens over black
    expect(dark.terminal.scrollbar.idle).toBe("rgba(255, 255, 255, 0.12)");
    expect(light.terminal.scrollbar.idle).toBe("rgba(0, 0, 0, 0.12)");
  });

  it("is pure and deterministic — two calls are deep-equal", () => {
    const spec = minimalSpec(false);
    expect(deriveTheme(spec)).toEqual(deriveTheme(spec));
  });

  it("lets a spec-provided optional win over the derived value", () => {
    const spec = minimalSpec(true);
    spec.color.border = "#123456"; // explicit author value
    const t = deriveTheme(spec);
    expect(t.color.border).toBe("#123456"); // survives, not the mix()-derived border
    expect(t.terminal.pane.inactiveBorder).toBe("#123456"); // the resolved border flows to the pane line
  });

  describe("colorMath helpers", () => {
    it("hexToRgb parses the four hex forms and rejects junk", () => {
      expect(hexToRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
      expect(hexToRgb("#0a141e")).toEqual({ r: 10, g: 20, b: 30 });
      expect(hexToRgb("#abcd")).toEqual({ r: 170, g: 187, b: 204 }); // #rgba, alpha nibble dropped
      expect(hexToRgb("#12345678")).toEqual({ r: 18, g: 52, b: 86 }); // #rrggbbaa, alpha byte dropped
      expect(hexToRgb("not-a-color")).toBeNull();
      expect(hexToRgb("#12345")).toBeNull(); // 5 nibbles is not a hex form
    });

    it("mix blends channel-wise and falls back to the first arg on junk", () => {
      expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
      expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
      expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
      expect(mix("garbage", "#ffffff", 0.5)).toBe("garbage"); // never throws
    });

    it("withAlpha wraps a hex as rgba() and passes non-hex through unchanged", () => {
      expect(withAlpha("#58a6ff", 0.22)).toBe("rgba(88, 166, 255, 0.22)");
      expect(withAlpha("#ffffff", 0.12)).toBe("rgba(255, 255, 255, 0.12)");
      expect(withAlpha("rgba(1, 2, 3, 0.5)", 0.9)).toBe("rgba(1, 2, 3, 0.5)"); // already rgba → passthrough
    });
  });
});
