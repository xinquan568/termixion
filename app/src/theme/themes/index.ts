// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the theme catalog — the single source of truth for Termixion's BUILT-IN themes (vmark's
// post-theme-unification shape, origin/main src/theme/themes/index.ts @ d7e70e3f). Adding a
// built-in: (1) add `./<name>.ts` exporting a `ThemeTokens` value, (2) add it to the `themes`
// map below. `BuiltinThemeId` and `THEME_IDS` are derived from the map, so neither the built-in
// union nor the list can drift from the registered set. trmx-202: display order is DERIVED, not
// declared — `THEME_IDS` sorts the map keys by bg.primary relative luminance (lightest first,
// tie-break ascending id), so a new theme slots into the ramp with zero ordering upkeep;
// declaration order below is cosmetic grouping only. trmx-202 also REMOVED the trmx-53 light
// novelty themes (white/paper/mint/sepia) — their ids live on in `REMOVED_BUILTIN_THEME_IDS` so
// persisted configs mentioning them normalize silently (see defaultTheme.normalizeLegacyThemeId).
//
// trmx-89 (D): `ThemeId` is now the WIDENED, registry-backed `string` — a theme id may be a built-in
// key OR a `user:<stem>` id contributed at runtime by the theme registry (registry.ts). This module
// stays the built-ins' source of truth and MUST NOT import registry.ts (the registry imports the
// built-ins, not the reverse — no import cycle). Runtime validation of an arbitrary id therefore
// moved to registry.ts (`isRegisteredThemeId`); the closed-catalog check lives on here as
// `isBuiltinThemeId` for callers that specifically need "is this one of OUR built-ins".
import { relativeLuminance } from "../contrast";
import type { ThemeTokens } from "../tokens";
import { night } from "./night";
import { solarized } from "./solarized";
import { catppuccinMocha } from "./catppuccin-mocha";
import { catppuccinLatte } from "./catppuccin-latte";
import { dracula } from "./dracula";
import { gruvbox } from "./gruvbox";
import { nord } from "./nord";
import { tokyoNight } from "./tokyo-night";

export const themes = {
  night,
  solarized,
  "catppuccin-mocha": catppuccinMocha,
  "catppuccin-latte": catppuccinLatte,
  dracula,
  gruvbox,
  nord,
  "tokyo-night": tokyoNight,
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

/**
 * The catalog's built-in ids in DISPLAY order (trmx-202): bg.primary relative luminance,
 * lightest -> darkest, tie-break ascending id — computed, never hand-maintained.
 */
export const THEME_IDS = (Object.keys(themes) as BuiltinThemeId[]).sort((a, b) => {
  const d =
    relativeLuminance(themes[b].color.bg.primary) - relativeLuminance(themes[a].color.bg.primary);
  return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
});

/**
 * trmx-202: the four light novelty themes REMOVED from the catalog. They are not junk — a
 * persisted config may still name them — so consumers normalize them silently to the derived
 * default (defaultTheme.normalizeLegacyThemeId) instead of warning like an unknown id.
 */
export const REMOVED_BUILTIN_THEME_IDS = ["white", "paper", "mint", "sepia"] as const;

/** Runtime guard for the removed-built-in set (the silent-normalization special case). */
export function isRemovedBuiltinThemeId(
  value: unknown,
): value is (typeof REMOVED_BUILTIN_THEME_IDS)[number] {
  return (
    typeof value === "string" &&
    (REMOVED_BUILTIN_THEME_IDS as readonly string[]).includes(value)
  );
}

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
 * as before. trmx-201: multi-word ids titleize per hyphen-separated word (`catppuccin-mocha` →
 * "Catppuccin Mocha"; `user:my-solarized` → "My Solarized") — still derived, still no label table.
 * Pure — no registry lookup, so it is safe to call from index-level consumers.
 */
export function themeLabel(id: string): string {
  const stem = id.startsWith("user:") ? id.slice("user:".length) : id;
  if (stem.length === 0) return id;
  return stem
    .split("-")
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}
