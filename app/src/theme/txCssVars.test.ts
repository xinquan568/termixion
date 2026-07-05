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
import { contrastRatio, pickReadableOn } from "./contrast";
import { clearUserThemes, registerUserThemes } from "./registry";
import { THEME_IDS, themes } from "./themes";
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
      "--tx-pane-active-border": "#0066cc",
      "--tx-pane-inactive-border": "#eeeeee",
      "--tx-primary": "#0066cc",
      "--tx-success": "#16a34a",
      "--tx-error": "#cf222e",
      "--tx-on-accent": "#fff",
      "--tx-on-success": "#fff",
      "--tx-on-error": "#fff",
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
      "--tx-pane-active-border": "#58a6ff",
      "--tx-pane-inactive-border": "#3a3f46",
      "--tx-primary": "#58a6ff",
      "--tx-success": "#4ade80",
      "--tx-error": "#f85149",
      "--tx-on-accent": "#23262b",
      "--tx-on-success": "#23262b",
      "--tx-on-error": "#23262b",
    });
  });
});

// trmx-77: G5 — readable text on the accent/semantic control surfaces (the settings buttons).
// White text was hardcoded and failed on Night's light-blue accent (#58a6ff, 2.53:1); the three
// --tx-on-* vars are DERIVED per surface via pickReadableOn, never hardcoded per theme. Floors and
// rationale: docs/design/visual-baseline.md §4.
describe("on-surface text derivation (G5, trmx-77)", () => {
  const SURFACES = [
    ["--tx-on-accent", (t: (typeof themes)["white"]) => t.color.accent.primary],
    ["--tx-on-success", (t: (typeof themes)["white"]) => t.color.semantic.success],
    ["--tx-on-error", (t: (typeof themes)["white"]) => t.color.semantic.error],
  ] as const;

  it.each(THEME_IDS)("%s: each on-* var is the pickReadableOn derivation, ≥ 3:1 on its surface", (id) => {
    const theme = themes[id];
    const vars = txCssVars(theme);
    for (const [name, surfaceOf] of SURFACES) {
      const surface = surfaceOf(theme);
      expect(vars[name]).toBe(pickReadableOn(surface, ["#fff", theme.color.bg.primary]));
      expect(contrastRatio(vars[name] === "#fff" ? "#ffffff" : vars[name], surface)).toBeGreaterThanOrEqual(3);
    }
  });

  it("derives per surface, not per theme (Solarized: dark text on accent, white on error)", () => {
    const vars = txCssVars(themes.solarized);
    expect(vars["--tx-on-accent"]).toBe("#002b36");
    expect(vars["--tx-on-error"]).toBe("#fff");
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

  // trmx-89 review-1: a valid user theme may use rgb()/rgba()/8-hex colors (all accepted by
  // parse_theme). applyTxTheme derives the --tx-on-* roles via pickReadableOn, which previously THREW
  // on a non-#rrggbb color and crashed the settings theme apply. This pins that it no longer throws.
  it("applies a user theme with rgb()/rgba()/8-hex colors without throwing (crash regression)", () => {
    registerUserThemes([
      {
        id: "user:rgbtheme",
        source: "user",
        valid: true,
        warnings: [],
        spec: {
          isDark: false,
          color: {
            bg: { primary: "rgb(255, 255, 255)" },
            text: { primary: "#1a1a1aff" },
            accent: {},
            semantic: {},
          },
          terminal: {
            ansi: {
              black: "#000000", red: "rgb(255,0,0)", green: "#00ff00", yellow: "#ffff00",
              blue: "rgb(0, 102, 204)", magenta: "#ff00ff", cyan: "#00ffff", white: "#ffffff",
              brightBlack: "#808080", brightRed: "#ff8080", brightGreen: "#80ff80", brightYellow: "#ffff80",
              brightBlue: "#8080ff", brightMagenta: "#ff80ff", brightCyan: "#80ffff", brightWhite: "#f0f6fc",
            },
            scrollbar: {},
            pane: {},
          },
        },
      },
    ]);
    expect(() => applyTxTheme("user:rgbtheme", document)).not.toThrow();
    // The accent-derived --tx-on-* readable-text roles were computed (the pickReadableOn path ran).
    expect(document.documentElement.style.getPropertyValue("--tx-on-accent")).not.toBe("");
    clearUserThemes();
  });
});

describe("settings.css cascade guard (plan D4 layer i)", () => {
  // Comments stripped: the guard is about DECLARATIONS, not prose. Read via node:fs (typed by
  // the @types/node devDep): vitest stubs CSS module imports (css: false), so a `?raw` import of
  // a .css file arrives empty — the raw-text route only works for non-CSS files (main.order.test).
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

  it("hardcodes no white TEXT on control surfaces — button text routes via --tx-on-* (G5, trmx-77)", () => {
    // background: #fff (the toggle knob — a physical affordance on the track) stays allowed;
    // color: #fff on an accent/semantic surface is exactly the Night-accent seam G5 fixed.
    expect(css).not.toMatch(/color:\s*#fff\b/);
  });

  it("keeps the :root static fallback equal to txCssVars(night), var for var (step-8 F2)", () => {
    // The pre-JS fallback IS Night's mapping (the dark first-run default, per the file header).
    // A var emitted at runtime but missing here silently falls back to its var() default before
    // JS applies — for --tx-on-accent that would resurrect the white-on-#58a6ff seam G5 fixed.
    const root = /:root\s*\{([^}]*)\}/.exec(css);
    expect(root).not.toBeNull();
    const declared: Record<string, string> = {};
    for (const m of root![1].matchAll(/(--tx-[\w-]+)\s*:\s*([^;]+);/g)) {
      declared[m[1]] = m[2].trim();
    }
    expect(declared).toEqual(txCssVars(themes.night));
  });
});
