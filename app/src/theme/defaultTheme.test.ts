// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the one-time first-run derivation — dark OS → Night, light OS → White. The OS is
// consulted only when no theme is persisted (and after a Reset all); it is never followed live.
import { describe, expect, it } from "vitest";
import { defaultThemeId } from "./defaultTheme";

const winPreferring = (dark: boolean): Pick<Window, "matchMedia"> => ({
  matchMedia: (query: string) =>
    ({ matches: dark && query.includes("prefers-color-scheme: dark") }) as MediaQueryList,
});

describe("defaultThemeId", () => {
  it("derives night from a dark OS appearance", () => {
    expect(defaultThemeId(winPreferring(true))).toBe("night");
  });

  it("derives white from a light OS appearance", () => {
    expect(defaultThemeId(winPreferring(false))).toBe("white");
  });

  it("defaults to night when matchMedia is unavailable (headless)", () => {
    expect(defaultThemeId({} as Pick<Window, "matchMedia">)).toBe("night");
  });
});
