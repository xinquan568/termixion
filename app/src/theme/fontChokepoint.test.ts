// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-220 (test-first): the font-chokepoint guard. Chrome typography is decided in exactly TWO
// CSS custom properties — `--tx-ui-font` (system sans, long prose) and `--tx-mono` (the bundled
// SauceCodePro Nerd Font Mono, applied by ROLE: titles, tab labels, names, values/numbers,
// keybinding hints) — both declared once under index.css `:root`. This guard turns the issue's
// acceptance criteria into red tests at authoring time: (1) no `font-family` / `font:` shorthand
// in the shipped chrome CSS names a concrete family outside the two `:root` definitions and the
// `.tx-badge` exemption (bold Helvetica, iTerm2 fidelity — trmx-149; it MIRRORS BADGE_FONT_FAMILY
// so the badgeFit canvas measures the painted font); (2) the definitions exist, once, in the
// right file (settings.css's `:root` is owned var-for-var by the txCssVars cascade guard);
// (3) mono-role elements use only the two bundled weights, pinned selector-by-selector (only
// Regular 400 / Bold 700 woff2 ship — a 500/600 on a mono element would synthesize).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BADGE_FONT_FAMILY } from "../panes/badgeFit";

/** The shipped chrome stylesheets (main window + settings surface) — one Vite bundle. */
const CSS_FILES = ["src/index.css", "src/settings/settings.css"] as const;

