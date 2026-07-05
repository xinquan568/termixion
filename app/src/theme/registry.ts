// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (D): the runtime THEME REGISTRY — the one place that resolves an arbitrary theme id (a
// built-in key OR a `user:<stem>` id) to its `ThemeTokens`, and the guards every consumer validates
// untrusted ids against. It holds a module-level set of the user themes the backend's `themes_read()`
// command surfaced: each valid one is derived (`deriveTheme`) once at registration into full tokens;
// each invalid one is kept as a listed-but-unresolvable entry so the settings UI can show WHY it did
// not load. Built-ins are NEVER shadowable — a user entry whose id collides with a built-in is
// skipped (the `user:` prefix already prevents it; we assert it defensively).
//
// Dependency direction (NO import cycle — the load-bearing constraint): registry.ts imports the
// built-ins (themes/index.ts), the pure derivation (themeDerive.ts), and the pure contrast math
// (contrast.ts). themes/index.ts must NEVER import registry.ts. Consumers (buildXtermTheme, txCssVars,
// applyStartupTheme, themeSettings, the settings store/UI) import their resolution + guards from HERE.
import { contrastRatio, toOpaqueHex } from "./contrast";
import { deriveTheme, type ThemeSpec } from "./themeDerive";
import { themes, THEME_IDS, themeLabel, type BuiltinThemeId } from "./themes";
import type { ThemeTokens } from "./tokens";

/** One diagnostic about a theme: a load-blocking `error` or a non-blocking `warning` (e.g. contrast). */
export interface ThemeDiagnostic {
  severity: "error" | "warning";
  message: string;
  /** The token path the diagnostic is about (e.g. `color.text.primary`), when applicable. */
  path?: string;
}

/** A listable theme, built-in or user — what the (future) theme picker renders one row per. */
export interface ThemeListEntry {
  id: string;
  label: string;
  source: "builtin" | "user";
  /** false for a user theme that failed to parse/derive — listed, but not applyable. */
  valid: boolean;
  diagnostics: ThemeDiagnostic[];
}

/**
 * One warning from the core's `parse_theme` (the shape `themes_read()` returns per user file). Kept
 * as the frontend mirror of that contract; `firstWarningMessage` reads it defensively.
 */
export interface ThemeWarning {
  type: "SyntaxError" | "MissingRequired" | "InvalidColor" | "InvalidValue" | "UnknownKey";
  key?: string;
  message?: string;
  got?: string;
  expected?: string;
}

/**
 * A user theme as delivered by the Tauri `themes_read()` command (`id` = `user:<stem>`, camelCase
 * JSON). `spec` is the parsed `ThemeSpec` when `valid`, else `null`; `warnings` explains an invalid one.
 */
export interface UserThemeEntry {
  id: string;
  source: "user";
  valid: boolean;
  spec: ThemeSpec | null;
  warnings: ThemeWarning[];
}

/** A registered user theme: its derived tokens (absent when invalid) plus its list entry. */
interface StoredUserTheme {
  tokens?: ThemeTokens;
  entry: ThemeListEntry;
}

// Module-level store of the validated user themes. Insertion order is preserved (Map) so listThemes
// renders user themes in the order themes_read() delivered them. A Map (not a plain object) is also
// prototype-pollution-safe: get("__proto__") is a real miss, never the Object prototype.
const userThemes = new Map<string, StoredUserTheme>();

/** `hasOwnProperty`, not `in`: `"__proto__"`/`"toString"` are NOT built-ins even though `in` finds them. */
function isBuiltin(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(themes, id);
}

/** The message for an invalid user theme's error diagnostic — the first warning, read defensively. */
function firstWarningMessage(warnings: ThemeWarning[] | undefined): string {
  const first = Array.isArray(warnings) ? warnings[0] : undefined;
  if (first && typeof first.message === "string" && first.message.length > 0) return first.message;
  if (first?.type) return first.key ? `${first.type}: ${first.key}` : first.type;
  return "the theme file could not be parsed";
}

/**
 * Non-gating legibility check on a DERIVED user theme (contrast.ts). WCAG 2.x AA requires body text
 * ≥ 4.5:1 against its background (docs/design/visual-baseline.md §4 G1); below that we surface a
 * WARNING only — the theme still applies (author's choice), unlike the built-in catalog's hard gate.
 * Alpha-safe AND grammar-safe: both colors are normalized to opaque hex via `toOpaqueHex` (trmx-89
 * review-1 — a user theme may validly use `rgb()`/`rgba()`/8-hex, which the strict contrast primitives
 * throw on), so the ratio is well-defined for every accepted color. The try/catch stays as
 * belt-and-suspenders: a color even `parse_theme` rejected is a data problem, not a gate.
 */
