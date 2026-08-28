// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (test-first) + trmx-239 (M21): the ThemeSpec golden, read from THE core fixture
// (`crates/termixion-core/tests/fixtures/theme-golden.json`, the JSON `parse_theme` emits).
//
// It used to be a copy in `app/src/theme/__fixtures__/`, with this comment claiming the two "MUST
// NOT drift" — while the only assertions were "the required keys are present". The copy had in fact
// already drifted (it was missing the `terminal.search` block), so the claim was false and the gate
// green. trmx-239 removed the copy: one source cannot drift, whereas an equality check only reports
// drift after it happens.
//
// Pins the contract: every value the fixture provides survives `deriveTheme` (recursive, so a NEW
// fixture key the app does not consume fails this suite), camelCase keys, and omitted optionals
// getting filled.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveTheme, type ThemeSpec } from "./themeDerive";

// trmx-239 (M21): read the CORE fixture directly — there is no app-side copy any more. The old copy
// had already drifted (it was missing `terminal.search`) while this suite claimed the two "MUST NOT
// drift", which is precisely the documented-but-not-enforced pattern this issue exists to end. A
// single source cannot drift; an equality assertion only notices after it has. (readFileSync, not a
// JSON module import — the shape `themeTokensToToml.test.ts` already proves resolves cross-tree.)
const golden = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../crates/termixion-core/tests/fixtures/theme-golden.json",
    ),
    "utf8",
  ),
) as unknown;

// The fixture arrives untyped (a JSON import); treat it as the contract type it mirrors.
const spec = golden as unknown as ThemeSpec;

describe("theme-golden fixture (mirrors the core parse_theme fixture)", () => {
  // trmx-239 (M21): THE gate for the issue's stated criterion — "the test fails if the core fixture
  // gains a key the app does not consume". Named assertions cannot do that: the fixture arrives as
  // `unknown as ThemeSpec`, so a new JSON property type-checks silently and deriveTheme may drop it
  // with every named expectation still green. This is recursive and name-agnostic instead: every
  // value the fixture provides must survive derivation, whatever it is called.
  it("deriveTheme consumes EVERY value the core fixture provides", () => {
    expect(deriveTheme(spec)).toMatchObject(golden as Record<string, unknown>);
  });

  it("consumes the fixture's terminal.search block (the key the old app copy had drifted away)", () => {
    expect(spec.terminal.search).toBeDefined();
    const t = deriveTheme(spec);
    expect(t.terminal.search.match).toBe(spec.terminal.search?.match);
    expect(t.terminal.search.activeMatch).toBe(spec.terminal.search?.activeMatch);
  });

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
