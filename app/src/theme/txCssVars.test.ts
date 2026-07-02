// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53 (test-first): the theme → settings-window CSS-variable mapping, and the cascade
// guarantee behind it. jsdom does not fully cascade custom properties, so the proof is
// two-layer (plan D4): (i) here — applyTxTheme writes every mapped var on documentElement and
// a source-guard pins settings.css to declare --tx-* under :root ONLY (nothing scoped below
// root can shadow the runtime write); (ii) in Playwright — a real computed-style check that
// clicking a swatch recolors the settings surface (e2e/settings.spec.ts).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { themes } from "./themes";
import { applyTxTheme, txCssVars } from "./txCssVars";

describe("txCssVars — role mapping", () => {
  it("maps a light theme's tokens onto the --tx-* roles, value-exactly (white)", () => {
    expect(txCssVars(themes.white)).toEqual({
      "--tx-bg": "#FFFFFF",
      "--tx-bg-elev": "#f0f0f0",
      "--tx-bg-sunken": "#f8f8f8",
      "--tx-text": "#1a1a1a",
      "--tx-text-2": "#666666",
      "--tx-text-3": "#999999",
      "--tx-border": "#eeeeee",
      "--tx-primary": "#0066cc",
      "--tx-success": "#16a34a",
      "--tx-error": "#cf222e",
    });
  });

  it("maps a dark theme's tokens onto the --tx-* roles, value-exactly (night)", () => {
    expect(txCssVars(themes.night)).toEqual({
      "--tx-bg": "#23262b",
      "--tx-bg-elev": "#32363d",
      "--tx-bg-sunken": "#2a2e34",
      "--tx-text": "#d6d9de",
      "--tx-text-2": "#9aa0a6",
      "--tx-text-3": "#6b7078",
      "--tx-border": "#3a3f46",
      "--tx-primary": "#58a6ff",
      "--tx-success": "#4ade80",
      "--tx-error": "#f85149",
    });
  });
});

describe("applyTxTheme — runtime delivery (plan D4)", () => {
  it("writes every mapped var on documentElement and paints the body background", () => {
    applyTxTheme("sepia", document);
    for (const [name, value] of Object.entries(txCssVars(themes.sepia))) {
      expect(document.documentElement.style.getPropertyValue(name)).toBe(value);
    }
    expect(document.body.style.background).not.toBe("");

    // Switching themes overwrites in place (idempotent re-apply, no stale values).
    applyTxTheme("night", document);
    expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe("#23262b");
  });

  it("falls back safely on a junk id", () => {
    applyTxTheme("__proto__" as never, document);
    expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe(
      themes.white.color.bg.primary,
    );
  });
});

describe("settings.css cascade guard (plan D4 layer i)", () => {
  // Comments stripped: the guard is about DECLARATIONS, not prose.
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../settings/settings.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  it("declares --tx-* custom properties under :root only — nothing below root may shadow the runtime write", () => {
    // Split into rule bodies with their selector; flag any --tx-* DECLARATION (name followed by
    // a colon) whose selector isn't exactly :root. Usages — var(--tx-*) — don't match.
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    const offenders: string[] = [];
    for (const match of css.matchAll(ruleRe)) {
      const selector = match[1].trim();
      const body = match[2];
      if (/--tx-[\w-]+\s*:/.test(body) && selector !== ":root") {
        offenders.push(selector);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps a :root static fallback and drops the prefers-color-scheme override (explicit theme supersedes it)", () => {
    expect(css).toContain(":root");
    expect(css).not.toContain("prefers-color-scheme");
  });

  it("embeds no hardcoded colors in data-URI SVGs — control glyphs must theme via --tx-* (step-9 F2)", () => {
    // e.g. the select chevron: a stroke='%23999' baked into a background-image can't recolor
    // with the theme; glyphs are masked and tinted with background-color: var(--tx-*) instead.
    expect(css).not.toMatch(/stroke='%23[0-9a-fA-F]/);
    expect(css).not.toMatch(/fill='%23[0-9a-fA-F]/);
  });
});
