// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-253 (M20): mostly LOCALISATION — `clampNumberSetting` and `isTabBarPosition` are pure,
// storage-free helpers that today are only exercised INDIRECTLY, through the settings runtime's
// read/write paths and through consumers (scrollbackSettings.ts, fontSettings.ts,
// useAppServices.ts, SettingsApp.tsx). A helper reached only through a store is tested at the
// store's granularity: a clamp bug shows up as "the store wrote a wrong value", and a guard bug as
// "the app ignored a payload".
//
// The genuinely NEW part is the EXACT-BOUND cases. `Math.min(max, Math.max(min, value))` is
// inclusive at both ends, but nothing asserted that: an off-by-one rewrite to an exclusive clamp
// (`value > min ? … : min + 1`, or a `<`/`<=` slip in a future range check) would still pass every
// "too small → min / too large → max" test while quietly making the advertised min and max
// unreachable. Those two values are the ones a user types into the settings UI.
//
// Deliberately a SEPARATE file from settingsStore.test.ts: that suite is being rewritten around the
// explicit settings runtime (trmx-253 M8), and these pure-helper assertions have no stake in how
// the store is constructed. They should not churn with it.
//
// CHARACTERISATION: every assertion below describes behaviour that already ships, so the file
// passes on its first run — correct under R8, which requires RED for newly specified behaviour, not
// for putting existing behaviour under direct test.
import { describe, expect, it } from "vitest";
import { SETTING_RANGES, clampNumberSetting, isTabBarPosition } from "./settingsStore";

type NumberSettingKey = keyof typeof SETTING_RANGES;
const NUMBER_KEYS = Object.keys(SETTING_RANGES) as NumberSettingKey[];

describe("clampNumberSetting", () => {
  // THE CONTRACT, stated once and asserted below for every number-typed key:
  //   min and max are INCLUSIVE. A value exactly at a bound is returned UNCHANGED — the clamp
  //   never nudges it inward — and every value outside the range collapses onto the nearer bound.
  // The cases read the bounds out of SETTING_RANGES rather than hard-coding 0 / 200_000 / 6 / 72,
  // so widening a range in the registry keeps testing the bound that range actually declares.
  it.each(NUMBER_KEYS)("%s: the min is inclusive — a value AT min is returned unchanged", (key) => {
    const { min } = SETTING_RANGES[key];
    expect(clampNumberSetting(key, min)).toBe(min);
  });

  it.each(NUMBER_KEYS)("%s: the max is inclusive — a value AT max is returned unchanged", (key) => {
    const { max } = SETTING_RANGES[key];
    expect(clampNumberSetting(key, max)).toBe(max);
  });

  it.each(NUMBER_KEYS)("%s: the first value inside each bound is untouched", (key) => {
    const { min, max } = SETTING_RANGES[key];
    expect(clampNumberSetting(key, min + 1)).toBe(min + 1);
    expect(clampNumberSetting(key, max - 1)).toBe(max - 1);
  });

  it.each(NUMBER_KEYS)("%s: values outside collapse onto the nearer bound", (key) => {
    const { min, max } = SETTING_RANGES[key];
    expect(clampNumberSetting(key, min - 1)).toBe(min);
    expect(clampNumberSetting(key, max + 1)).toBe(max);
    expect(clampNumberSetting(key, min - 1_000_000)).toBe(min);
    expect(clampNumberSetting(key, max + 1_000_000)).toBe(max);
  });

  // The concrete ranges the UI advertises (docs/config.md, mirrored from termixion-core). Spelled
  // out so a range CHANGE is a visible diff here, not an invisible re-derivation above.
  it("pins the shipped ranges: scrollback 0–200 000 lines, font size 6–72 pt", () => {
    expect(SETTING_RANGES["terminal.scrollbackLines"]).toEqual({ min: 0, max: 200_000 });
    expect(SETTING_RANGES["terminal.fontSize"]).toEqual({ min: 6, max: 72 });
    expect(clampNumberSetting("terminal.scrollbackLines", 0)).toBe(0);
    expect(clampNumberSetting("terminal.scrollbackLines", 200_000)).toBe(200_000);
    expect(clampNumberSetting("terminal.fontSize", 6)).toBe(6);
    expect(clampNumberSetting("terminal.fontSize", 72)).toBe(72);
  });

  // Non-integers pass through untouched INSIDE the range: the clamp is a range function only, and
  // integer-ness is enforced upstream at parse time (settings/components.tsx documents that split).
  it("clamps range only — a fractional in-range value is not rounded", () => {
    expect(clampNumberSetting("terminal.fontSize", 12.5)).toBe(12.5);
  });

  // NaN is neither < min nor > max, so both Math.min and Math.max propagate it. Pinned as the
  // KNOWN shape of the contract's edge: the clamp does not sanitise a non-number, its callers must.
  it("does not sanitise NaN — the caller parses before clamping", () => {
    expect(clampNumberSetting("terminal.fontSize", Number.NaN)).toBeNaN();
  });

  it("clamps the infinities onto the bounds", () => {
    expect(clampNumberSetting("terminal.fontSize", Number.POSITIVE_INFINITY)).toBe(72);
    expect(clampNumberSetting("terminal.fontSize", Number.NEGATIVE_INFINITY)).toBe(6);
  });
});

describe("isTabBarPosition", () => {
  // The closed value set (trmx-81, mirroring core's `tabs.bar_position`), as a table: the four
  // accepted edges, then the near-misses a config file or an IPC payload can realistically carry.
  const TABLE: Array<[label: string, value: unknown, expected: boolean]> = [
    ["top", "top", true],
    ["bottom", "bottom", true],
    ["left", "left", true],
    ["right", "right", true],
    ["a value outside the set", "middle", false],
    ["the empty string", "", false],
    ["a wrong-case value (the guard is case-SENSITIVE)", "Top", false],
    ["a padded value (no trimming)", " top ", false],
    ["null", null, false],
    ["undefined", undefined, false],
    ["a number", 0, false],
    ["a boolean", true, false],
    ["an object", {}, false],
    ["an array holding a valid value", ["top"], false],
    ["a String object rather than a primitive", new String("top"), false],
  ];

  it.each(TABLE)("%s → %s", (_label, value, expected) => {
    expect(isTabBarPosition(value)).toBe(expected);
  });

  it("accepts exactly four values and nothing else", () => {
    const accepted = ["top", "bottom", "left", "right", "middle", "centre", "TOP", "up", "down"]
      .filter(isTabBarPosition);
    expect(accepted).toEqual(["top", "bottom", "left", "right"]);
  });
});
