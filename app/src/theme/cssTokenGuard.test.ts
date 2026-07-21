// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-195 (test-first): the --tx-* token-reference guard. An undefined custom property in a
// `var()` WITHOUT a fallback degrades silently — the declaration goes invalid-at-computed-value
// time and `color` falls back to inherited black, which on a dark theme is invisible text (the
// trmx-188/190 title-bar/AI-counter regression this issue fixes: `--tx-text-primary` never
// existed; the role table emits `--tx-text`). This guard turns that silent failure into a red
// test at authoring time: every fallback-less `var(--tx-…)` in the shipped chrome CSS must name a
// token the theme system emits (txCssVars — the single role table) or one the CSS itself defines
// (settings.css's `:root` static fallbacks). Fallback-CARRYING references (`var(--tx-x, #ddd)`)
// are deliberately exempt — the trmx-98 find bar rides hardcoded fallbacks by design, and
// re-tethering it is explicitly out of trmx-195's scope (the fallback keeps it visible).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { txCssVars } from "./txCssVars";
import { themes } from "./themes";

/** The shipped chrome stylesheets (main window + settings surface). */
const CSS_FILES = ["src/index.css", "src/settings/settings.css"];

/** Every `var(--tx-…)` reference; group 2 tells fallback-less (`)`) from fallback-carrying (`,`). */
const REFERENCE = /var\(\s*(--tx-[a-z0-9-]+)\s*([,)])/g;

/** Every `--tx-…:` declaration (e.g. settings.css `:root` fallbacks) — CSS-defined names. */
const DECLARATION = /(--tx-[a-z0-9-]+)\s*:/g;

describe("CSS --tx-* token guard (trmx-195)", () => {
  const emitted = new Set(Object.keys(txCssVars(themes.night)));

  it("every fallback-less var(--tx-…) names an emitted or CSS-defined token", () => {
    const offenders: string[] = [];
    for (const file of CSS_FILES) {
      const text = readFileSync(resolve(process.cwd(), file), "utf8");
      const defined = new Set<string>();
      for (const match of text.matchAll(DECLARATION)) defined.add(match[1]);
      for (const match of text.matchAll(REFERENCE)) {
        const [, name, separator] = match;
        if (separator === ",") continue; // fallback-carrying — exempt (find-bar decision)
        if (emitted.has(name) || defined.has(name)) continue;
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${file}:${line} var(${name}) — not emitted by txCssVars, not CSS-defined`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the guard's emitted set is the real role table (sanity — never an empty set)", () => {
    expect(emitted.has("--tx-text")).toBe(true);
    expect(emitted.has("--tx-bg-sunken")).toBe(true);
    expect(emitted.size).toBeGreaterThanOrEqual(10);
  });
});