export function validateUserTheme(tokens: ThemeTokens): ThemeDiagnostic[] {
  const WCAG_AA_BODY_TEXT = 4.5;
  const diagnostics: ThemeDiagnostic[] = [];
  try {
    const bg = toOpaqueHex(tokens.color.bg.primary);
    const text = toOpaqueHex(tokens.color.text.primary, bg);
    const ratio = contrastRatio(text, bg);
    if (ratio < WCAG_AA_BODY_TEXT) {
      diagnostics.push({
        severity: "warning",
        message: `low contrast: body text ${ratio.toFixed(
          2,
        )}:1 against the background (WCAG AA needs ${WCAG_AA_BODY_TEXT}:1)`,
        path: "color.text.primary",
      });
    }
  } catch {
    // A non-hex derived color makes the ratio undefined; skip the check (never throw on user data).
  }
  return diagnostics;
}

/**
 * REPLACE the registered user set with `entries` (the full result of one `themes_read()`). For each:
 * a built-in-colliding id is SKIPPED (defensive — the `user:` prefix already prevents it); an invalid
 * or spec-less entry is stored as a listed-but-unresolvable `ThemeListEntry` (valid:false + one error
 * diagnostic, no tokens); a valid entry is derived once into full tokens and stored with its
 * (warning-level) contrast diagnostics.
 */
export function registerUserThemes(entries: UserThemeEntry[]): void {
  // trmx-89 (review-1): snapshot the last-good derived tokens BEFORE clearing. If the ACTIVE user
  // theme is edited to an invalid state, `resolveTheme(id)` must keep serving its previous colors
  // (so a newly-mounted pane or any later re-apply stays on the last-good palette, not the White
  // fallback) — the plan's hot-reload "invalid edit -> previous colors stay". A theme that was never
  // valid this session has no last-good, so it correctly falls back until fixed.
  const lastGood = new Map<string, ThemeTokens>();
  for (const [id, stored] of userThemes) {
    if (stored.tokens) lastGood.set(id, stored.tokens);
  }
  userThemes.clear();
  for (const entry of entries) {
    // Built-ins are never shadowable. The `user:` prefix should make this impossible; assert it.
    if (isBuiltin(entry.id)) continue;

    if (!entry.valid || !entry.spec) {
      userThemes.set(entry.id, {
        // Keep the last-good tokens (if this theme was valid earlier this session) so the active
        // selection stays applyable while the entry is flagged invalid + unselectable in the picker.
        tokens: lastGood.get(entry.id),
        entry: {
          id: entry.id,
          label: themeLabel(entry.id),
          source: "user",
          valid: false,
          diagnostics: [{ severity: "error", message: firstWarningMessage(entry.warnings) }],
        },
      });
      continue;
    }

    const tokens = deriveTheme(entry.spec);
    userThemes.set(entry.id, {
      tokens,
      entry: {
        id: entry.id,
        label: themeLabel(entry.id),
        source: "user",
        valid: true,
        diagnostics: validateUserTheme(tokens),
      },
    });
  }
}

/** The tokens for `id`: the built-in (own-property only) else the registered user tokens, else undefined. */
export function getTheme(id: string): ThemeTokens | undefined {
  if (isBuiltin(id)) return themes[id as BuiltinThemeId];
  return userThemes.get(id)?.tokens;
}

/**
 * Resolve `id` to applyable tokens, falling back to White for any unknown/invalid/junk id (the
 * defense-in-depth White fallback the old `buildXtermTheme` carried). `isBuiltin` uses hasOwnProperty
 * so `"__proto__"` cannot slip through, and the Map miss for an unregistered user id is safe too.
 */
export function resolveTheme(id: string): ThemeTokens {
  return getTheme(id) ?? themes.white;
}

/** True when `id` is a string AND names a built-in OR a registered user theme (valid or not). */
export function isRegisteredThemeId(id: unknown): id is string {
  return typeof id === "string" && (isBuiltin(id) || userThemes.has(id));
}

/**
 * True when `id` is SHAPE-VALID as a user theme id (`user:<stem>`, stem free of `/` and `\`) — even
 * if it is not (yet) registered. trmx-89 C1: a persisted `user:` id must be honored on the pre-scan
 * read (before `themes_read()` populates the registry), so the settings store keeps it rather than
 * coercing it back to a built-in default; `resolveTheme` safely serves White until the scan resolves.
 */
export function isUserThemeIdShape(id: unknown): id is string {
  return typeof id === "string" && /^user:[^/\\]+$/.test(id);
}

/** Every listable theme: the built-ins first (THEME_IDS order), then the registered user themes. */
export function listThemes(): ThemeListEntry[] {
  const builtins: ThemeListEntry[] = THEME_IDS.map((id) => ({
    id,
    label: themeLabel(id),
    source: "builtin",
    valid: true,
    diagnostics: [],
  }));
  const users = [...userThemes.values()].map((stored) => stored.entry);
  return [...builtins, ...users];
}

/** Drop every registered user theme (test hygiene — production replaces the set via registerUserThemes). */
export function clearUserThemes(): void {
  userThemes.clear();
}
