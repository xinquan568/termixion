// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (D, test-first): the runtime theme registry — registering the user set the backend's
// themes_read() surfaced, resolving any id (built-in or user:<stem>) to tokens with the shared White
// fallback, the registry-aware guards, non-gating contrast diagnostics, and the invariant that a
// built-in id is never shadowable by a user entry. The registry is module-level, so every test resets it.
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearUserThemes,
  getTheme,
  isRegisteredThemeId,
  isUserThemeIdShape,
  listThemes,
  registerUserThemes,
  resolveTheme,
  validateUserTheme,
  type UserThemeEntry,
} from "./registry";
import { deriveTheme, type ThemeSpec } from "./themeDerive";
import { THEME_IDS, themeLabel, themes } from "./themes";
import type { AnsiPalette } from "./tokens";

/** A neutral 16-color palette (mirrors themeDerive.test.ts's fixture). */
const ANSI: AnsiPalette = {
  black: "#000000", red: "#ff0000", green: "#00ff00", yellow: "#ffff00",
  blue: "#0000ff", magenta: "#ff00ff", cyan: "#00ffff", white: "#ffffff",
  brightBlack: "#808080", brightRed: "#ff8080", brightGreen: "#80ff80", brightYellow: "#ffff80",
  brightBlue: "#8080ff", brightMagenta: "#ff80ff", brightCyan: "#80ffff", brightWhite: "#f0f6fc",
};

/** A ThemeSpec with only the required set filled — `bg`/`text` chosen by the caller for contrast. */
function spec(isDark: boolean, bgPrimary: string, textPrimary: string): ThemeSpec {
  return {
    isDark,
    color: { bg: { primary: bgPrimary }, text: { primary: textPrimary }, accent: {}, semantic: {} },
    terminal: { ansi: { ...ANSI }, scrollbar: {}, pane: {} },
  };
}

/** A valid, high-contrast user entry (black bg / white text → ~21:1, no contrast warning). */
function validEntry(id: string, s: ThemeSpec = spec(true, "#000000", "#ffffff")): UserThemeEntry {
  return { id, source: "user", valid: true, spec: s, warnings: [] };
}

beforeEach(() => {
  clearUserThemes();
});

describe("registerUserThemes + resolution", () => {
  it("registers a valid user theme: getTheme/resolveTheme return the derived tokens, it lists after the built-ins, and it is a registered id", () => {
    const s = spec(true, "#000000", "#ffffff");
    registerUserThemes([validEntry("user:x", s)]);

    expect(getTheme("user:x")).toEqual(deriveTheme(s));
    expect(resolveTheme("user:x")).toEqual(deriveTheme(s));
    expect(isRegisteredThemeId("user:x")).toBe(true);

    const list = listThemes();
    // Built-ins first, in THEME_IDS order …
    expect(list.slice(0, THEME_IDS.length).map((e) => e.id)).toEqual(THEME_IDS);
    // … then the user theme, valid, labeled, with no diagnostics (high contrast).
    expect(list[THEME_IDS.length]).toEqual({
      id: "user:x",
      label: "X",
      source: "user",
      valid: true,
      diagnostics: [],
    });
  });

  it("REPLACES the user set on each call (the whole themes_read() result)", () => {
    registerUserThemes([validEntry("user:a")]);
    registerUserThemes([validEntry("user:b")]);
    expect(getTheme("user:a")).toBeUndefined();
    expect(getTheme("user:b")).toBeDefined();
    expect(listThemes().filter((e) => e.source === "user").map((e) => e.id)).toEqual(["user:b"]);
  });

  it("lists user themes in insertion order, after the built-ins", () => {
    registerUserThemes([validEntry("user:first"), validEntry("user:second")]);
    expect(listThemes().filter((e) => e.source === "user").map((e) => e.id)).toEqual([
      "user:first",
      "user:second",
    ]);
  });
});

describe("invalid user themes", () => {
  it("lists an invalid entry with valid:false + an error diagnostic; getTheme is undefined; resolveTheme falls back to White", () => {
    registerUserThemes([
      {
        id: "user:broken",
        source: "user",
        valid: false,
        spec: null,
        warnings: [{ type: "MissingRequired", key: "color.bg.primary", message: "missing color.bg.primary" }],
      },
    ]);

    const entry = listThemes().find((e) => e.id === "user:broken");
    expect(entry).toBeDefined();
    expect(entry!.valid).toBe(false);
    expect(entry!.diagnostics).toEqual([
      { severity: "error", message: "missing color.bg.primary" },
    ]);

    expect(getTheme("user:broken")).toBeUndefined();
    expect(resolveTheme("user:broken")).toBe(themes.white);
    // It is still a "known" (registered) id so a persisted selection is not coerced away.
    expect(isRegisteredThemeId("user:broken")).toBe(true);
  });

  it("synthesizes a message from the warning type/key when the core omitted one", () => {
    registerUserThemes([
      { id: "user:nofile", source: "user", valid: false, spec: null, warnings: [{ type: "SyntaxError" }] },
    ]);
    const entry = listThemes().find((e) => e.id === "user:nofile");
    expect(entry!.diagnostics[0].severity).toBe("error");
    expect(entry!.diagnostics[0].message).toContain("SyntaxError");
  });
});

