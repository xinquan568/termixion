// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the theme catalog — the single source of truth for Termixion's BUILT-IN themes (vmark's
// post-theme-unification shape, origin/main src/theme/themes/index.ts @ d7e70e3f). Adding a
// built-in: (1) add `./<name>.ts` exporting a `ThemeTokens` value, (2) append it to the `themes`
// map below. `BuiltinThemeId` and `THEME_IDS` are derived from the map, so neither the built-in
// union nor the list can drift from the registered set. Declaration order is the issue's display
// order (trmx-53): White, Paper, Mint, Sepia, Night, Solarized.
//
// trmx-89 (D): `ThemeId` is now the WIDENED, registry-backed `string` — a theme id may be a built-in
// key OR a `user:<stem>` id contributed at runtime by the theme registry (registry.ts). This module
// stays the built-ins' source of truth and MUST NOT import registry.ts (the registry imports the
// built-ins, not the reverse — no import cycle). Runtime validation of an arbitrary id therefore
// moved to registry.ts (`isRegisteredThemeId`); the closed-catalog check lives on here as
// `isBuiltinThemeId` for callers that specifically need "is this one of OUR built-ins".
import type { ThemeTokens } from "../tokens";
import { white } from "./white";
import { paper } from "./paper";
import { mint } from "./mint";
import { sepia } from "./sepia";
import { night } from "./night";
import { solarized } from "./solarized";

export const themes = {
  white,
  paper,
  mint,
  sepia,
  night,
  solarized,
} satisfies Record<string, ThemeTokens>;

/** The BUILT-IN theme identifiers — derived from the catalog so the built-in union can never drift. */
export type BuiltinThemeId = keyof typeof themes;

/**
 * A theme identifier. trmx-89 (D): WIDENED from the closed built-in union to a registry-backed
 * `string` — a valid id is either a built-in key or a runtime `user:<stem>` id. Guards resolve the
 * distinction: `isBuiltinThemeId` (below) for the closed catalog, `isRegisteredThemeId` (registry.ts)
 * for "built-in OR a registered user theme".
 */
export type ThemeId = string;

/** The catalog's built-in ids in display order (object insertion order = declaration order above). */
export const THEME_IDS = Object.keys(themes) as BuiltinThemeId[];

/**
 * Runtime guard for the closed BUILT-IN catalog (was `isThemeId` pre-trmx-89). `hasOwnProperty`, not
 * `in`, so prototype keys (`"__proto__"`, `"toString"`, …) can never pass. Callers validating an
 * arbitrary persisted/event value against ALL themes (built-in + user) use the registry's
 * `isRegisteredThemeId` instead.
 */
export function isBuiltinThemeId(value: unknown): value is BuiltinThemeId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(themes, value);
}

/**
 * Display label for a theme id (trmx-53 D6: derived, not a separate table). trmx-89 (D): a
 * `user:<stem>` id titleizes its stem (`user:solarizedish` → "Solarizedish"); a built-in capitalizes
 * as before. Pure — no registry lookup, so it is safe to call from index-level consumers.
 */
export function themeLabel(id: string): string {
  const stem = id.startsWith("user:") ? id.slice("user:".length) : id;
  if (stem.length === 0) return id;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}