const read = (file: string): string =>
  readFileSync(resolve(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Flat rule scan (the txCssVars cascade-guard technique): `selector { body }` pairs. An @media
 * wrapper never matches (its "body" contains braces) but the rules INSIDE it do.
 */
const RULE = /([^{}]+)\{([^{}]*)\}/g;

/** CSS-wide keywords — `font: inherit` and friends carry no concrete family. */
const WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);

/** A compliant family value: a fallback-LESS reference to one of the two chokepoint variables. */
const CHOKEPOINT = /^var\(--tx-(ui-font|mono)\)$/;
/**
 * A compliant `font:` shorthand: optional size/line-height/style/weight tokens, then EXACTLY one
 * fallback-less chokepoint reference as the entire family. Anchored token-by-token so a concrete
 * family smuggled before the var (`font: 12px Helvetica, var(--tx-ui-font)`) is an offender.
 */
const CHOKEPOINT_SHORTHAND =
  /^(?:(?:\d+(?:\.\d+)?(?:px|em|rem|%)(?:\s*\/\s*\d+(?:\.\d+)?)?|normal|italic|bold|[1-9]00)\s+)*var\(--tx-(ui-font|mono)\)$/;
/** A fallback-carrying reference to either variable re-embeds a concrete stack — never allowed. */
const CHOKEPOINT_WITH_FALLBACK = /var\(--tx-(ui-font|mono)\s*,/;

interface FontDecl {
  file: string;
  selector: string;
  property: "font-family" | "font";
  value: string;
}

function fontDecls(): FontDecl[] {
  const decls: FontDecl[] = [];
  for (const file of CSS_FILES) {
    for (const rule of read(file).matchAll(RULE)) {
      const selector = rule[1].trim();
      const body = rule[2];
      for (const m of body.matchAll(/(?:^|[;\s])(font-family|font)\s*:\s*([^;]+)/g)) {
        decls.push({
          file,
          selector,
          property: m[1] as FontDecl["property"],
          value: m[2].trim(),
        });
      }
    }
  }
  return decls;
}

/**
 * trmx-220 role table — the frozen analysis inventory, selector → expected mono weight. 700 roles
 * must declare exactly 700; 400 roles must declare 400 or nothing (Regular is the inherited
 * default). Any other weight on ANY rule matching the selector — including a stray 500/600 from a
 * modifier rule or a `font:` shorthand — is an offender (only 400/700 woff2 are bundled).
 */
const MONO_ROLES: Record<string, 400 | 700> = {
  // Main window — tab labels, hints, counters, names, values.
  ".tab-strip__title": 400,
  ".tab-strip__rename": 400,
  ".tab-strip__hint": 400,
  ".ai-counter": 400,
  ".title-bar__title": 400,
  ".tx-command-palette__title": 700,
  ".tx-command-palette__hint": 400,
  ".tx-script-picker__name": 700,
  ".tx-script-picker__path": 400,
  ".tx-find-bar__count": 400,
  ".tx-confirm-close__title": 700,
  // Settings window — titles, section headers, labels, values/numbers, theme names.
  ".tx-settings__title": 700,
  ".tx-settings-group__title": 700,
  ".tx-nav-item": 400,
  ".tx-setting-row__label": 400,
  ".tx-number": 400,
  ".tx-about__name": 700,
  ".tx-about__version": 400,
  ".tx-about__card-version": 700,
  ".tx-about__card-current": 400,
  ".tx-about__card-date": 400,
  ".tx-swatch__label": 400,
  ".tx-segmented__segment": 400,
  ".tx-scripts-hint code": 400,
};

/**
 * Rules (both sheets, SOURCE ORDER) whose selector contains `key` as a whole token — including
 * its BEM modifiers (`.tx-nav-item--active`): a modifier rule can override the base's weight or
 * family, so it must be collected (step-8 F4). No partial-class match otherwise.
 */
function rulesFor(key: string): Array<{ file: string; selector: string; body: string }> {
  const token = new RegExp(key.replace(/[.\\]/g, "\\$&") + "(?:--[\\w-]+)?(?![\\w-])");
  const out: Array<{ file: string; selector: string; body: string }> = [];
  for (const file of CSS_FILES) {
    for (const rule of read(file).matchAll(RULE)) {
      if (token.test(rule[1])) out.push({ file, selector: rule[1].trim(), body: rule[2] });
    }
  }
  return out;
}

/**
 * The cascade-approximate EFFECTIVE family across `rules` in source order: every family-affecting
 * declaration — `font-family:` longhand AND the `font:` shorthand, which RESETS the family
 * (step-8 F3: `font-family: var(--tx-mono)` followed by `font: inherit` renders sans) — is
 * replayed in declaration order; the last one wins. Returns null when no rule touches family.
 */
function effectiveFamily(rules: Array<{ body: string }>): string | null {
  let family: string | null = null;
  for (const r of rules) {
    for (const m of r.body.matchAll(/(?:^|[;\s])(font-family|font)\s*:\s*([^;]+)/g)) {
      const value = m[2].trim();
      if (m[1] === "font-family") {
        family = value;
      } else {
        // Shorthand: the family is whatever follows the size tokens — for compliance checking we
        // keep the raw value (a keyword like `inherit` is NOT a mono family and must be overridden
        // by a LATER font-family longhand to satisfy a mono role).
        family = value;
      }
    }
  }
  return family;
}

describe("font chokepoint guard (trmx-220)", () => {
  it("names no concrete family outside the two :root definitions and the .tx-badge exemption", () => {
    const offenders: string[] = [];
    for (const d of fontDecls()) {
      if (WIDE_KEYWORDS.has(d.value)) continue;
      if (d.selector === ".tx-badge") continue; // asserted equal to the painted font below
      if (CHOKEPOINT_WITH_FALLBACK.test(d.value)) {
        offenders.push(`${d.file} ${d.selector} — fallback re-embeds a concrete stack: ${d.value}`);
        continue;
      }
      const compliant =
        d.property === "font-family"
          ? CHOKEPOINT.test(d.value)
          : CHOKEPOINT_SHORTHAND.test(d.value);
      if (!compliant) offenders.push(`${d.file} ${d.selector} — ${d.property}: ${d.value}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the .tx-badge overlay on the painted badge font (trmx-149 — mirrors badgeFit)", () => {
    const badge = rulesFor(".tx-badge").filter((r) => r.selector === ".tx-badge");
    expect(badge.length).toBeGreaterThan(0);
    const family = badge
      .map((r) => /font-family\s*:\s*([^;]+)/.exec(r.body)?.[1])
      .find((v) => v !== undefined);
    expect(family?.replace(/\s+/g, " ").trim()).toBe(BADGE_FONT_FAMILY);
  });

  it("declares --tx-ui-font and --tx-mono exactly once, under index.css :root", () => {
    const index = read("src/index.css");
    const settings = read("src/settings/settings.css");
    const rootBodies = [...index.matchAll(RULE)]
      .filter((r) => r[1].trim() === ":root")
      .map((r) => r[2])
      .join("\n");
    const ui = [...index.matchAll(/--tx-ui-font\s*:\s*([^;]+);/g)];
    const mono = [...index.matchAll(/--tx-mono\s*:\s*([^;]+);/g)];
    expect(ui.length).toBe(1);
    expect(mono.length).toBe(1);
    expect(rootBodies).toContain("--tx-ui-font");
    expect(rootBodies).toContain("--tx-mono");
    expect(ui[0][1].trim().startsWith("-apple-system")).toBe(true);
    expect(mono[0][1].trim().startsWith('"SauceCodePro Nerd Font Mono"')).toBe(true);
    // settings.css's :root is the theme fallback table (txCssVars equality guard) — no fonts there.
    expect(/--tx-(ui-font|mono)\s*:/.test(settings)).toBe(false);
  });

  it("pins every mono-role selector to var(--tx-mono) at its expected bundled weight", () => {
    const offenders: string[] = [];
    for (const [key, expected] of Object.entries(MONO_ROLES)) {
      const rules = rulesFor(key);
      // Effective, not first-found: a later `font: inherit` shorthand RESETS an earlier
      // font-family (step-8 F3) — the last family-affecting declaration must be the mono var.
      const family = effectiveFamily(rules);
      if (family !== "var(--tx-mono)") {
        offenders.push(`${key} — effective family is ${family ?? "unset"}, not var(--tx-mono)`);
      }
      const weights = new Set<string>();
      for (const r of rules) {
        for (const m of r.body.matchAll(/font-weight\s*:\s*([^;]+)/g)) weights.add(m[1].trim());
        const shorthand = /(?:^|[;\s])font\s*:\s*([^;]+)/.exec(r.body)?.[1];
        const shWeight = shorthand && /\b([1-9]00|bold|normal)\b/.exec(shorthand)?.[1];
        if (shWeight) weights.add(shWeight);
      }
      const normalized = [...weights].map((w) => (w === "bold" ? "700" : w === "normal" ? "400" : w));
      const bad = normalized.filter((w) => w !== String(expected) && !(expected === 400 && w === "400"));
      if (expected === 700 && !normalized.includes("700")) {
        offenders.push(`${key} — expected an explicit font-weight: 700`);
      }
      if (bad.length > 0) offenders.push(`${key} — off-inventory weights: ${bad.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("computes the effective family through shorthand resets (step-8 F3 regression fixture)", () => {
    // The exact defect class step-8 caught: family declared, then `font: inherit` resets it.
    expect(
      effectiveFamily([{ body: "font-family: var(--tx-mono); font: inherit;" }]),
    ).toBe("inherit");
    // The fix shape: the longhand AFTER the shorthand wins.
    expect(
      effectiveFamily([{ body: "font: inherit; font-family: var(--tx-mono);" }]),
    ).toBe("var(--tx-mono)");
    // A later rule (source order) overrides an earlier shared-rule reset (.tx-number's shape).
    expect(
      effectiveFamily([
        { body: "font: inherit;" },
        { body: "font-family: var(--tx-mono);" },
      ]),
    ).toBe("var(--tx-mono)");
    // A concrete family smuggled before the var in a shorthand is NOT compliant (step-8 F5).
    expect(CHOKEPOINT_SHORTHAND.test("12px Helvetica, var(--tx-ui-font)")).toBe(false);
    expect(CHOKEPOINT_SHORTHAND.test("13px/1.5 var(--tx-ui-font)")).toBe(true);
  });
});