describe("contrast diagnostics (non-gating)", () => {
  it("a low-contrast valid theme stays valid:true, applies, and carries a warning diagnostic", () => {
    // #808080 text on #8a8a8a bg → ~1.1:1, well under WCAG AA 4.5:1.
    const low = spec(false, "#8a8a8a", "#808080");
    registerUserThemes([validEntry("user:lowc", low)]);

    // It APPLIES (warnings never block) …
    expect(resolveTheme("user:lowc")).toEqual(deriveTheme(low));

    const entry = listThemes().find((e) => e.id === "user:lowc")!;
    expect(entry.valid).toBe(true);
    expect(entry.diagnostics).toHaveLength(1);
    expect(entry.diagnostics[0]).toMatchObject({ severity: "warning", path: "color.text.primary" });
    expect(entry.diagnostics[0].message).toContain("low contrast");
  });

  it("validateUserTheme returns no diagnostics for a high-contrast theme", () => {
    expect(validateUserTheme(deriveTheme(spec(true, "#000000", "#ffffff")))).toEqual([]);
  });
});

describe("built-ins are never shadowable", () => {
  it("skips a (defensive) user entry whose id collides with a built-in", () => {
    registerUserThemes([validEntry("night", spec(true, "#000000", "#ffffff"))]);
    // getTheme('night') is the BUILT-IN tokens, not the derived spec.
    expect(getTheme("night")).toBe(themes.night);
    // The collision entry never lands in the user list.
    expect(listThemes().filter((e) => e.id === "night")).toEqual([
      { id: "night", label: "Night", source: "builtin", valid: true, diagnostics: [] },
    ]);
  });
});

describe("guards + fallback on unknown / junk ids", () => {
  it("resolveTheme falls back to White and the guards reject an unknown id", () => {
    expect(resolveTheme("hotdog-stand")).toBe(themes.white);
    expect(resolveTheme("__proto__")).toBe(themes.white);
    expect(isRegisteredThemeId("hotdog-stand")).toBe(false);
    expect(isRegisteredThemeId("__proto__")).toBe(false);
    expect(isRegisteredThemeId(7)).toBe(false);
    expect(isRegisteredThemeId(undefined)).toBe(false);
  });

  it("built-in ids are registered and resolve to their own tokens", () => {
    for (const id of THEME_IDS) {
      expect(isRegisteredThemeId(id)).toBe(true);
      expect(resolveTheme(id)).toBe(themes[id]);
    }
  });

  it("isUserThemeIdShape accepts a well-formed user id and rejects everything else", () => {
    expect(isUserThemeIdShape("user:foo")).toBe(true);
    expect(isUserThemeIdShape("night")).toBe(false);
    expect(isUserThemeIdShape("user:a/b")).toBe(false);
    expect(isUserThemeIdShape("user:a\\b")).toBe(false);
    expect(isUserThemeIdShape("user:")).toBe(false);
    expect(isUserThemeIdShape(42)).toBe(false);
  });
});

describe("themeLabel over the widened id space", () => {
  it("titleizes a user stem and capitalizes a built-in", () => {
    expect(themeLabel("user:solarizedish")).toBe("Solarizedish");
    expect(themeLabel("night")).toBe("Night");
  });
});

// trmx-89 review-1: an invalidating edit of the ACTIVE user theme must keep serving the last-good
// colors (the hot-reload "invalid edit -> previous colors stay" for new panes / re-applies), not fall
// back to White the moment resolveTheme is called again.
describe("last-good tokens across an invalidating re-register", () => {
  it("keeps the previous derived tokens when a valid user theme is re-registered invalid", () => {
    const s = spec(true, "#101010", "#f0f0f0");
    registerUserThemes([validEntry("user:live", s)]);
    const good = getTheme("user:live");
    expect(good).toEqual(deriveTheme(s));

    // The theme-designer saved a broken file: themes_read() now reports it invalid.
    registerUserThemes([
      { id: "user:live", source: "user", valid: false, spec: null, warnings: [{ type: "SyntaxError" }] },
    ]);

    // resolveTheme/getTheme still return the LAST-GOOD tokens (not White) — a new pane keeps the colors.
    expect(getTheme("user:live")).toEqual(good);
    expect(resolveTheme("user:live")).toEqual(good);
    expect(resolveTheme("user:live")).not.toEqual(themes.white);
    // ...but the picker entry is flagged invalid + unselectable.
    const entry = listThemes().find((e) => e.id === "user:live");
    expect(entry?.valid).toBe(false);
    expect(entry?.diagnostics[0]?.severity).toBe("error");
  });

  it("still falls back to White for an id that was NEVER valid this session", () => {
    registerUserThemes([
      { id: "user:born-bad", source: "user", valid: false, spec: null, warnings: [{ type: "SyntaxError" }] },
    ]);
    expect(getTheme("user:born-bad")).toBeUndefined();
    expect(resolveTheme("user:born-bad")).toEqual(themes.white);
  });

  it("drops the last-good once the id disappears entirely from a re-register", () => {
    registerUserThemes([validEntry("user:gone", spec(true, "#101010", "#f0f0f0"))]);
    registerUserThemes([validEntry("user:other")]); // "user:gone" is absent now (file deleted)
    expect(getTheme("user:gone")).toBeUndefined();
    expect(resolveTheme("user:gone")).toEqual(themes.white);
  });
});

// trmx-89 review-1: a valid user theme whose colors are rgb()/rgba()/8-hex (all accepted by
// parse_theme) must register + validate without throwing — the contrast path previously threw.
describe("registration is grammar-total (rgb()/rgba()/8-hex user colors)", () => {
  it("registers a user theme with rgb() required colors and computes a contrast diagnostic", () => {
    const rgbSpec = spec(false, "rgb(255, 255, 255)", "rgb(200, 200, 200)"); // low contrast on purpose
    expect(() => registerUserThemes([validEntry("user:rgbtheme", rgbSpec)])).not.toThrow();
    const entry = listThemes().find((e) => e.id === "user:rgbtheme");
    expect(entry?.valid).toBe(true); // low contrast is a WARNING, still valid/applyable
    expect(entry?.diagnostics.some((d) => d.severity === "warning")).toBe(true);
    expect(getTheme("user:rgbtheme")).toBeDefined();
  });
});
