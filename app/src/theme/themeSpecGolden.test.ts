// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (test-first): the ThemeSpec golden. `app/src/theme/__fixtures__/theme-golden.json` is a
// byte-for-byte copy of the core's `crates/termixion-core/tests/fixtures/theme-golden.json` (the JSON
// that `parse_theme` emits). The two MUST NOT drift — if the core fixture changes and this copy does
// not, this gate (or the core's own golden gate) breaks, which is exactly the signal we want. This
// pins the contract: required fields present, camelCase keys (brightBlack / errorBg / activeBorder),
// and deriveTheme expanding the fixture into a full ThemeTokens where the fixture's provided optionals
// survive and any omitted optional is filled.
import { describe, expect, it } from "vitest";
import golden from "./__fixtures__/theme-golden.json";
import { deriveTheme, type ThemeSpec } from "./themeDerive";

// The fixture arrives untyped (a JSON import); treat it as the contract type it mirrors.
const spec = golden as unknown as ThemeSpec;

describe("theme-golden fixture (mirrors the core parse_theme fixture)", () => {
  it("carries the required fields", () => {
    expect(typeof spec.isDark).toBe("boolean");
    expect(spec.color.bg.primary).toMatch(/^#[0-9a-f]{6}$/i);
    expect(spec.color.text.primary).toMatch(/^#[0-9a-f]{6}$/i);
    expect(Object.keys(spec.terminal.ansi)).toHaveLength(16); // all 16 ANSI slots present
  });

  it("uses camelCase keys, not snake_case", () => {
    expect(spec.terminal.ansi.brightBlack).toBeDefined();
    expect(spec.color.semantic.errorBg).toBeDefined();
    expect(spec.terminal.pane.activeBorder).toBeDefined();
    expect(JSON.stringify(golden)).not.toMatch(/bright_black|error_bg|active_border/);
  });

  it("deriveTheme keeps the fixture's provided optionals", () => {
    const t = deriveTheme(spec);
    expect(t.color.bg.secondary).toBe(spec.color.bg.secondary);
    expect(t.color.accent.bg).toBe(spec.color.accent.bg);
    expect(t.color.border).toBe(spec.color.border);
    expect(t.color.selection).toBe(spec.color.selection);
    expect(t.terminal.scrollbar.hover).toBe(spec.terminal.scrollbar.hover);
    expect(t.terminal.pane.activeBorder).toBe(spec.terminal.pane.activeBorder);
    expect(t.terminal.badge).toBe(spec.terminal.badge); // trmx-90: the fixture's badge is a provided optional
  });

  it("deriveTheme fills optionals the fixture omits (stripped projection)", () => {
    // Same fixture data, but drop one representative optional at each depth, then confirm the derive
    // fills each rather than leaving it undefined.
    const stripped = JSON.parse(JSON.stringify(spec)) as ThemeSpec;
    delete stripped.color.border;
    delete stripped.color.bg.secondary;
    delete stripped.terminal.scrollbar.hover;
    delete stripped.terminal.pane.activeBorder;

    const t = deriveTheme(stripped);
    expect(t.color.border).toBeDefined();
    expect(t.color.border).not.toBe(spec.color.border); // now derived, so it differs from the hand value
    expect(t.color.bg.secondary).toBeDefined();
    expect(t.terminal.scrollbar.hover).toBeDefined();
    // pane.activeBorder falls back to the (still-present) accent.primary
    expect(t.terminal.pane.activeBorder).toBe(spec.color.accent.primary);
  });
});
