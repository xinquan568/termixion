// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the one-time first-run derivation — the OS is consulted only when no theme is
// persisted (and after a Reset all); it is never followed live. trmx-202: dark OS → Night,
// light OS → Catppuccin Latte (White is removed), plus the legacy-id normalizer that maps the
// four REMOVED built-ins to the derived default at the live-event guard sites.
import { describe, expect, it } from "vitest";
import { defaultThemeId, normalizeLegacyThemeId } from "./defaultTheme";

const winPreferring = (dark: boolean): Pick<Window, "matchMedia"> => ({
  matchMedia: (query: string) =>
    ({ matches: dark && query.includes("prefers-color-scheme: dark") }) as MediaQueryList,
});

describe("defaultThemeId", () => {
  it("derives night from a dark OS appearance", () => {
    expect(defaultThemeId(winPreferring(true))).toBe("night");
  });

  it("derives catppuccin-latte from a light OS appearance (trmx-202)", () => {
    expect(defaultThemeId(winPreferring(false))).toBe("catppuccin-latte");
  });

  it("defaults to night when matchMedia is unavailable (headless)", () => {
    expect(defaultThemeId({} as Pick<Window, "matchMedia">)).toBe("night");
  });
});

// trmx-202: removed built-ins (white/paper/mint/sepia) normalize to the derived default; every
// other value — surviving ids, user ids, junk — returns null ("not a legacy id; apply your own
// guard"), so consumers keep their existing per-site guard semantics untouched.
describe("normalizeLegacyThemeId", () => {
  it("maps each removed built-in to the derived default for the given window", () => {
    for (const id of ["white", "paper", "mint", "sepia"]) {
      expect(normalizeLegacyThemeId(id, winPreferring(true))).toBe("night");
      expect(normalizeLegacyThemeId(id, winPreferring(false))).toBe("catppuccin-latte");
    }
  });

  it("returns null for surviving built-ins, user ids, and junk", () => {
    expect(normalizeLegacyThemeId("night", winPreferring(true))).toBeNull();
    expect(normalizeLegacyThemeId("catppuccin-latte", winPreferring(true))).toBeNull();
    expect(normalizeLegacyThemeId("user:my-solarized", winPreferring(true))).toBeNull();
    expect(normalizeLegacyThemeId("hotdog-stand", winPreferring(true))).toBeNull();
    expect(normalizeLegacyThemeId(42, winPreferring(true))).toBeNull();
    expect(normalizeLegacyThemeId("__proto__", winPreferring(true))).toBeNull();
  });
});
